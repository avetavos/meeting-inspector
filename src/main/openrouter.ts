import type { Chunk } from './chunker.ts'
import { SAMPLE_RATE } from './chunker.ts'
import { hasSpeech } from './vad.ts'
import { wavHeader } from './wav.ts'
import type { NoiseFilter } from './settings.ts'
import type { Segment } from './whisper.ts'

/**
 * Transcription through OpenRouter, for machines that cannot hold whisper's 0.8–3.4GB
 * of model plus diarization's ~1GB alongside whatever else is open.
 *
 * This is the one thing in the app that sends anything off the machine, and the whole
 * point of the app is that it does not. Nothing here is on by default and nothing here
 * runs unless the user has both switched engines and provided their own key; the
 * settings panel says in full what leaves and where it goes, and index.ts makes them
 * confirm it once. Keep that contract if this file changes.
 *
 * What actually leaves: the meeting's audio, in ~30-second chunks, as WAV — both the
 * system-audio track and the microphone track — to openrouter.ai, which forwards it to
 * whichever model the user picked. Chunks that the same speech gate whisper uses reads
 * as silence are never sent at all.
 *
 * Deliberately implements the exact surface replay.ts already needs (`ReplayServer`)
 * rather than a parallel pipeline: the chunking, the per-track ordering, the progress
 * reporting, the cancel handling and the "did any chunk fail" accounting are all
 * whisper's, already written and already tested, and none of it is about where the
 * audio is decoded.
 */
export type RemoteOptions = {
  apiKey: string
  model: string
  onSegments: (track: string, segments: Segment[]) => void
  noiseFilter?: () => Promise<NoiseFilter>
}

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions'

/** Asked for as JSON with times, not as prose: without per-line times every chunk would
 * collapse into one ~30-second segment, and diarization (which matches segments to
 * speaker turns by overlap) would hand a whole half-minute to whichever speaker held
 * most of it. `parseSegments` treats anything that does not come back in this shape as
 * a single segment spanning the clip rather than as a failure. */
const PROMPT = (language: string): string =>
  [
    `Transcribe this audio clip verbatim. It is speech in ${language === 'th' ? 'Thai' : 'English'}, possibly with other languages mixed in.`,
    'Reply with ONLY a JSON array, no prose, no code fences:',
    '[{"start": <seconds from the start of THIS clip>, "end": <seconds>, "text": "<what was said>"}]',
    'One entry per sentence or natural pause. Transcribe only what you actually hear —',
    'if the clip contains no speech, reply with [].',
  ].join('\n')

type Job = { track: string; pcm: Int16Array; startSec: number; language: string; signal?: AbortSignal }

/** A WAV file in memory, base64 — OpenRouter takes audio inline only, never by URL. */
export function wavBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  const header = wavHeader(bytes.byteLength, SAMPLE_RATE)
  return Buffer.concat([header, Buffer.from(bytes)]).toString('base64')
}

/**
 * Pulls segments out of whatever the model actually replied with.
 *
 * A model asked for JSON returns JSON most of the time, and something adjacent to it
 * the rest — wrapped in a code fence, with a sentence in front, or as prose that ignored
 * the instruction entirely. The first two are recoverable and worth recovering; the last
 * is still a real transcript of the clip and is kept as one segment spanning it, since
 * throwing away correctly transcribed speech because it arrived in the wrong shape would
 * be the worse failure. `durationSec` bounds the times so a hallucinated `end` of 9000
 * cannot push a segment past the end of the meeting.
 */
