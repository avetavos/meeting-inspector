import { createHash, randomUUID } from 'node:crypto'
import { open, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { model } from './models.ts'
import { wavHeader } from './wav.ts'
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
 * to someone else's words is worse than an unnamed speaker the user renames. Reused
 * as-is to decide whether two *unnamed* voices are the same person (pending-voice
 * dedup below) — one measure, one threshold, not a second notion of "same voice".
 */
const MATCH_THRESHOLD = 0.6

/** Enough voice to be characteristic, without loading a whole meeting into memory. */
const MAX_SECONDS = 30

/** A preview only needs to be long enough to recognise a voice by ear, not to build a
 * good embedding — capped much shorter than MAX_SECONDS on purpose. */
const PREVIEW_SECONDS = 5

/**
 * `id` is what rename-propagation (Transcript.speakerVoices) resolves by — a name is
 * just this voice's current label, not its identity. Optional on read: `read()` below
 * backfills it for entries written before this field existed, deterministically (a
 * hash of the embedding, not random) so the same legacy voice resolves to the same id
 * on every read without a migration pass rewriting voices.json up front.
 *
 * `name: null` is a voice diarization has clustered but nobody has named yet (spec
 * item 1) — the same file, the same shape, just without the one field that isn't
 * known yet, rather than a second store to keep in sync. An older build's `.map(v =>
 * v.name)` (knownVoices) would show `null` in that list for a pending entry, which is
 * ugly but not a crash — no build has ever written `name: null` before this one, so
 * this is a purely additive, forward-compatible change to the file.
 *
 * `firstHeard` exists only on a pending voice — the one meeting/speaker it takes to
 * answer "who is this?" before it has a name (spec item 2). Dropped once a voice is
 * named (see `remember`/`nameVoice`): nothing downstream needs it after that.
 *
 * `spans` (MEDIUM 6) freezes the exact segment times this voice was tracked from,
 * captured once at trackPending() time — `speaker` alone is not enough to dereference
 * later: shared/meetings.ts's own doc comment on Transcript.speakerVoices says a raw
 * `SPEAKER_00` key means someone different every diarize pass, and `voices:pending`/
 * `voices:sample` (index.ts) used to re-read the meeting's *current* transcript and
 * filter by that key, so after the source meeting was re-diarized they could show the
 * wrong person's lines/audio for this id. A segment's own t0/t1 never changes across a
 * diarize pass (only its `speaker` label does — diarizeMeeting reuses `previous.segments`
 * verbatim into assignSpeakers), so matching by span instead of by key survives that.
 * Optional so a pending entry written before this field existed still degrades to the
 * old (occasionally wrong) key-based lookup rather than showing nothing at all.
 */
type Voice = {
  id: string
  name: string | null
  embedding: number[]
  firstHeard?: { meetingId: string; speaker: string; at: string; spans?: { t0: number; t1: number }[] }
}
type Extractor = {
  dim: number
  createStream(): { acceptWaveform(o: { sampleRate: number; samples: Float32Array }): void; inputFinished(): void }
  isReady(stream: unknown): boolean
  compute(stream: unknown, enableExternalBuffer?: boolean): Float32Array
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

/** Deterministic stand-in id for a voice written before `id` existed — same embedding
 * in, same id out, every read, every session, with nothing written back until this
 * voice is naturally remembered again (see `remember`'s `existing?.id` reuse below). */
const legacyId = (embedding: number[]): string => createHash('sha256').update(JSON.stringify(embedding)).digest('hex').slice(0, 16)

const read = async (): Promise<Voice[]> =>
  readFile(await voicesFile(), 'utf8').then(
    (raw) => (JSON.parse(raw) as (Voice | Omit<Voice, 'id'>)[]).map((v) => ('id' in v ? v : { ...v, id: legacyId(v.embedding) })),
    () => [],
  )

const write = async (voices: Voice[]): Promise<void> =>
  writeFile(await voicesFile(), JSON.stringify(voices, null, 2) + '\n', { mode: 0o600 })

// MEDIUM 5: diarizeMeeting is fire-and-forget (index.ts), so two 'after'-mode meetings
// finishing close together — or a background trackPending() racing meeting:rename's
// remember() — can interleave read()/read()/write()/write() and drop one side's update,
// including a name the user just typed. settings.ts's write-then-rename is atomic
// against a torn file but not against this: two full read-modify-write cycles need to
// be serialized, not just each individual write. ponytail: one global chain serializes
// every voices.json mutation regardless of which voice it touches — a per-voice-id lock
// would let unrelated updates run concurrently, but at this app's single-user scale
// there is nothing to gain from that complexity.
let chain: Promise<unknown> = Promise.resolve()
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.catch(() => {}).then(fn)
  chain = run.catch(() => {})
  return run
}

/**
 * Raw PCM behind one speaker's own lines, capped at `maxSeconds` — shared by
 * samplesFor (the embedding, always MAX_SECONDS) and sampleWav (a short preview).
 *
 * MEDIUM 4: ranged reads, not a whole-file `readFile` — a 3-hour meeting's loopback.wav
 * is ~350MB, and every identify()/trackPending() call in diarizeMeeting's per-speaker
 * loop used to read the whole thing just to pull out a few seconds. Same idiom
 * replay.ts already uses for the same reason.
 *
 * `spans`, if given, overrides the transcript-derived ones (MEDIUM 6) — a pending
 * voice's own frozen span times (voices.ts's `Voice.firstHeard.spans`), so a caller can
 * pull a specific voice's audio without trusting the *current* transcript to still
 * label the right segments with `speaker`.
 */
async function pcmFor(
  dir: string,
  transcript: Transcript,
  speaker: string,
  maxSeconds: number,
  spans?: { t0: number; t1: number }[],
): Promise<Int16Array | null> {
  const use = spans ?? transcript.segments.filter((s) => s.speaker === speaker)
  if (use.length === 0) return null

  // The mic track is us; everyone else is on the loopback track.
  const fh = await open(join(dir, speaker === 'me' ? 'mic.wav' : 'loopback.wav'), 'r').catch(() => null)
  if (!fh) return null
  try {
    const out: number[] = []
    const cap = maxSeconds * 16000
    for (const span of use) {
      if (out.length >= cap) break
      const fromSample = Math.max(0, Math.floor(span.t0 * 16000))
      const wantSamples = Math.min(Math.ceil(span.t1 * 16000) - fromSample, cap - out.length)
      if (wantSamples <= 0) continue
      const buf = Buffer.alloc(wantSamples * 2)
      // wav.ts always writes a 44-byte header before the PCM.
      const { bytesRead } = await fh.read(buf, 0, buf.length, 44 + fromSample * 2).catch(() => ({ bytesRead: 0 }))
      if (bytesRead === 0) continue
      const pcm = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(bytesRead / 2))
      for (let i = 0; i < pcm.length; i++) out.push(pcm[i]!)
    }
    return out.length > 0 ? Int16Array.from(out) : null
  } finally {
    await fh.close()
  }
}

