import type { Api } from '../preload/index.ts'

declare global {
  interface Window {
    api: Api
  }
}

export type Track = 'loopback' | 'mic'

const SAMPLE_RATE = 16000
const CHUNK_FRAMES = 1600 // 100ms — small enough to feel live, large enough to not spam IPC

/**
 * Inlined as a blob URL rather than shipped as an asset: audioWorklet.addModule needs a
 * real URL, and this keeps it out of the bundler's asset pipeline entirely.
 */
const WORKLET_SOURCE = `
class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buf = new Float32Array(${CHUNK_FRAMES})
    this.n = 0
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (!ch) return true
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i]
      if (this.n === this.buf.length) {
        this.port.postMessage(this.buf.slice())
        this.n = 0
      }
    }
    return true
  }
}
registerProcessor('pcm-tap', PcmTap)
`

function toInt16(f: Float32Array): Int16Array {
  const out = new Int16Array(f.length)
  for (let i = 0; i < f.length; i++) {
    const v = Math.max(-1, Math.min(1, f[i]!))
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff
  }
  return out
}

function rms(f: Float32Array): number {
  let sum = 0
  for (const v of f) sum += v * v
  return Math.sqrt(sum / f.length)
}

export type RecorderEvents = {
  onLevel: (track: Track, rms: number) => void
  onTrackLost: (track: Track) => void
}

export class Recorder {
  private constructor(
    private readonly ctx: AudioContext,
    private readonly streams: MediaStream[],
  ) {}

  static async start(title: string, events: RecorderEvents): Promise<{ recorder: Recorder; dir: string }> {
    // Echo cancellation stays ON: with speakers it keeps the other side out of mic.wav,
    // which is the whole reason the mic track can be labelled "me" without diarizing.
    const mic = await navigator.mediaDevices.getUserMedia({ audio: true })

    let display: MediaStream
    try {
      display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
    } catch (err) {
      mic.getTracks().forEach((t) => t.stop())
      throw err
    }
    // Audio survives without it (verified in spike/electron-loopback), and a 3h meeting
    // should not also be running a full-res screen capture nobody looks at.
    display.getVideoTracks().forEach((t) => t.stop())

    if (display.getAudioTracks().length === 0) {
      mic.getTracks().forEach((t) => t.stop())
      display.getTracks().forEach((t) => t.stop())
      throw new Error('ไม่ได้เสียงระบบ (loopback) — เช็คสิทธิ์ Screen Recording')
    }

    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE })
    await ctx.audioWorklet.addModule(
      URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' })),
    )

    const { dir } = await window.api.start(title)
    const recorder = new Recorder(ctx, [mic, display])

    // Worklets only run when pulled by the graph, so route through a muted sink.
    const sink = new GainNode(ctx, { gain: 0 })
    sink.connect(ctx.destination)
    recorder.tap(display, 'loopback', sink, events)
    recorder.tap(mic, 'mic', sink, events)

    return { recorder, dir }
  }

  private tap(stream: MediaStream, track: Track, sink: AudioNode, events: RecorderEvents): void {
    const node = new AudioWorkletNode(this.ctx, 'pcm-tap', {
      channelCount: 1,
      channelCountMode: 'explicit', // downmix stereo loopback to mono here
    })
    node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      const frame = e.data
      events.onLevel(track, rms(frame))
      const pcm = toInt16(frame)
      void window.api.pcm(track, pcm.buffer as ArrayBuffer)
    }
    new MediaStreamAudioSourceNode(this.ctx, { mediaStream: stream }).connect(node).connect(sink)
    stream.getAudioTracks()[0]?.addEventListener('ended', () => events.onTrackLost(track))
  }

  async stop(): Promise<Awaited<ReturnType<Api['stop']>>> {
    for (const s of this.streams) s.getTracks().forEach((t) => t.stop())
    await this.ctx.close()
    return window.api.stop()
  }
}
