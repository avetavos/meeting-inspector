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
export async function diarize(
  wavPath: string,
  signal?: AbortSignal,
  threshold: number = SPEAKER_SPLIT_THRESHOLD.balanced,
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
    // Let clustering decide how many people were in the room (spec §8), at the
    // distance the user's own recordings turned out to need (see the constant above).
    clustering: { numClusters: -1, threshold },
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
 * Gives every not-yet-attributed segment the speaker it overlaps most (spec §8.2).
 * Segments already labelled — the mic track, which is us by construction — are left
 * alone. A segment overlapping nothing keeps `them`: better unattributed than wrong.
 */
export function assignSpeakers(
  segments: Transcript['segments'],
  turns: Turn[],
): Transcript['segments'] {
  return segments.map((segment) => {
    if (segment.speaker !== UNKNOWN) return segment
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
    return best ? { ...segment, speaker: speakerLabel(best.speaker) } : segment
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