/** Pulls one speaker's own audio out of a meeting, using the times already recorded. */
async function samplesFor(dir: string, transcript: Transcript, speaker: string): Promise<Float32Array | null> {
  const pcm = await pcmFor(dir, transcript, speaker, MAX_SECONDS)
  // Under a couple of seconds an embedding is mostly noise, and a bad one poisons
  // every later match.
  if (!pcm || pcm.length < 2 * 16000) return null
  const out = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i]! / 32768
  return out
}

/** A few seconds of a speaker's own audio, wrapped as a playable WAV — spec item 2,
 * "hear the voice before naming it". Shares wavHeader with wav.ts (the WavWriter used
 * while recording) rather than whisper.ts's toWav, which drags in spawn/whisper-server
 * plumbing this module has nothing to do with. Returns null rather than throwing: a
 * missing/moved meeting folder should read as "no preview", not crash the caller. */
export async function sampleWav(
  dir: string,
  transcript: Transcript,
  speaker: string,
  spans?: { t0: number; t1: number }[],
): Promise<Uint8Array | null> {
  const pcm = await pcmFor(dir, transcript, speaker, PREVIEW_SECONDS, spans)
  if (!pcm) return null
  const header = wavHeader(pcm.byteLength, 16000)
  const out = new Uint8Array(header.length + pcm.byteLength)
  out.set(header, 0)
  out.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), header.length)
  return out
}

