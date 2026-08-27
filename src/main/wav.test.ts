import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { meetingId, slug } from './store.ts'
import { WavWriter } from './wav.ts'

test('wav: header matches what was actually written, across many appends', async () => {
  const path = join(tmpdir(), `wav-test-${process.pid}.wav`)
  const w = await WavWriter.open(path, 16000)

  // Deliberately not awaited in order — writes claim their position synchronously.
  const chunks = Array.from({ length: 50 }, (_, i) => Buffer.alloc(320, i))
  await Promise.all(chunks.map((c) => w.write(c)))
  const { bytes, durationSec } = await w.close()

  const f = await readFile(path)
  assert.equal(bytes, 16000)
  assert.equal(durationSec, 0.5)
  assert.equal(f.length, 44 + 16000)
  assert.equal(f.toString('ascii', 0, 4), 'RIFF')
  assert.equal(f.readUInt32LE(4), 36 + 16000)
  assert.equal(f.toString('ascii', 8, 12), 'WAVE')
  assert.equal(f.readUInt16LE(20), 1) // PCM
  assert.equal(f.readUInt16LE(22), 1) // mono
  assert.equal(f.readUInt32LE(24), 16000) // sample rate
  assert.equal(f.readUInt32LE(28), 32000) // byte rate
  assert.equal(f.readUInt16LE(32), 2) // block align
  assert.equal(f.readUInt16LE(34), 16) // bits
  assert.equal(f.readUInt32LE(40), 16000) // data size

  // Every chunk landed at its own offset, in order.
  for (const [i, c] of chunks.entries()) {
    assert.deepEqual(f.subarray(44 + i * 320, 44 + (i + 1) * 320), c, `chunk ${i}`)
  }
})

test('store: meeting id is sortable and keeps Thai', () => {
  const at = new Date(2026, 7, 27, 14, 0)
  assert.equal(meetingId('sprint planning', at), '2026-08-27-1400-sprint-planning')
  assert.equal(meetingId('ประชุม ทีม', at), '2026-08-27-1400-ประชุม-ทีม')
})

test('store: slug cannot escape the notes folder', () => {
  assert.equal(slug('../../etc/passwd'), 'etcpasswd')
  assert.equal(slug('a/b:c'), 'abc')
  assert.equal(slug('   '), 'meeting')
  assert.equal(slug(''), 'meeting')
})
