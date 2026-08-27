import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Chunker, SAMPLE_RATE as SR, hasSignal, type Chunk } from './chunker.ts'

/** Loud everywhere except the silent spans given as [startSec, endSec]. */
function audio(seconds: number, ...gaps: [number, number][]): Int16Array {
  const a = new Int16Array(Math.round(seconds * SR)).fill(8000)
  for (const [from, to] of gaps) a.fill(0, Math.round(from * SR), Math.round(to * SR))
  return a
}

/** Feeds in 100ms frames, the way the renderer actually delivers PCM. */
function feed(c: Chunker, pcm: Int16Array): Chunk[] {
  const out: Chunk[] = []
  for (let i = 0; i < pcm.length; i += 1600) {
    out.push(...c.push(pcm.subarray(i, Math.min(i + 1600, pcm.length))))
  }
  return out
}

test('chunker: cuts in the silence, not on the clock', () => {
  const chunks = feed(new Chunker(), audio(35, [27.0, 27.4]))
  assert.equal(chunks.length, 1)
  const cutSec = chunks[0]!.pcm.length / SR
  assert.ok(cutSec > 27.0 && cutSec < 27.4, `cut at ${cutSec}s, expected inside the 27.0-27.4s gap`)
  assert.equal(chunks[0]!.startSec, 0)
})

test('chunker: still cuts when nobody stops talking', () => {
  const chunks = feed(new Chunker(), audio(35))
  assert.equal(chunks.length, 1)
  const cutSec = chunks[0]!.pcm.length / SR
  assert.ok(cutSec > 23 && cutSec <= 30, `cut at ${cutSec}s, expected within the search window`)
})

test('chunker: every sample comes out exactly once, in order', () => {
  const c = new Chunker()
  // A ramp, so a dropped or duplicated sample shows up as a break in the sequence.
  const total = 80 * SR
  const ramp = new Int16Array(total)
  for (let i = 0; i < total; i++) ramp[i] = i % 30000
  const chunks = feed(c, ramp)
  const tail = c.flush()
  if (tail) chunks.push(tail)

  assert.ok(chunks.length >= 2, 'expected 80s to split into several chunks')
  let at = 0
  for (const chunk of chunks) {
    assert.equal(chunk.startSec, at / SR, `chunk starting at sample ${at} reported ${chunk.startSec}s`)
    assert.deepEqual(chunk.pcm, ramp.subarray(at, at + chunk.pcm.length))
    at += chunk.pcm.length
  }
  assert.equal(at, total)
  assert.equal(c.flush(), null)
})

test('chunker: an oversized single push (transcribeTrack reads 1MB ≈ 32.8s at once) never grows an unbounded backlog', () => {
  // Before the fix, push() cut only once per call no matter how much backlog was
  // already sitting there, so a caller pushing more than TARGET at once (32.8s > 30s)
  // gained ~2.8-8.8s of uncollected audio on every single call. Replayed over a whole
  // 3-hour track (the offline 'after'-mode / batch-queue path in index.ts, one push per
  // 1MB disk read) that grew into a 30-minute, 58MB tail chunk — measured by the
  // reviewer on the real Chunker driven exactly as transcribeTrack drives it.
  const c = new Chunker()
  const READ = new Int16Array(524_288).fill(8000) // one disk read: 32.8s of PCM16 samples
  let maxChunk = 0
  for (let i = 0; i < 350; i++) { // ~330 reads is what a real 3h meeting measured out to
    for (const chunk of c.push(READ)) maxChunk = Math.max(maxChunk, chunk.pcm.length)
  }
  const tail = c.flush()
  if (tail) maxChunk = Math.max(maxChunk, tail.pcm.length)
  assert.ok(maxChunk < 40 * SR, `a chunk was ${maxChunk / SR}s, expected under 40s`)
})

test('signal gate: digital silence is skipped, real audio is not', () => {
  assert.equal(hasSignal(new Int16Array(SR)), false, 'a track with nothing playing is exactly zero')

  // Dither well under the floor still counts as nothing worth transcribing.
  const hiss = new Int16Array(SR)
  for (let i = 0; i < hiss.length; i++) hiss[i] = i % 3 === 0 ? 8 : -8
  assert.equal(hasSignal(hiss), false)

  const speech = new Int16Array(SR)
  speech[12345] = 900
  assert.equal(hasSignal(speech), true, 'one loud sample is enough to be worth sending')
})
