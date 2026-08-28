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

/**
 * Mic only, no screen permission — for the microphone test in settings, where the
 * point is hearing what the current noise setting does to your own voice.
 */
export async function openMicTap(onFrame: (frame: Float32Array) => void): Promise<() => void> {
  const mic = await navigator.mediaDevices.getUserMedia({ audio: true })
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE })
  await ctx.audioWorklet.addModule(
    URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' })),
  )
  const node = new AudioWorkletNode(ctx, 'pcm-tap', { channelCount: 1, channelCountMode: 'explicit' })
  node.port.onmessage = (e: MessageEvent<Float32Array>) => onFrame(e.data)
  const sink = new GainNode(ctx, { gain: 0 })
  sink.connect(ctx.destination)
  new MediaStreamAudioSourceNode(ctx, { mediaStream: mic }).connect(node).connect(sink)

  return () => {
    mic.getTracks().forEach((t) => t.stop())
    void ctx.close()
  }
}

export class Recorder {
  /**
   * While paused, frames are dropped rather than the capture being torn down.
   *
   * Nothing reaches the WAV writers, so the recording simply has no such moment in it:
   * the file is what was actually recorded, joined end to end, and the transcript's
   * times have no minutes-long gap where nobody spoke. Keeping the streams and the
   * AudioContext alive is what makes resuming instant — re-acquiring getDisplayMedia
   * would ask for the screen-share picker again, mid-meeting.
   */
  private paused = false

  /**
   * Muting the microphone writes silence into mic.wav rather than writing nothing.
   *
   * Dropping the frames was the first attempt and it is wrong, which the files said
   * plainly: a meeting muted twice came back with loopback.wav at 28.8s and mic.wav at
   * 20.3s. Each track's timestamps are derived from its own sample count, so from the
   * first unmute onward every one of your own lines would be filed 8.5 seconds early —
   * into the middle of whatever the other side was saying — and the detail page's
   * player, which seeks both tracks to the same position, would have them talking over
   * each other. Only `paused` can drop frames, and only because it drops them from both
   * tracks at once, which is what keeps those two in step.
   *
   * The silence costs 32KB a second and nothing else: whisper never sees it, because
   * the same speech gate that skips a quiet room (vad.ts) skips this too.
   */
  private micMuted = false

  private constructor(
    private readonly ctx: AudioContext,
    private readonly streams: MediaStream[],
  ) {}

  get isPaused(): boolean {
    return this.paused
  }

  setPaused(paused: boolean): void {
    this.paused = paused
  }

  get isMicMuted(): boolean {
    return this.micMuted
  }

  setMicMuted(muted: boolean): void {
    this.micMuted = muted
  }

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
      // Reported as silence rather than skipped: the meters have to go flat and stay
      // there, and leaving them frozen at whatever the last frame happened to be reads
      // as "still listening".
      if (this.paused) return events.onLevel(track, 0)
      const muted = this.micMuted && track === 'mic'
      // Reported as silence rather than skipped: the meter has to go flat and stay
      // there, and one frozen at whatever the last frame held reads as still listening.
      events.onLevel(track, muted ? 0 : rms(frame))
      const pcm = muted ? new Int16Array(frame.length) : toInt16(frame)
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
