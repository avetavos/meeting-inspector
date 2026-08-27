import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { SAMPLE_RATE, type Chunk } from './chunker.ts'
import { model, requireFiles } from './models.ts'
import { hasSpeech } from './vad.ts'
import { wavHeader } from './wav.ts'

export type Segment = { t0: number; t1: number; text: string }

/**
 * Prefer the copy we build and ship (build/build-whisper.mjs) so an installed .dmg
 * needs nothing else; fall back to Homebrew's so a checkout without a build still
 * runs. `process.resourcesPath` only exists under Electron, hence the guard.
 */
const BIN =
  process.env['WHISPER_SERVER'] ??
  [
    process.resourcesPath ? join(process.resourcesPath, 'whisper', 'whisper-server') : '',
    join(process.cwd(), 'resources', 'whisper', 'whisper-server'),
  ].find((path) => path && existsSync(path)) ??
  '/opt/homebrew/bin/whisper-server'
const MODEL = model('ggml-large-v3.bin')
// Silero, run inside whisper-server. Measured on 30s of digital silence:
// without it large-v3 emits "โปรดติดตามตอนต่อไป"; with it, an empty segment list
// in 0.07s. That is spec risk #2 closed by a flag (spec §7.3 wanted our own gate).
const VAD_MODEL = model('ggml-silero-v5.1.2.bin')

type Job = Chunk & { track: string }

/**
 * Seed vocabulary for the decoder. Measured on 125s of read Thai dev-meeting speech
 * (spike/asr-accuracy): term recall 21/27 -> 26/27, CER 15.1% -> 11.4%. Without it
 * large-v3 hears Thai words that sound alike — log became หลอก, refactor became
 * Refractor. Edit this when the team's jargon changes; it is the cheapest lever here.
 */
export const DEFAULT_PROMPT = [
  'deploy', 'rollback', 'staging', 'production', 'backend', 'frontend',
  'pull request', 'code review', 'merge', 'rebase', 'branch', 'commit',
  'migration', 'endpoint', 'API', 'schema', 'query', 'index', 'cache',
  'Redis', 'PostgreSQL', 'MongoDB', 'Docker', 'Kubernetes', 'pipeline',
  'timeout', 'retry', 'log', 'monitoring', 'alert', 'error rate',
  'sprint', 'backlog', 'story point', 'standup', 'refactor', 'unit test',
].join(', ')

export type WhisperOptions = {
  language: string
  /** Initial prompt: vocabulary to bias decoding toward (spec §13 risk #3). */
  prompt?: string
  onSegments: (track: string, segments: Segment[]) => void
  onDepth: (depth: number) => void
}

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
    private readonly opts: WhisperOptions,
  ) {}

  static async start(opts: WhisperOptions): Promise<Whisper> {
    const { language } = opts
    await requireFiles([BIN], 'run `npm run build:whisper` or `brew install whisper-cpp`')
    await requireFiles([MODEL, VAD_MODEL], 'use the download button in the app')
    const port = await freePort()
    const proc = spawn(
      BIN,
      ['-m', MODEL, '--vad', '-vm', VAD_MODEL, '-l', language, '--host', '127.0.0.1', '--port', String(port)],
      { stdio: ['ignore', 'ignore', 'inherit'] },
    )
    // Without a listener an ENOENT surfaces as an unhandled 'error' event and takes
    // the whole main process down. It arrives after spawn returns, so the wait loop
    // watches for it rather than checking once.
    let spawnError: Error | null = null
    proc.once('error', (err) => {
      spawnError = err
    })

    const url = `http://127.0.0.1:${port}`
    await waitUntilUp(url, proc, () => spawnError)
    return new Whisper(proc, url, opts)
  }

  /** False once the child has exited — every later chunk would fail in silence. */
  get alive(): boolean {
    return this.proc.exitCode === null && !this.proc.killed
  }

  get depth(): number {
    return this.queue.length + (this.pumping ? 1 : 0)
  }

  /** FIFO, nothing dropped (spec §7). The server handles one request at a time anyway. */
  enqueue(track: string, chunk: Chunk): void {
    this.queue.push({ track, ...chunk })
    this.opts.onDepth(this.depth)
    void this.pump()
  }

  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      for (let job = this.queue.shift(); job; job = this.queue.shift()) {
        // Silence has nothing to transcribe, invites a hallucination, and can take
        // the server down with it (spec §7.3).
        if (!(await hasSpeech(job.pcm))) {
          this.opts.onDepth(this.queue.length)
          continue
        }
        try {
          const segments = await this.transcribe(job)
          if (segments.length > 0) this.opts.onSegments(job.track, segments)
        } catch (err) {
          console.error(`whisper: chunk at ${job.startSec}s failed`, err)
        }
        this.opts.onDepth(this.queue.length)
      }
    } finally {
      this.pumping = false
      this.opts.onDepth(this.queue.length)
    }
  }

  private async transcribe(job: Job): Promise<Segment[]> {
    const body = new FormData()
    body.set('file', new Blob([toWav(job.pcm)], { type: 'audio/wav' }), 'chunk.wav')
    body.set('response_format', 'verbose_json')
    // whisper-server caps a segment at 60 characters and chops mid-word to do it —
    // and `max_len=0` does not mean "no cap", it means "use 60" (server.cpp:933), so
    // the cap has to be raised out of the way instead of switched off. Segments are
    // already bounded by the chunk length; this just lets a sentence stay whole.
    body.set('max_len', '100000')
    // Whisper conditions on this as if it were the text just before the chunk, which
    // is how a team's own jargon gets a chance against a phonetically similar word.
    if (this.opts.prompt) body.set('prompt', this.opts.prompt)
    const res = await fetch(`${this.url}/inference`, { method: 'POST', body })
    if (!res.ok) throw new Error(`whisper ${res.status}: ${await res.text()}`)
    const json = (await res.json()) as { segments?: { start: number; end: number; text: string }[] }
    return (json.segments ?? [])
      .map((s) => ({ t0: job.startSec + s.start, t1: job.startSec + s.end, text: s.text.trim() }))
      .filter((s) => s.text.length > 0)
  }

  /** Resolves once every queued chunk has come back — a meeting's tail is 1-2 chunks. */
  async drain(): Promise<void> {
    while (this.depth > 0) await new Promise((r) => setTimeout(r, 200))
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

async function waitUntilUp(
  url: string,
  proc: ChildProcess,
  spawnError: () => Error | null,
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const failed = spawnError()
    if (failed) throw new Error(`could not start whisper-server: ${failed.message}`)
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
