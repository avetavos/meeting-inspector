import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { transcribeRecorded, transcribeTrack, type ReplayServer } from './replay.ts'
import { WavWriter } from './wav.ts'

async function makeWav(dir: string, name: string, pcm: Buffer): Promise<string> {
  const path = join(dir, name)
  const w = await WavWriter.open(path)
  await w.write(pcm)
  await w.close()
  return path
}

type FakeCall = 'enqueue' | 'drain-start' | 'drain-end'

/**
 * A stand-in whisper-server: records every chunk it was asked to enqueue (as a copy —
 * the real Chunker reuses its own internal buffer between cuts, so a test capturing a
 * reference instead of a copy could see a chunk mutate out from under it later), and
 * `calls` timestamps enqueue/drain ordering so a test can prove send() actually awaits
 * drain() before enqueuing the next chunk (delete that one await in replay.ts and the
 * original unbounded-queue bug is back).
 */
function fakeServer(opts: { failAfter?: number; abortAfter?: number; controller?: AbortController } = {}) {
  const calls: FakeCall[] = []
  const enqueued: { track: string; pcm: Int16Array }[] = []
  let drains = 0
  const server: ReplayServer = {
    alive: true,
    enqueue: (track, chunk) => {
      calls.push('enqueue')
      enqueued.push({ track, pcm: Int16Array.from(chunk.pcm) })
    },
    drain: async () => {
      calls.push('drain-start')
      await new Promise((r) => setTimeout(r, 1))
      drains += 1
      if (opts.abortAfter !== undefined && drains === opts.abortAfter) opts.controller?.abort()
      calls.push('drain-end')
    },
    takeFailures: () => (opts.failAfter !== undefined && enqueued.length >= opts.failAfter ? 1 : 0),
  }
  return { server, calls, enqueued }
}

test('transcribeTrack: reads PCM from byte 44 onward, not the WAV header', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'replay-test-'))
  const samples = Int16Array.from([1, -1, 1000, -1000, 32000, -32000, 7, 8, 9, 10])
  const path = await makeWav(dir, 'small.wav', Buffer.from(samples.buffer))

  const { server, enqueued } = fakeServer()
  await transcribeTrack(server, 'loopback', path, 'th', () => {})

  // A file this small never crosses TARGET, so it is exactly one flush() tail chunk —
  // if transcribeTrack read from byte 0 instead of 44, the WAV header would show up
  // as bogus leading int16 "samples" and this would neither match in length nor value.
  assert.equal(enqueued.length, 1)
  assert.deepEqual(enqueued[0]!.pcm, samples)
})

test('transcribeTrack: drains after every chunk — never two enqueues in flight at once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'replay-test-'))
  // Big enough to cross TARGET (30s = 960,000 bytes) several times over multiple 1MB
  // reads, so this only means something if it produces several chunks.
  const path = await makeWav(dir, 'loopback.wav', Buffer.alloc(3_000_000))

  const { server, calls, enqueued } = fakeServer()
  await transcribeTrack(server, 'loopback', path, 'th', () => {})

  assert.ok(enqueued.length >= 3, `expected several chunks out of 3MB, got ${enqueued.length}`)
  // If the `await server.drain()` inside send() were dropped, every enqueue would fire
  // back to back (drain-start logs synchronously even un-awaited, but drain-end would
  // not land until after every enqueue) instead of each drain finishing before the
  // next chunk starts.
  for (let i = 0; i < calls.length; i += 3) {
    assert.deepEqual(calls.slice(i, i + 3), ['enqueue', 'drain-start', 'drain-end'], `group starting at call ${i}`)
  }
})

test('transcribeTrack: an aborted signal stops the pass before the next chunk, not mid-file silently', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'replay-test-'))
  const path = await makeWav(dir, 'loopback.wav', Buffer.alloc(3_000_000))

  const controller = new AbortController()
  const { server, enqueued } = fakeServer({ abortAfter: 1, controller })

  await assert.rejects(
    transcribeTrack(server, 'loopback', path, 'th', () => {}, controller.signal),
    /cancelled/,
  )
  // The signal is checked once per read, at the top of the loop — so the chunk
  // already in flight when abort() lands is the last one sent, not zero and not the
  // whole file.
  assert.equal(enqueued.length, 1)
})

test('transcribeTrack: takeFailures() > 0 aborts the pass instead of finishing it silently partial', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'replay-test-'))
  const path = await makeWav(dir, 'loopback.wav', Buffer.alloc(3_000_000))

  const { server, enqueued } = fakeServer({ failAfter: 1 })

  await assert.rejects(
    transcribeTrack(server, 'loopback', path, 'th', () => {}),
    /whisper failed to transcribe part of loopback/,
  )
  assert.equal(enqueued.length, 1, 'must not keep sending chunks after the first one is known lost')
})

test('transcribeRecorded: a missing track (e.g. mic.wav never written) does not fail the whole meeting', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'replay-test-'))
  await makeWav(dir, 'loopback.wav', Buffer.alloc(1000))
  // mic.wav intentionally not created — a recording interrupted before it wrote every
  // track, or (spec item 3) a meeting the meetings panel is showing precisely because
  // it never finished.

  const { server, enqueued } = fakeServer()
  const total = await transcribeRecorded(server, dir, 'th', () => {})

  assert.equal(total, 1000, 'total only counts the track that actually exists')
  assert.deepEqual(
    enqueued.map((c) => c.track),
    ['loopback'],
    'the missing track must never even be attempted',
  )
})

test('transcribeRecorded: progress sums correctly across both tracks, not reset per track', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'replay-test-'))
  await makeWav(dir, 'loopback.wav', Buffer.alloc(200_000))
  await makeWav(dir, 'mic.wav', Buffer.alloc(100_000))

  const { server } = fakeServer()
  const seen: number[] = []
  const total = await transcribeRecorded(server, dir, 'th', (fraction) => seen.push(fraction))

  assert.equal(total, 300_000)
  // loopback (200,000 of 300,000 combined) reports its own fraction of the combined
  // total, not 100% of itself — then mic's own progress continues from that base
  // rather than starting back over at 0.
  assert.deepEqual(seen, [200_000 / 300_000, 1])
})
