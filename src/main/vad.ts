import { hasSignal } from './chunker.ts'
import { model } from './models.ts'

/**
 * Decides whether a chunk contains speech before it is sent for transcription
 * (spec §7.3).
 *
 * A peak threshold was not enough. It catches the loopback track, which is exactly
 * zero when nothing is playing, but a real microphone in a quiet room sits far above
 * any sane floor — measured room tone peaks around 800 of 32768. Sending that on:
 *
 *   - makes large-v3 invent something. "the end" and "สวัสดีครับ" are the usual
 *     ones; the model has seen a lot of video endings.
 *   - kills whisper-server outright when its own VAD finds nothing and the request
 *     asked for verbose_json, taking the rest of the meeting's chunks with it until
 *     the supervisor notices.
 *
 * Silero through sherpa-onnx, which is already bundled for diarization, answers this
 * properly: 4 speech segments in read speech, 0 in room tone, 0 in digital silence,
 * in under 60ms for a 25s chunk.
 */
const MODEL = model('silero_vad.onnx')
const WINDOW = 512

type Detector = { acceptWaveform(s: Float32Array): void; isEmpty(): boolean; pop(): void; reset(): void; flush(): void }

let detector: Promise<Detector | null> | null = null

async function load(): Promise<Detector | null> {
  try {
    const sherpa = await import('sherpa-onnx-node')
    const Vad = sherpa.Vad ?? sherpa.default.Vad
    return new Vad(
      {
        sileroVad: { model: MODEL, threshold: 0.5, minSilenceDuration: 0.25, minSpeechDuration: 0.25, maxSpeechDuration: 20 },
        sampleRate: 16000,
        numThreads: 1,
      },
      60,
    ) as Detector
  } catch (err) {
    // Missing model, or an addon that will not load. Fall back rather than block
    // every chunk of the meeting.
    console.error('vad: falling back to the energy gate —', err)
    return null
  }
}

export async function hasSpeech(pcm: Int16Array): Promise<boolean> {
  // Free, and settles the loopback track without waking the model at all.
  if (!hasSignal(pcm)) return false

  detector ??= load()
  const vad = await detector
  if (!vad) return true // no detector: better a hallucinated line than a lost one

  const samples = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i]! / 32768

  vad.reset()
  let speech = false
  for (let i = 0; i + WINDOW <= samples.length; i += WINDOW) {
    vad.acceptWaveform(samples.subarray(i, i + WINDOW))
    while (!vad.isEmpty()) {
      speech = true
      vad.pop()
    }
  }
  vad.flush()
  while (!vad.isEmpty()) {
    speech = true
    vad.pop()
  }
  return speech
}