async function embed(samples: Float32Array): Promise<Float32Array | null> {
  extractor ??= load()
  const ex = await extractor
  if (!ex) return null
  const stream = ex.createStream()
  stream.acceptWaveform({ sampleRate: 16000, samples })
  stream.inputFinished()
  // sherpa-onnx-node's compute() defaults to a zero-copy "external" buffer for the
  // result — memory owned by the native side, not V8. Electron 38's V8 sandbox
  // rejects handing JS a TypedArray backed by memory it doesn't own ("External
  // buffers are not allowed"), a restriction plain Node does not have, which is why
  // this only ever broke inside the packaged app, never under `node --test`. `false`
  // asks the addon to copy into a normal, V8-owned Float32Array instead.
  return ex.isReady(stream) ? ex.compute(stream, false) : null
}

/** Stores the voice behind a speaker under the name the user just typed, and returns
 * the id it was stored under.
 *
 * Which id: if this speaker was already tied to a voice this diarize pass (named or
 * still pending — Transcript.speakerVoices), reuse that id. That is the whole
 * propagation decision (spec item 3): every other meeting whose speakerVoices already
 * points at that id resolves the new name automatically, at read time, with nothing
 * on disk to rewrite — "the app recognises this speaker, it's the same person".
 * Otherwise fall back to reusing the id of a voice already known by this exact name
 * (a refreshed embedding for the same person, re-remembered under an unchanged name —
 * the one case `remember` could tell was "the same voice" before speakerVoices
 * existed), and failing that mint a fresh id. A fresh id is, by construction, not
 * referenced by any other transcript yet — so the rename naturally stays local to
 * this one, exactly the "diarization split a person into two, don't propagate the
 * mistake" case the spec calls out. */
export async function remember(dir: string, transcript: Transcript, speaker: string, name: string): Promise<string | null> {
  const samples = await samplesFor(dir, transcript, speaker)
  if (!samples) return null
  const embedding = await embed(samples)
  if (!embedding) return null

  // MEDIUM 5: the read-modify-write below, not the embedding work above, is what a
  // concurrent trackPending()/forget() can interleave with and lose an update to.
  return locked(async () => {
    const voices = await read()
    const recognizedId = transcript.speakerVoices?.[speaker]?.voiceId
    const existing = (recognizedId && voices.find((v) => v.id === recognizedId)) || voices.find((v) => v.name === name)
    const id = existing?.id ?? randomUUID()
    const kept = voices.filter((v) => v.id !== id)
    kept.push({ id, name, embedding: [...embedding] })
    await write(kept)
    return id
  })
}

/** The id and current name of a NAMED voice, or null to leave the speaker unnamed.
 * Pending (not-yet-named) voices never match here — trackPending below is the only
 * thing that clusters against those, so a bare speakerNames() placeholder never gets
 * silently overwritten with `null` where a caller expects a real name. */
export async function identify(dir: string, transcript: Transcript, speaker: string): Promise<{ id: string; name: string } | null> {
  const voices = (await read()).filter((v): v is Voice & { name: string } => v.name !== null)
  if (voices.length === 0) return null

  const samples = await samplesFor(dir, transcript, speaker)
  if (!samples) return null
  const embedding = await embed(samples)
  if (!embedding) return null

  let best: { id: string; name: string; score: number } | null = null
  for (const voice of voices) {
    const score = cosine(embedding, voice.embedding)
    if (!best || score > best.score) best = { id: voice.id, name: voice.name, score }
  }
  return best && best.score >= MATCH_THRESHOLD ? { id: best.id, name: best.name } : null
}

/**
 * Clusters a speaker identify() could not name against every other not-yet-named
 * voice, so the same stranger heard in five meetings ends up as ONE pending entry
 * (spec item 1) instead of five — same cosine measure, same MATCH_THRESHOLD identify()
 * uses, no second notion of "same voice". Re-diarizing a meeting re-embeds the same
 * audio and lands back on the same pending id for the same reason, so it does not
 * duplicate either. Returns the (matched or freshly created) pending voice's id, or
 * null if there isn't enough audio to embed at all.
 */
