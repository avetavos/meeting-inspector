import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { SAMPLE_RATE, type Chunk } from './chunker.js'
import { wavHeader } from './wav.js'

export type Segment = { t0: number; t1: number; text: string }

const BIN = process.env['WHISPER_SERVER'] ?? '/opt/homebrew/bin/whisper-server'
const MODELS = process.env['WHISPER_MODELS'] ?? join(homedir(), 'whisper-models')
const MODEL = join(MODELS, 'ggml-large-v3.bin')
// Silero, run inside whisper-server. Measured on 30s of digital silence:
// without it large-v3 emits "โปรดติดตามตอนต่อไป"; with it, an empty segment list
// in 0.07s. That is spec risk #2 closed by a flag (spec §7.3 wanted our own gate).
const VAD_MODEL = join(MODELS, 'ggml-silero-v5.1.2.bin')

type Job = Chunk & { track: string }

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => (port ? resolve(port) : reject(new Error('no port'))))
    })
  })
}

/**
 * One long-lived whisper-server for the whole session — the 3GB model loads once.
 * Never shell out to whisper-cli per chunk; that reloads the model every time.
 */
export class Whisper {
  private queue: Job[] = []
  private pumping = false

  private constructor(
    private readonly proc: ChildProcess,
    private readonly url: string,
    private readonly onSegments: (track: string, segments: Segment[]) => void,
    private readonly onDepth: (depth: number) => void,
  ) {}

  static async start(
    language: string,
    onSegments: (track: string, segments: Segment[]) => void,
    onDepth: (depth: number) => void,
  ): Promise<Whisper> {
    const port = await freePort()
    const proc = spawn(
      BIN,
      ['-m', MODEL, '--vad', '-vm', VAD_MODEL, '-l', language, '--host', '127.0.0.1', '--port', String(port)],
      { stdio: ['ignore', 'ignore', 'inherit'] },
    )
    const url = `http://127.0.0.1:${port}`
    await waitUntilUp(url, proc)
    return new Whisper(proc, url, onSegments, onDepth)
  }

  get depth(): number {
    return this.queue.length + (this.pumping ? 1 : 0)
  }

  /** FIFO, nothing dropped (spec §7). The server handles one request at a time anyway. */
  enqueue(track: string, chunk: Chunk): void {
    this.queue.push({ track, ...chunk })
    this.onDepth(this.depth)
    void this.pump()
  }

  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      for (let job = this.queue.shift(); job; job = this.queue.shift()) {
        try {
          const segments = await this.transcribe(job)
          if (segments.length > 0) this.onSegments(job.track, segments)
        } catch (err) {
          console.error(`whisper: chunk at ${job.startSec}s failed`, err)
        }
        this.onDepth(this.queue.length)
      }
    } finally {
      this.pumping = false
      this.onDepth(this.queue.length)
    }
  }

  private async transcribe(job: Job): Promise<Segment[]> {
    const body = new FormData()
    body.set('file', new Blob([toWav(job.pcm)], { type: 'audio/wav' }), 'chunk.wav')
    body.set('response_format', 'verbose_json')
    const res = await fetch(`${this.url}/inference`, { method: 'POST', body })
    if (!res.ok) throw new Error(`whisper ${res.status}: ${await res.text()}`)
    const json = (await res.json()) as { segments?: { start: number; end: number; text: string }[] }
    return (json.segments ?? [])
      .map((s) => ({ t0: job.startSec + s.start, t1: job.startSec + s.end, text: s.text.trim() }))
      .filter((s) => s.text.length > 0)
  }

  stop(): void {
    this.queue = []
    this.proc.kill()
  }
}

function toWav(pcm: Int16Array): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  const out = new Uint8Array(new ArrayBuffer(44 + bytes.length))
  out.set(wavHeader(bytes.length, SAMPLE_RATE), 0)
  out.set(bytes, 44)
  return out
}

async function waitUntilUp(url: string, proc: ChildProcess, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`whisper-server exited with ${proc.exitCode}`)
    try {
      await fetch(url, { signal: AbortSignal.timeout(1000) })
      return
    } catch {
      await new Promise((r) => setTimeout(r, 250))
    }
  }
  proc.kill()
  throw new Error(`whisper-server did not come up within ${timeoutMs}ms`)
}