export function parseSegments(reply: string, startSec: number, durationSec: number): Segment[] {
  const text = reply.trim()
  const opens = text.indexOf('[')
  const closes = text.lastIndexOf(']')
  const clamp = (n: number): number => Math.min(Math.max(n, 0), durationSec)

  if (opens !== -1 && closes > opens) {
    try {
      const rows = JSON.parse(text.slice(opens, closes + 1)) as unknown
      if (Array.isArray(rows)) {
        const segments = rows
          .filter((r): r is { start: unknown; end: unknown; text: unknown } => typeof r === 'object' && r !== null)
          .map((r) => ({
            t0: startSec + clamp(Number(r.start)),
            t1: startSec + clamp(Number(r.end)),
            text: String(r.text ?? '').trim(),
          }))
          .filter((s) => s.text.length > 0 && Number.isFinite(s.t0) && Number.isFinite(s.t1))
          .map((s) => ({ ...s, t1: Math.max(s.t1, s.t0) }))
        // An empty array is a real answer ("no speech here"), not a parse failure.
        if (segments.length > 0 || rows.length === 0) return segments
      }
    } catch {
      // Falls through to the whole-clip fallback below.
    }
  }

  const spoken = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  return spoken.length > 0 ? [{ t0: startSec, t1: startSec + durationSec, text: spoken }] : []
}

/**
 * Same queue shape as whisper.ts's: one chunk at a time, in order, nothing dropped,
 * failures counted rather than thrown so the caller can tell a lost chunk from its own
 * cancel. Serial rather than parallel on purpose — chunks arrive in track order and the
 * transcript is assembled from their `startSec`, and a burst of parallel requests is
 * also the quickest way to hit a rate limit on someone else's key.
 */
export class Remote {
  private queue: Job[] = []
  private pumping = false
  private failedChunks = 0
  private dead = false

  constructor(private opts: RemoteOptions) {}

  /** Nothing to keep alive — but one authentication or billing failure means every
   * later chunk fails the same way, so the pass stops instead of burning the whole
   * meeting against a key that will not work. */
  get alive(): boolean {
    return !this.dead
  }

  enqueue(track: string, chunk: Chunk, language: string, signal?: AbortSignal): void {
    this.queue.push({ track, ...chunk, language, signal })
    void this.pump()
  }

  takeFailures(): number {
    const n = this.failedChunks
    this.failedChunks = 0
    return n
  }

  async drain(): Promise<void> {
    while (this.pumping || this.queue.length > 0) await new Promise((r) => setTimeout(r, 50))
  }

  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      for (let job = this.queue.shift(); job; job = this.queue.shift()) {
        // The same gate whisper applies, for the same reason plus one more: silence
        // invites a hallucinated line, and here it also costs money to be told about it.
        const level = (await this.opts.noiseFilter?.()) ?? 'medium'
        if (!(await hasSpeech(job.pcm, level))) continue
        try {
          const segments = await this.transcribe(job)
          if (segments.length > 0) this.opts.onSegments(job.track, segments)
        } catch (err) {
          if (!job.signal?.aborted) this.failedChunks++
          console.error(`openrouter: chunk at ${job.startSec}s failed`, err)
        }
      }
    } finally {
      this.pumping = false
    }
  }

  private async transcribe(job: Job): Promise<Segment[]> {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      signal: job.signal,
      headers: {
        authorization: `Bearer ${this.opts.apiKey}`,
        'content-type': 'application/json',
        // OpenRouter attributes requests by these; they are the app, not the user.
        'http-referer': 'https://github.com/avetavos/meeting-inspector',
        'x-title': 'Meeting Inspector',
      },
      body: JSON.stringify({
        model: this.opts.model,
        temperature: 0,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: PROMPT(job.language) },
              { type: 'input_audio', input_audio: { data: wavBase64(job.pcm), format: 'wav' } },
            ],
          },
        ],
      }),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      // A bad key, no credit, or a model that cannot take audio fails identically for
      // every remaining chunk — stop the pass rather than spend the whole meeting
      // finding that out one chunk at a time.
      if (res.status === 401 || res.status === 402 || res.status === 403 || res.status === 404) this.dead = true
      throw new Error(`openrouter ${res.status}: ${body.slice(0, 300)}`)
    }

    const json = (await res.json()) as { choices?: { message?: { content?: unknown } }[] }
    const content = json.choices?.[0]?.message?.content
    const reply = typeof content === 'string' ? content : ''
    return parseSegments(reply, job.startSec, job.pcm.length / SAMPLE_RATE)
  }
}

