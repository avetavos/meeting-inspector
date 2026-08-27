// The package ships no types. Only the surface we actually call is declared.
declare module 'sherpa-onnx-node' {
  export type SpeakerTurn = { start: number; end: number; speaker: number }

  export type DiarizationConfig = {
    segmentation: { pyannote: { model: string } }
    embedding: { model: string }
    /** numClusters -1 lets clustering decide how many people spoke. */
    clustering: { numClusters: number; threshold: number }
  }

  export class OfflineSpeakerDiarization {
    constructor(config: DiarizationConfig)
    readonly sampleRate: number
    process(samples: Float32Array): SpeakerTurn[]
  }

  export type VadConfig = {
    sileroVad: {
      model: string
      threshold?: number
      minSilenceDuration?: number
      minSpeechDuration?: number
      maxSpeechDuration?: number
    }
    sampleRate?: number
    numThreads?: number
  }

  /** Streaming detector: push windows in, pop a segment out whenever one closes. */
  export class Vad {
    constructor(config: VadConfig, bufferSizeInSeconds: number)
    acceptWaveform(samples: Float32Array): void
    isEmpty(): boolean
    pop(): void
    reset(): void
    flush(): void
  }

  export type SpeakerEmbeddingStream = {
    acceptWaveform(o: { sampleRate: number; samples: Float32Array }): void
    inputFinished(): void
  }

  /** Turns a stretch of one person's speech into a vector that identifies the voice. */
  export class SpeakerEmbeddingExtractor {
    constructor(config: { model: string; numThreads?: number })
    readonly dim: number
    createStream(): SpeakerEmbeddingStream
    isReady(stream: SpeakerEmbeddingStream): boolean
    compute(stream: SpeakerEmbeddingStream): Float32Array
  }

  const cjs: {
    OfflineSpeakerDiarization: typeof OfflineSpeakerDiarization
    Vad: typeof Vad
    SpeakerEmbeddingExtractor: typeof SpeakerEmbeddingExtractor
  }
  export default cjs
}
