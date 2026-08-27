import { open, type FileHandle } from 'node:fs/promises'

const HEADER_BYTES = 44

/** 16-bit mono PCM WAV. The header is written on close, when the length is known. */
export class WavWriter {
  private bytes = 0
  private tail: Promise<unknown> = Promise.resolve()

  private constructor(
    private readonly fh: FileHandle,
    readonly sampleRate: number,
  ) {}

  static async open(path: string, sampleRate = 16000): Promise<WavWriter> {
    const fh = await open(path, 'w')
    await fh.write(Buffer.alloc(HEADER_BYTES))
    return new WavWriter(fh, sampleRate)
  }

  /** Positions are claimed synchronously, so out-of-order awaits cannot interleave data. */
  write(pcm: Buffer): Promise<unknown> {
    const at = HEADER_BYTES + this.bytes
    this.bytes += pcm.length
    this.tail = this.fh.write(pcm, 0, pcm.length, at)
    return this.tail
  }

  async close(): Promise<{ bytes: number; durationSec: number }> {
    await this.tail
    await this.fh.write(wavHeader(this.bytes, this.sampleRate), 0, HEADER_BYTES, 0)
    await this.fh.close()
    return { bytes: this.bytes, durationSec: this.bytes / 2 / this.sampleRate }
  }
}

export function wavHeader(dataBytes: number, sampleRate: number, channels = 1, bits = 16): Buffer {
  const b = Buffer.alloc(HEADER_BYTES)
  b.write('RIFF', 0)
  b.writeUInt32LE(36 + dataBytes, 4)
  b.write('WAVE', 8)
  b.write('fmt ', 12)
  b.writeUInt32LE(16, 16) // fmt chunk size
  b.writeUInt16LE(1, 20) // format: PCM
  b.writeUInt16LE(channels, 22)
  b.writeUInt32LE(sampleRate, 24)
  b.writeUInt32LE((sampleRate * channels * bits) / 8, 28) // byte rate
  b.writeUInt16LE((channels * bits) / 8, 32) // block align
  b.writeUInt16LE(bits, 34)
  b.write('data', 36)
  b.writeUInt32LE(dataBytes, 40)
  return b
}
