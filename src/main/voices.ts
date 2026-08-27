import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { model } from './models.ts'
import type { Transcript } from '../shared/meetings.ts'

/**
 * Recognises a voice across meetings, so a name typed once is not typed again.
 *
 * The embedding model is the one diarization already uses (CAM++). Until now its
 * output was computed, clustered within a single meeting, and thrown away — which is
 * why SPEAKER_00 today had nothing to do with SPEAKER_00 last week. Keeping the
 * embedding next to the name the user typed is the whole feature.
 */
const EMBEDDING_MODEL = model('campplus-sv-zh_en.onnx')
/** Electron is imported lazily so this module can be exercised outside the app. */
async function voicesFile(): Promise<string> {
  const override = process.env['VOICES_FILE']
  if (override) return override
  const { app } = await import('electron')
  return join(app.getPath('userData'), 'voices.json')
}

/**
 * Cosine similarity on CAM++. Deliberately cautious: a wrong name silently attached
 * to someone else's words is worse than an unnamed speaker the user renames.
 */
const MATCH_THRESHOLD = 0.6

/** Enough voice to be characteristic, without loading a whole meeting into memory. */
const MAX_SECONDS = 30

type Voice = { name: string; embedding: number[] }
type Extractor = {
  dim: number
  createStream(): { acceptWaveform(o: { sampleRate: number; samples: Float32Array }): void; inputFinished(): void }
  isReady(stream: unknown): boolean
  compute(stream: unknown): Float32Array
}

let extractor: Promise<Extractor | null> | null = null

async function load(): Promise<Extractor | null> {
  try {
    const sherpa = await import('sherpa-onnx-node')
    const Extractor = sherpa.SpeakerEmbeddingExtractor ?? sherpa.default.SpeakerEmbeddingExtractor
    return new Extractor({ model: EMBEDDING_MODEL, numThreads: 1 }) as Extractor
  } catch (err) {
    console.error('voices: speaker recognition unavailable —', err)
    return null
  }
}

const read = async (): Promise<Voice[]> =>
  readFile(await voicesFile(), 'utf8').then(
    (raw) => JSON.parse(raw) as Voice[],
    () => [],
  )

const write = async (voices: Voice[]): Promise<void> =>
  writeFile(await voicesFile(), JSON.stringify(voices, null, 2) + '\n', { mode: 0o600 })

/** Pulls one speaker's own audio out of a meeting, using the times already recorded. */
async function samplesFor(dir: string, transcript: Transcript, speaker: string): Promise<Float32Array | null> {
  const spans = transcript.segments.filter((s) => s.speaker === speaker)
  if (spans.length === 0) return null

  // The mic track is us; everyone else is on the loopback track.
  const wav = await readFile(join(dir, speaker === 'me' ? 'mic.wav' : 'loopback.wav')).catch(() => null)
  if (!wav) return null
  const pcm = new Int16Array(wav.buffer, wav.byteOffset + 44, (wav.length - 44) / 2)

  const out: number[] = []
  for (const span of spans) {
    const from = Math.max(0, Math.floor(span.t0 * 16000))
    const to = Math.min(pcm.length, Math.ceil(span.t1 * 16000))
    for (let i = from; i < to && out.length < MAX_SECONDS * 16000; i++) out.push(pcm[i]! / 32768)
    if (out.length >= MAX_SECONDS * 16000) break
  }
  // Under a couple of seconds an embedding is mostly noise, and a bad one poisons
  // every later match.
  return out.length >= 2 * 16000 ? Float32Array.from(out) : null
}

async function embed(samples: Float32Array): Promise<Float32Array | null> {
  extractor ??= load()
  const ex = await extractor
  if (!ex) return null
  const stream = ex.createStream()
  stream.acceptWaveform({ sampleRate: 16000, samples })
  stream.inputFinished()
  return ex.isReady(stream) ? ex.compute(stream) : null
}

/** Stores the voice behind a speaker under the name the user just typed. */
export async function remember(dir: string, transcript: Transcript, speaker: string, name: string): Promise<void> {
  const samples = await samplesFor(dir, transcript, speaker)
  if (!samples) return
  const embedding = await embed(samples)
  if (!embedding) return

  const voices = (await read()).filter((v) => v.name !== name)
  voices.push({ name, embedding: [...embedding] })
  await write(voices)
}

/** The name of a voice already known, or null to leave the speaker unnamed. */
export async function identify(dir: string, transcript: Transcript, speaker: string): Promise<string | null> {
  const voices = await read()
  if (voices.length === 0) return null

  const samples = await samplesFor(dir, transcript, speaker)
  if (!samples) return null
  const embedding = await embed(samples)
  if (!embedding) return null

  let best: { name: string; score: number } | null = null
  for (const voice of voices) {
    const score = cosine(embedding, voice.embedding)
    if (!best || score > best.score) best = { name: voice.name, score }
  }
  return best && best.score >= MATCH_THRESHOLD ? best.name : null
}

export const knownVoices = async (): Promise<string[]> => (await read()).map((v) => v.name)

export async function forget(name: string): Promise<void> {
  await write((await read()).filter((v) => v.name !== name))
}

function cosine(a: Float32Array, b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1)
}
