import { readFile } from 'node:fs/promises'
import { model, requireFiles } from './models.ts'
import type { Transcript } from './store.ts'
import type { SpeakerSplit } from './settings.ts'

export type Turn = { start: number; end: number; speaker: number }

export const UNKNOWN = 'them'

/**
 * Offline diarization over the whole loopback track (spec §8). Offline rather than
 * live because seeing the entire timeline at once groups voices far better than
 * deciding who is speaking with no view of what comes next.
 */
const SEGMENTATION = model('pyannote-segmentation-3-0.onnx')
const EMBEDDING = model('campplus-sv-zh_en.onnx')

/**
 * sherpa's FastClustering `threshold` is a cosine DISTANCE, so a smaller number splits
 * MORE: it is the furthest apart two pieces of speech can sound and still be filed as
 * the same person.
 *
 * The app used to hard-code 0.5 — sherpa's own example value — and on real meeting
 * audio that split one person into dozens. A recording of four people came back with
 * SPEAKER_00 through SPEAKER_45, most of them the same voice arriving at different
 * levels through a conference app. There is no single value that is right for every
 * room (a close mic really does want a fine split, or two similar voices merge into
 * one person and the transcript quietly attributes half of what one said to the
 * other), so this is a setting, defaulted to the middle step rather than to the value
 * that produced that transcript.
 */
export const SPEAKER_SPLIT_THRESHOLD: Record<SpeakerSplit, number> = {
  fine: 0.5,
  balanced: 0.7,
  coarse: 0.85,
}

/**
 * `signal`, if given, is only checked right before the one call below that actually
 * costs anything (MEDIUM 5) — `engine.process()` is a synchronous native call that
 * blocks the whole event loop for the length of the pass, so it cannot be interrupted
 * once started; checking here only skips starting it at all if the caller already gave
 * up first (e.g. it was queued behind another meeting in the batch's diarize pass and
 * cancel landed before its turn came).
 */
/**
 * How to ask sherpa to cluster: by a distance threshold, or into an exact number of
 * people.
 *
 * The threshold ladder above exists entirely because the headcount is unknown — it is a
 * guess at "how different can two clips sound and still be one person", and no value is
 * right for every room. But the headcount is the one thing the person who was in the
 * meeting always knows, and sherpa takes it directly. Given it, the guess is not needed
 * at all: `numClusters: 4` returns four speakers, not the twenty-three a threshold sweep
 * produced from the same audio.
 *
 * `numClusters: -1` is sherpa's "decide for yourself", and is the only case the
 * threshold means anything in — sherpa ignores it once a real count is given, but the
 * addon takes both fields, so the threshold is carried through rather than faked.
 */
export function clusteringFor(threshold: number, speakers?: number | null): { numClusters: number; threshold: number } {
  return { numClusters: speakers && speakers > 0 ? Math.floor(speakers) : -1, threshold }
}

/**
 * How many voices the headcount actually predicts on the track being clustered.
 *
 * Diarization runs over loopback.wav alone — the microphone is a separate track and is
 * `me` by construction (spec §4.1) — and loopback is system output, which does not
 * contain the user's own voice (store.ts's dropEchoedMic says why in full). So "four
 * people were in this meeting" means three voices here, and handing sherpa 4 asks it to
 * find one more person than the audio has.
 *
 * Measured, not assumed: a real four-person meeting whose threshold pass produced 28
 * speakers came back with exactly 3 clusters when asked for 3.
 *
 * A meeting of one is the user alone, with nothing on the loopback track to cluster, so
 * that falls back to letting clustering decide rather than asking for zero speakers.
 *
 * The ceiling: this assumes the user is one of the people they counted, which is true of
 * a meeting they are in and not of a webinar they are only watching — there, everyone is
 * on loopback and this asks for one too few. Recoverable by typing one higher, which is
 * why the field is a number the user can adjust rather than a fact derived from anything.
 */
export const loopbackSpeakers = (headcount?: number | null): number | null =>
  headcount && headcount > 1 ? Math.floor(headcount) - 1 : null