/**
 * Audio tokens per second of audio, used only to turn a per-token price into the
 * "per hour of meeting" number the settings panel shows.
 *
 * Providers count audio differently and none of them publish a formula per model, so
 * this is Google's rate (the family most of the audio-capable models here belong to)
 * used as one honest, stated assumption rather than a per-model guess. The panel shows
 * the raw per-million-token price alongside it so the estimate can be checked rather
 * than trusted.
 */
export const AUDIO_TOKENS_PER_SEC = 32

export type RemoteModel = {
  id: string
  name: string
  /** USD per hour of audio sent, or null when the model does not price audio separately
   * (it then bills audio as ordinary prompt tokens, which this cannot estimate). */
  usdPerHour: number | null
  /** USD per million audio tokens — the number the estimate above is derived from. */
  usdPerMillionAudio: number | null
  free: boolean
}

export type Connection = { models: RemoteModel[]; usdRemaining: number | null; freeTier: boolean }

type ApiModel = {
  id?: unknown
  name?: unknown
  architecture?: { input_modalities?: unknown }
  pricing?: Record<string, unknown>
}

/**
 * Checks the key and comes back with the models it can actually be used for here —
 * every model on OpenRouter that takes audio in, priced, cheapest first.
 *
 * Two calls rather than one because they answer two different questions: `/key` is what
 * proves the key works (and what it has left), and `/models` is public and would happily
 * succeed with a key that is expired, misspelled, or absent.
 */
export async function connect(apiKey: string, signal?: AbortSignal): Promise<Connection> {
  const auth = { authorization: `Bearer ${apiKey}` }
  const keyRes = await fetch('https://openrouter.ai/api/v1/key', { headers: auth, signal })
  if (!keyRes.ok) {
    throw new Error(keyRes.status === 401 ? 'คีย์ใช้ไม่ได้ — ตรวจสอบว่าคัดลอกมาครบไหม' : `OpenRouter ${keyRes.status}`)
  }
  const key = (await keyRes.json()) as { data?: { limit_remaining?: unknown; is_free_tier?: unknown } }

  const listRes = await fetch('https://openrouter.ai/api/v1/models', { headers: auth, signal })
  if (!listRes.ok) throw new Error(`OpenRouter ${listRes.status}`)
  const list = (await listRes.json()) as { data?: unknown }

  return {
    models: audioModels(Array.isArray(list.data) ? (list.data as ApiModel[]) : []),
    usdRemaining: typeof key.data?.limit_remaining === 'number' ? key.data.limit_remaining : null,
    freeTier: key.data?.is_free_tier === true,
  }
}

/** Exported for its own test: the filtering and the price arithmetic are the parts worth
 * pinning down, and neither needs a network call to check. */
export function audioModels(raw: ApiModel[]): RemoteModel[] {
  const priced = raw
    .filter((m) => typeof m.id === 'string' && typeof m.name === 'string')
    .filter((m) => {
      const modes = m.architecture?.input_modalities
      return Array.isArray(modes) && modes.includes('audio')
    })
    .map((m) => {
      const audio = Number(m.pricing?.['audio'])
      const prompt = Number(m.pricing?.['prompt'])
      // `-1` is how the router's own auto-routing models say "depends which one it
      // picks" — a price this cannot show, for a model whose behaviour it cannot
      // predict either, so it is not offered.
      const usable = Number.isFinite(prompt) && prompt >= 0
      const perToken = Number.isFinite(audio) && audio > 0 ? audio : null
      return {
        id: m.id as string,
        name: m.name as string,
        usdPerMillionAudio: usable && perToken !== null ? perToken * 1e6 : null,
        usdPerHour: usable && perToken !== null ? perToken * AUDIO_TOKENS_PER_SEC * 3600 : null,
        free: usable && (perToken === null ? prompt === 0 : perToken === 0),
        usable,
      }
    })
    .filter((m) => m.usable)
    .map(({ usable: _usable, ...m }) => m)

  // Cheapest first, and anything that does not price audio separately last: those bill
  // it as ordinary prompt tokens at a rate this cannot turn into an hourly figure, so
  // they are offerable but not recommendable.
  return priced.sort((a, b) => (a.usdPerHour ?? Infinity) - (b.usdPerHour ?? Infinity))
}
