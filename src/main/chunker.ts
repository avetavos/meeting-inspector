export const SAMPLE_RATE = 16000

const TARGET = 30 * SAMPLE_RATE // spec §7: ~30s of audio per ASR call
const CUT_SEARCH = 6 * SAMPLE_RATE // how far back from TARGET to hunt for a gap
const CUT_WINDOW = Math.round(0.16 * SAMPLE_RATE)

export type Chunk = { pcm: Int16Array; startSec: number }

/**
 * Splits a PCM stream into ASR-sized chunks, cutting at the quietest moment near
 * the target length instead of on a fixed clock.
 *
 * Spec §13.4 proposed 2s overlapping chunks plus dedup on merge. Cutting in a gap
 * removes the straddled-word problem at the source, so there is nothing to dedup.
 * Residual risk: through 6s of unbroken speech the quietest window is still speech
 * and the cut clips a word — rarer than a blind cut, and the only cost is one word.
 */
export class Chunker {
  private buf = new Int16Array(TARGET * 2)
  private held = 0
  private emitted = 0

  /**
   * Returns every chunk ready after this push. Almost always 0 or 1 — the live path
   * feeds ~100ms frames — but looping here (rather than cutting once and leaving the
   * rest) is what keeps a caller that pushes more than TARGET at once (the offline
   * replay's 1MB disk reads, ~32.8s) from accumulating an ever-growing backlog: cutting
   * only once per call left up to ~2.8-8.8s uncollected on every such push, and across a
   * whole track that grew into a 30-minute tail chunk.
   */
  push(pcm: Int16Array): Chunk[] {
    if (this.held + pcm.length > this.buf.length) {
      const grown = new Int16Array((this.held + pcm.length) * 2)
      grown.set(this.buf.subarray(0, this.held))
      this.buf = grown
    }
    this.buf.set(pcm, this.held)
    this.held += pcm.length
    const chunks: Chunk[] = []
    while (this.held >= TARGET) chunks.push(this.cut(this.quietestCut()))
    return chunks
  }

  /** Everything still buffered, as a final short chunk. */
  flush(): Chunk | null {
    return this.held > 0 ? this.cut(this.held) : null
  }

  private cut(at: number): Chunk {
    const chunk = { pcm: this.buf.slice(0, at), startSec: this.emitted / SAMPLE_RATE }
    this.buf.copyWithin(0, at, this.held)
    this.held -= at
    this.emitted += at
    return chunk
  }

  private quietestCut(): number {
    let best = TARGET
    let bestEnergy = Infinity
    for (let start = TARGET - CUT_SEARCH; start + CUT_WINDOW <= TARGET; start += CUT_WINDOW) {
      let energy = 0
      for (let i = start; i < start + CUT_WINDOW; i++) energy += Math.abs(this.buf[i]!)
      if (energy < bestEnergy) {
        bestEnergy = energy
        best = start + CUT_WINDOW / 2
      }
    }
    return best
  }
}

/**
 * Whether a chunk is worth sending to ASR at all (spec §7.3).
 *
 * The reason is robustness, not cost: whisper-server can abort when VAD finds no
 * speech, taking every later chunk of the meeting down with it. The loopback track is
 * exactly zero whenever nothing is playing — measured on a real recording, 0 non-zero
 * samples in 2 million — so this catches the case that actually happens.
 *
 * ponytail: a peak gate, not a VAD. Chunks that are quiet but not silent still reach
 * the server; the supervisor restarts it if one of those trips the same bug.
 */
export function hasSignal(pcm: Int16Array): boolean {
  const FLOOR = 32 // ≈ -60 dBFS, far below any real speech
  for (let i = 0; i < pcm.length; i++) {
    if (pcm[i]! > FLOOR || pcm[i]! < -FLOOR) return true
  }
  return false
}