export async function diarize(
  wavPath: string,
  signal?: AbortSignal,
  threshold: number = SPEAKER_SPLIT_THRESHOLD.balanced,
  speakers?: number | null,
): Promise<Turn[]> {
  await requireFiles([SEGMENTATION, EMBEDDING], 'use the download button in the app')
  // Required late: this pulls in a ~30MB native addon nobody needs until a meeting ends.
  // It is CommonJS, so depending on who does the loading the class arrives either as a
  // named export or hidden under `default`.
  const sherpa = await import('sherpa-onnx-node')
  const OfflineSpeakerDiarization = sherpa.OfflineSpeakerDiarization ?? sherpa.default.OfflineSpeakerDiarization
  const engine = new OfflineSpeakerDiarization({
    segmentation: { pyannote: { model: SEGMENTATION } },
    embedding: { model: EMBEDDING },
    // The headcount if the user has told us one, otherwise clustering decides for
    // itself (spec §8) at the distance the user's own recordings turned out to need.
    clustering: clusteringFor(threshold, speakers),
  })

  const wav = await readFile(wavPath)
  const pcm = new Int16Array(wav.buffer, wav.byteOffset + 44, (wav.length - 44) / 2)
  const samples = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i]! / 32768
  if (signal?.aborted) throw new Error('cancelled')
  return engine.process(samples) as Turn[]
}

export const speakerLabel = (n: number): string => `SPEAKER_${String(n).padStart(2, '0')}`

/**
 * Gives every loopback segment the speaker it overlaps most (spec §8.2). The mic track
 * is left alone — it is us by construction, whatever the loopback turns say. A segment
 * overlapping nothing falls back to `them`: better unattributed than wrong.
 *
 * The skip is 'me' and only 'me'. It used to be "anything not already `them`", which is
 * the same thing on a FIRST pass — before diarization every segment is either 'me' or
 * 'them' — and silently a no-op on a second one: after a pass the loopback segments
 * carry `SPEAKER_xx`, so re-running diarization returned every one of them unchanged and
 * the new clustering was thrown away. Found by re-splitting an already-split meeting
 * with a known headcount (index.ts's meeting:rediarize) and watching the speaker keys
 * come back identical.
 */
export function assignSpeakers(
  segments: Transcript['segments'],
  turns: Turn[],
  /** What to call the turn a segment landed on. Defaults to the clustering's own
   * `SPEAKER_xx`; a re-split that has the user's corrected spans to compare against
   * passes one that can answer with a person's key instead (index.ts), so the overlap
   * arithmetic below stays the only copy of itself. */
  label: (turn: Turn) => string = (turn) => speakerLabel(turn.speaker),
): Transcript['segments'] {
  return segments.map((segment) => {
    if (segment.speaker === 'me') return segment
    let best: Turn | null = null
    let bestOverlap = 0
    for (const turn of turns) {
      const overlap = Math.min(segment.t1, turn.end) - Math.max(segment.t0, turn.start)
      // Strictly greater, so an exact tie keeps the earlier turn rather than flip-flopping.
      if (overlap > bestOverlap) {
        bestOverlap = overlap
        best = turn
      }
    }
    // Back to the unattributed bucket rather than keeping a label from a previous
    // clustering: the old key means someone else entirely after a re-split (see
    // Transcript.speakerVoices' own doc comment), so carrying it over would be worse
    // than saying nothing.
    return best ? { ...segment, speaker: label(best) } : { ...segment, speaker: UNKNOWN }
  })
}

/**
 * Which of the user's corrected people a turn sounds like, or null to leave the
 * clustering's own answer alone.
 *
 * Two guards, both because a confident wrong name is worse than an honest placeholder.
 * `threshold` is the floor — sound enough like this person at all. `margin` is the one
 * that matters here: the whole reason corrections exist is that two voices were close
 * enough for clustering to merge them, so a turn that is nearly equidistant between them
 * is exactly the case where guessing goes wrong, and it keeps its cluster label instead.
 */
export function pickExemplar(
  scores: { name: string; score: number }[],
  threshold: number,
  margin = 0.05,
): string | null {
  const ranked = [...scores].sort((a, b) => b.score - a.score)
  const best = ranked[0]
  if (!best || best.score < threshold) return null
  const runnerUp = ranked.find((s) => s.name !== best.name)
  if (runnerUp && best.score - runnerUp.score < margin) return null
  return best.name
}

/** A speaker key for someone the user named by correcting a line, kept apart from
 * clustering's own `SPEAKER_xx` so nothing downstream mistakes one for the other. */
export const personLabel = (n: number): string => `PERSON_${String(n).padStart(2, '0')}`



/** The lowest `PERSON_xx` this meeting is not already using. Its own series, kept apart
 * from clustering's `SPEAKER_xx` so nothing mistakes a person the user named for a
 * cluster the app guessed at. */
