import { open, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Chunker } from './chunker.ts'
import type { MeetingLanguage } from '../shared/meetings.ts'
import type { Whisper } from './whisper.ts'

/**
 * No Electron import here on purpose (same reason as batch.ts) — offline replay is the
 * whole point of 'after' mode and the batch queue, and neither transcribeTrack nor
 * transcribeRecorded used to be exported or testable at all. index.ts wires this to the
 * real whisper singleton; tests drive it against a stub server.
 */

export type Track = 'loopback' | 'mic'
export const TRACKS = ['loopback', 'mic'] as const

/**
 * Only the whisper-server surface a replay pass actually needs — `Pick` over the real
 * class rather than the class type itself, so a plain stub object satisfies it in a
 * test without a real spawned server (the class's private fields would otherwise make
 * it un-satisfiable by a struct literal).
 */
export type ReplayServer = Pick<Whisper, 'alive' | 'enqueue' | 'drain' | 'takeFailures'>

// Disk read size only — how much of the track we hold in the plain read buffer at
// once (~350MB for a 3-hour meeting would be reading it all in one go, which this
// avoids). It does NOT bound how much the Chunker itself holds: that used to be
// implicit and wrong (chunker.ts's push() now loop-cuts internally so its own backlog
// stays bounded regardless of how big a single push is — see chunker.test.ts).
const READ_BYTES = 1 << 20

/**
 * Replays one finished track through a fresh Chunker, sending each chunk to whichever
 * whisper-server instance the caller already started. `flush()`'s tail chunk is sent
 * the same way. Draining after every chunk keeps at most one chunk's PCM in flight, and
 * checking `alive`/failures around each one means a dead server or a failed chunk
 * aborts the pass instead of silently finishing it partial.
 */
export async function transcribeTrack(
  server: ReplayServer,
  track: Track,
  path: string,
  language: MeetingLanguage,
  onProgress: (bytesDone: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const fh = await open(path, 'r')
  try {
    const { size } = await fh.stat()
    const chunker = new Chunker()
    const buf = Buffer.alloc(READ_BYTES)
    let pos = 44 // wav.ts always writes a 44-byte header
    const send = async (chunk: { pcm: Int16Array; startSec: number }): Promise<void> => {
      if (!server.alive) throw new Error('whisper-server died mid-transcription')
      server.enqueue(track, chunk, language, signal)
      await server.drain()
      if (server.takeFailures() > 0) throw new Error(`whisper failed to transcribe part of ${track}`)
    }
    while (pos < size) {
      // Checked once per 1MB read rather than only between tracks, so cancelling a
      // batch pass mid-meeting does not have to wait out the rest of a 3-hour file
      // first. That said, this check is not what makes cancel prompt — most of the
      // wait is inside send() above, which is why enqueue() is given `signal` too (it
      // aborts the in-flight /inference call, not just the next read).
      if (signal?.aborted) throw new Error('cancelled')
      const { bytesRead } = await fh.read(buf, 0, Math.min(READ_BYTES, size - pos), pos)
      if (bytesRead === 0) break
      pos += bytesRead
      for (const chunk of chunker.push(new Int16Array(buf.buffer, buf.byteOffset, bytesRead / 2))) {
        await send(chunk)
      }
      onProgress(pos - 44)
    }
    const tail = chunker.flush()
    if (tail) await send(tail)
  } finally {
    await fh.close()
  }
}

/**
 * 'after' mode's whole pass, and the batch queue's per-meeting pass: both tracks, one
 * after the other, so a 3-hour meeting never needs both whole WAVs plus their chunks
 * resident at once. `onProgress` reports 0..1 across both tracks combined. Returns the
 * total bytes actually found across both tracks — 0 means neither track had anything to
 * transcribe (a meeting with no audio), which the caller uses to decide whether this
 * pass produced anything worth marking as transcribed.
 *
 * A track that is missing or empty (e.g. a recording interrupted before it wrote one) is
 * skipped rather than failing the whole pass — exactly the kind of meeting the meetings
 * panel exists to surface, so this must not fail before a single chunk of the track(s)
 * that DO exist gets read.
 */
export async function transcribeRecorded(
  server: ReplayServer,
  dir: string,
  language: MeetingLanguage,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<number> {
  const files = TRACKS.map((track) => ({ track, path: join(dir, `${track}.wav`) }))
  const sizes = await Promise.all(
    files.map(({ path }) => stat(path).then((st) => Math.max(0, st.size - 44)).catch(() => 0)),
  )
  const total = sizes.reduce((a, b) => a + b, 0)
  let base = 0
  for (const [i, { track, path }] of files.entries()) {
    if (sizes[i]! > 0) {
      await transcribeTrack(
        server,
        track,
        path,
        language,
        (done) => onProgress(total > 0 ? (base + done) / total : 1),
        signal,
      )
    }
    base += sizes[i]!
  }
  return total
}
