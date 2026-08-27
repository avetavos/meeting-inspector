import { mkdir, open, rename, stat } from 'node:fs/promises'
import { MODELS_DIR, model } from './models.ts'

export type ModelSpec = { file: string; url: string; bytes: number }
export type ModelStatus = ModelSpec & { present: boolean; resumeFrom: number }
export type Progress = { file: string; received: number; total: number }

/**
 * Downloaded on first run rather than shipped in the installer (spec §12) — three
 * gigabytes of it. Sizes are for the progress bar; the real total comes from the
 * response, so a republished file does not break the download.
 */
export const MODELS: ModelSpec[] = [
  {
    file: 'ggml-large-v3.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin',
    bytes: 3_095_033_483,
  },
  {
    file: 'ggml-silero-v5.1.2.bin',
    url: 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin',
    bytes: 885_098,
  },
  {
    file: 'silero_vad.onnx',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
    bytes: 643_854,
  },
  {
    file: 'pyannote-segmentation-3-0.onnx',
    url: 'https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/main/model.onnx',
    bytes: 5_992_913,
  },
  {
    file: 'campplus-sv-zh_en.onnx',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx',
    bytes: 28_281_164,
  },
]

const sizeOf = async (path: string): Promise<number> => stat(path).then((s) => s.size, () => 0)

export async function modelStatus(): Promise<ModelStatus[]> {
  return Promise.all(
    MODELS.map(async (spec) => ({
      ...spec,
      present: (await sizeOf(model(spec.file))) > 0,
      // A half-finished file is kept as .part, so an interrupted download picks up
      // where it stopped instead of starting three gigabytes over.
      resumeFrom: await sizeOf(`${model(spec.file)}.part`),
    })),
  )
}

export async function downloadModel(
  spec: ModelSpec,
  onProgress: (progress: Progress) => void,
  signal: AbortSignal,
): Promise<void> {
  await mkdir(MODELS_DIR, { recursive: true })
  const target = model(spec.file)
  const part = `${target}.part`

  let received = await sizeOf(part)
  const res = await fetch(spec.url, {
    signal,
    headers: received > 0 ? { range: `bytes=${received}-` } : {},
  })
  if (!res.ok || !res.body) throw new Error(`${spec.file}: ${res.status} ${res.statusText}`)
  if (res.status !== 206) received = 0 // server ignored the range — start over

  const total = received + Number(res.headers.get('content-length') ?? spec.bytes)
  const handle = await open(part, received > 0 ? 'a' : 'w')
  let announced = 0
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      await handle.write(chunk)
      received += chunk.length
      // A 3GB file is millions of chunks; the UI only needs a few updates a second.
      if (received - announced > 4_000_000 || received === total) {
        announced = received
        onProgress({ file: spec.file, received, total })
      }
    }
  } finally {
    await handle.close()
  }

  // Guards the rename: a short file must never end up looking like a complete one.
  // The .part it leaves behind is a valid prefix, so the next attempt resumes from it.
  if (received !== total) throw new Error(`${spec.file}: got ${received} bytes of ${total}`)
  await rename(part, target)
  onProgress({ file: spec.file, received, total })
}