export async function trackPending(dir: string, transcript: Transcript, speaker: string, meetingId: string): Promise<string | null> {
  const samples = await samplesFor(dir, transcript, speaker)
  if (!samples) return null
  const embedding = await embed(samples)
  if (!embedding) return null
  // MEDIUM 6: frozen now, while `speaker` is still known to mean this voice — a
  // segment's own t0/t1 survives a later re-diarize pass even though the raw
  // `speaker` key it's filed under might not (see Voice.firstHeard's own doc comment).
  const spans = transcript.segments.filter((s) => s.speaker === speaker).map((s) => ({ t0: s.t0, t1: s.t1 }))

  return locked(async () => {
    const voices = await read()
    for (const voice of voices) {
      if (voice.name === null && cosine(embedding, voice.embedding) >= MATCH_THRESHOLD) return voice.id
    }

    const id = randomUUID()
    voices.push({ id, name: null, embedding: [...embedding], firstHeard: { meetingId, speaker, at: new Date().toISOString(), spans } })
    await write(voices)
    return id
  })
}

/** Every voice waiting to be named (spec item 1's Settings › Speakers list), oldest
 * first-heard first — the order they started waiting on the user. `spans`, when
 * present, is how a caller should locate this voice's own lines/audio (MEDIUM 6) —
 * dereferencing `speaker` against a meeting's *current* transcript can point at the
 * wrong person if it was re-diarized since this voice was tracked. */
export type PendingVoice = { id: string; meetingId: string; speaker: string; at: string; spans?: { t0: number; t1: number }[] }
export async function pendingVoices(): Promise<PendingVoice[]> {
  return (await read())
    .filter((v): v is Voice & { firstHeard: NonNullable<Voice['firstHeard']> } => v.name === null && v.firstHeard !== undefined)
    .map((v) => ({
      id: v.id,
      meetingId: v.firstHeard.meetingId,
      speaker: v.firstHeard.speaker,
      at: v.firstHeard.at,
      spans: v.firstHeard.spans,
    }))
    .sort((a, b) => a.at.localeCompare(b.at))
}

/** Names a pending voice (or renames any voice by id) directly — the Settings page
 * already has the id from pendingVoices()/renderVoices, so unlike `remember` this
 * does not need to re-derive it from a meeting/speaker pair. A blank name is a no-op
 * rather than clearing the name back to pending. */
export async function nameVoice(id: string, name: string): Promise<void> {
  const trimmed = name.trim()
  if (!trimmed) return
  await locked(async () => {
    const voices = await read()
    const idx = voices.findIndex((v) => v.id === id)
    if (idx === -1) return
    voices[idx] = { id, name: trimmed, embedding: voices[idx]!.embedding }
    await write(voices)
  })
}

/**
 * Resolves what each speaker should currently display as (spec item 3): the live
 * voices.json name for whichever voice this speaker was recognised as at diarize
 * time, falling back to the name recorded on the transcript then (speakerVoices'
 * own `name`) if that voice has since been forgotten, falling back to `speakers`
 * itself for a key speakerVoices never covered (never recognised, or predates this
 * field). Never resolves to null/undefined — a raw key must never reach the screen.
 * Deliberately does not touch disk: called only when handing a transcript to the
 * renderer, never before writeTranscript, so a rename never requires walking and
 * rewriting every transcript that mentions the voice — this is why not.
 *
 * HIGH 3: a voice that still exists but is pending (`name: null`) must never resolve
 * to `rec.name` — that field is only a fallback for a voice that has been forgotten
 * *entirely* (no longer in voices.json at all), per the doc comment on
 * Transcript.speakerVoices. A still-pending voice's `rec.name` can be a name inherited
 * from a completely different person under the same reused speaker key (see
 * diarize.ts's speakerNames), so trusting it here would be the exact bug MATCH_THRESHOLD
 * exists to prevent, reached by a path that never consults it.
 */
