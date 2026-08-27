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

  const cjs: { OfflineSpeakerDiarization: typeof OfflineSpeakerDiarization }
  export default cjs
}
