import { readFile } from 'node:fs/promises'
import { model, requireFiles } from './models.ts'
import type { Transcript } from './store.ts'

export type Turn = { start: number; end: number; speaker: number }

export const UNKNOWN = 'them'

/**
 * Offline diarization over the whole loopback track (spec §8). Offline rather than
 * live because seeing the entire timeline at once groups voices far better than
 * deciding who is speaking with no view of what comes next.
 */
const SEGMENTATION = model('pyannote-segmentation-3-0.onnx')
const EMBEDDING = model('campplus-sv-zh_en.onnx')

export async function diarize(wavPath: string): Promise<Turn[]> {
  await requireFiles([SEGMENTATION, EMBEDDING], 'กดปุ่มโหลดโมเดลในแอป')
  // Required late: this pulls in a ~30MB native addon nobody needs until a meeting ends.
  // It is CommonJS, so depending on who does the loading the class arrives either as a
  // named export or hidden under `default`.
  const sherpa = await import('sherpa-onnx-node')
  const OfflineSpeakerDiarization = sherpa.OfflineSpeakerDiarization ?? sherpa.default.OfflineSpeakerDiarization
  const engine = new OfflineSpeakerDiarization({
    segmentation: { pyannote: { model: SEGMENTATION } },
    embedding: { model: EMBEDDING },
    // Let clustering decide how many people were in the room (spec §8).
    clustering: { numClusters: -1, threshold: 0.5 },
  })

  const wav = await readFile(wavPath)
  const pcm = new Int16Array(wav.buffer, wav.byteOffset + 44, (wav.length - 44) / 2)
  const samples = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i]! / 32768
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

/** Keeps names the user already typed; new speakers get a placeholder worth replacing. */
export function speakerNames(
  segments: Transcript['segments'],
  existing: Record<string, string>,
): Record<string, string> {
  const names: Record<string, string> = { me: existing['me'] ?? 'คุณ' }
  let n = 0
  for (const { speaker } of segments) {
    if (speaker === 'me' || names[speaker]) continue
    names[speaker] = existing[speaker] ?? (speaker === UNKNOWN ? 'คนอื่น' : `ผู้พูด ${++n}`)
  }
  return names
}