export async function resolveSpeakerNames(
  speakers: Record<string, string>,
  speakerVoices?: Record<string, { voiceId: string; name: string }>,
): Promise<Record<string, string>> {
  if (!speakerVoices || Object.keys(speakerVoices).length === 0) return speakers
  const voices = await read()
  const byId = new Map(voices.map((v) => [v.id, v]))
  const resolved = { ...speakers }
  for (const [speaker, rec] of Object.entries(speakerVoices)) {
    const live = byId.get(rec.voiceId)
    resolved[speaker] = (live ? live.name : rec.name) ?? resolved[speaker] ?? speaker
  }
  return resolved
}

/**
 * One entry per PERSON, not per stored embedding. A name is what identity means here —
 * `resolveSpeakerNames` resolves a transcript's voice id to whatever that voice is
 * called today, and `forget` already drops every voice under a name at once — but the
 * same person genuinely does accumulate several embeddings: `remember` mints a fresh id
 * whenever the speaker was tied to a voice this diarize pass (its own doc comment says
 * why), so naming the same person again in a later meeting adds a second exemplar
 * rather than replacing the first. That is good for recognition and terrible to read:
 * Settings › Speakers was listing "บิว" four times with no way to tell the rows apart.
 * `samples` is that count, said out loud instead of shown as repetition.
 */
export type KnownVoice = { name: string; samples: number }
export const knownVoices = async (): Promise<KnownVoice[]> => {
  const counts = new Map<string, number>()
  for (const voice of await read()) {
    if (voice.name !== null) counts.set(voice.name, (counts.get(voice.name) ?? 0) + 1)
  }
  return [...counts]
    .map(([name, samples]) => ({ name, samples }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Renames every voice stored under `from`, and returns how many that was.
 *
 * This is also how two voices get merged, because there is nothing else to merge:
 * giving one person's second entry the name the first already has makes them one
 * person in every place that matters — the Speakers list collapses them into one row,
 * a later rename moves both, forgetting one forgets both, and every transcript
 * pointing at either id already resolves through the name. The embeddings stay as they
 * are, which is the point: two recordings of the same person are two exemplars to
 * match against, not a duplicate to throw away.
 *
 * A typo'd name is the same operation from the other direction — "พี่เพิร์ด" typed once
 * where "พี่เพิร์ช" was meant is a second person until one is renamed onto the other.
 */
export async function renameVoices(from: string, to: string): Promise<number> {
  const trimmed = to.trim()
  if (!trimmed || trimmed === from) return 0
  return locked(async () => {
    const voices = await read()
    const hit = voices.filter((v) => v.name === from)
    if (hit.length === 0) return 0
    for (const voice of hit) voice.name = trimmed
    await write(voices)
    return hit.length
  })
}

/**
 * Drops a voice that is still waiting for a name. Diarization clusters whatever sounds
 * like a person, and sometimes that is a burst of room noise or a line whisper
 * hallucinated out of silence — there is nobody to name, and until now no way to say so:
 * the row sat in Settings › Speakers forever, since only naming it made it go away.
 *
 * Refuses a voice that HAS a name, deliberately: `forget(name)` is that operation, and
 * it drops every recording filed under that name at once, which is a different and much
 * larger thing than throwing away one unidentified cluster.
 */
export async function discardPending(id: string): Promise<boolean> {
  return locked(async () => {
    const voices = await read()
    const kept = voices.filter((v) => !(v.id === id && v.name === null))
    if (kept.length === voices.length) return false
    await write(kept)
    return true
  })
}

export async function forget(name: string): Promise<void> {
  await locked(async () => {
    await write((await read()).filter((v) => v.name !== name))
  })
}

/** Throws rather than returning `NaN` on a dimension mismatch (LOW 12) — a silent NaN
 * compares false against MATCH_THRESHOLD forever, indistinguishable from "no match",
 * which would hide a real bug (an embedding model swap, a corrupt entry) as if it were
 * ordinary "never seen this voice before" behaviour. Every caller already treats a
 * thrown error from the embed/identify/trackPending chain as "no match" via its own
 * `.catch()` (index.ts), so this does not change caller-visible behaviour on the
 * unreachable-in-practice path — it just stops it from failing silently instead. */
function cosine(a: Float32Array, b: number[]): number {
  if (a.length !== b.length) throw new Error(`voices: embedding dimension mismatch (${a.length} vs ${b.length})`)
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