export function freePersonKey(speakers: Record<string, string>): string {
  for (let n = 0; ; n++) {
    const key = personLabel(n)
    if (!(key in speakers)) return key
  }
}



/**
 * The corrected lines themselves, applied last and unconditionally.
 *
 * Matching a turn to a corrected voice is inference — "this turn sounds like บิว". These
 * spans are not: the user listened and said so, and nothing computed afterwards may
 * overrule them. Matched by exact `t0`/`t1`, which is what a hint is frozen by and what
 * survives a re-diarize verbatim (Transcript.speakerHints' own doc comment), so a
 * correction is never undone by the very pass it was made to correct.
 *
 * `keyOf` returns undefined for a hinted name no key was minted for, which leaves that
 * segment exactly as the clustering left it rather than filing it under `undefined`.
 */
export function applyHints(
  segments: Transcript['segments'],
  hints: NonNullable<Transcript['speakerHints']>,
  keyOf: (name: string) => string | undefined,
): Transcript['segments'] {
  if (hints.length === 0) return segments
  return segments.map((segment) => {
    const hint = hints.find((h) => h.t0 === segment.t0 && h.t1 === segment.t1)
    const key = hint && keyOf(hint.name)
    return key ? { ...segment, speaker: key } : segment
  })
}

/**
 * Folds speakers who barely spoke back into the unattributed bucket.
 *
 * Diarization runs over the whole loopback WAV with no speech gate in front of it —
 * unlike whisper, whose chunks pass VAD first — so a cough, a chair, a notification
 * chime gets clustered as its own SPEAKER_NN. Each one then surfaces as a "ผู้พูด 13"
 * row the user is asked to name, and there is nobody to name. Anyone whose lines total
 * under `minSec` across the WHOLE meeting goes back to `them` ("คนอื่น") instead of
 * becoming a numbered person.
 *
 * 2 seconds is the same floor voices.ts uses for "not enough audio to learn a voice
 * from", for the same reason: below it there is no identity to work with. The trade is
 * stated rather than hidden — a real person whose only contribution was one word gets
 * folded too, and their word is still in the transcript, attributed to "others".
 */
export const MIN_SPEAKER_SEC = 2

export function foldBriefSpeakers(
  segments: Transcript['segments'],
  minSec: number = MIN_SPEAKER_SEC,
): Transcript['segments'] {
  const total = new Map<string, number>()
  for (const s of segments) {
    if (s.speaker === 'me' || s.speaker === UNKNOWN) continue
    total.set(s.speaker, (total.get(s.speaker) ?? 0) + (s.t1 - s.t0))
  }
  const brief = new Set([...total].filter(([, sec]) => sec < minSec).map(([speaker]) => speaker))
  if (brief.size === 0) return segments
  return segments.map((s) => (brief.has(s.speaker) ? { ...s, speaker: UNKNOWN } : s))
}

/** What an unnamed speaker is called, in whichever language the UI is set to. */
export type SpeakerLabels = { me: string; them: string; speaker: (n: number) => string }

/**
 * Keeps names the user already typed; new speakers get a placeholder worth replacing.
 *
 * HIGH 3: `existing[speaker]` is only trustworthy when nothing tied that raw key to a
 * specific voice last pass. Diarization reclusters from scratch every run, so
 * `SPEAKER_00` can mean a different person this time — Transcript.speakerVoices' own
 * doc comment says exactly this, and MATCH_THRESHOLD (voices.ts) exists so identify()
 * gets the final word on "is this the same voice", not a blind key match. A key
 * `previousSpeakerVoices` ties to a voice is about to be re-checked by identify()
 * right after this call (diarizeMeeting, index.ts) — trusting its old name here, before
 * that check runs, would let a stale name survive identify() disagreeing with it a
 * moment later. A key with no such entry (a name typed by hand with no voice tracking,
 * or one identify() has never touched) has nothing this pass can confirm or refute, so
 * it keeps the old behaviour.
 */
export function speakerNames(
  segments: Transcript['segments'],
  existing: Record<string, string>,
  labels: SpeakerLabels,
  previousSpeakerVoices?: Record<string, unknown>,
): Record<string, string> {
  const names: Record<string, string> = { me: existing['me'] ?? labels.me }
  let n = 0
  for (const { speaker } of segments) {
    if (speaker === 'me' || names[speaker]) continue
    const trusted = previousSpeakerVoices?.[speaker] === undefined ? existing[speaker] : undefined
    names[speaker] = trusted ?? (speaker === UNKNOWN ? labels.them : labels.speaker(++n))
  }
  return names
}
