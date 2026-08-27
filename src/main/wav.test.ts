import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  NOTES_ROOT,
  assertMeetingDir,
  localIso,
  meetingId,
  readTranscript,
  slug,
  writeTranscript,
} from './store.ts'
import { safeId, titleOf } from '../shared/meetings.ts'
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

test('store: an untitled meeting is just its timestamp', () => {
  const at = new Date(2026, 7, 27, 14, 0)
  // No filler word in the folder name, and no date repeated after the date.
  assert.equal(meetingId('', at), '2026-08-27-1400')
  assert.equal(meetingId('   ', at), '2026-08-27-1400')
})

test('meetings: an untitled meeting reads as the time it happened', () => {
  assert.equal(titleOf('2026-08-27-1400'), '27-08-2026 14:00')
  assert.equal(titleOf('2026-08-27-1400-sprint-planning'), 'sprint-planning')
  assert.equal(titleOf('2026-08-27-1400-ประชุม-ทีม'), 'ประชุม-ทีม')
  assert.equal(titleOf('not-a-meeting-id'), 'not-a-meeting-id')
})

test('store: slug cannot escape the notes folder', () => {
  assert.equal(slug('../../etc/passwd'), 'etcpasswd')
  assert.equal(slug('a/b:c'), 'abc')
  assert.equal(slug('   '), '')
  assert.equal(slug(''), '')
})

test('store: a transcript survives the round trip, sorted by time', async () => {
  const dir = join(tmpdir(), `transcript-test-${process.pid}`)
  await mkdir(dir, { recursive: true })
  const written = {
    id: '2026-08-27-1400-sprint-planning',
    startedAt: localIso(new Date(2026, 7, 27, 14, 0, 0)),
    durationSec: 3120,
    speakers: { me: 'คุณ', them: 'คนอื่น' },
    // Out of order on purpose: the two tracks are transcribed independently.
    segments: [
      { t0: 19.1, t1: 24.0, speaker: 'me', text: 'เดี๋ยวผม deploy ให้' },
      { t0: 12.4, t1: 18.9, speaker: 'them', text: 'ตัว backend พร้อมยัง' },
    ],
  }
  await writeTranscript(dir, written)

  const read = await readTranscript(dir)
  assert.deepEqual(read.segments.map((s) => s.t0), [12.4, 19.1])
  assert.deepEqual(read, { ...written, segments: [written.segments[1]!, written.segments[0]!] })

  const md = await readFile(join(dir, 'transcript.md'), 'utf8')
  assert.match(md, /# 2026-08-27-1400-sprint-planning/)
  assert.match(md, /\*\*คนอื่น\*\* `00:12`\s+ตัว backend พร้อมยัง/)
  assert.ok(md.indexOf('คนอื่น') < md.indexOf('คุณ'), 'markdown should follow the same order')
})

test('store: timestamps keep their local offset', () => {
  const at = new Date(2026, 7, 27, 14, 5, 9)
  const iso = localIso(at)
  assert.match(iso, /^2026-08-27T14:05:09[+-]\d{2}:\d{2}$/)
  assert.equal(new Date(iso).getTime(), at.getTime(), 'must parse back to the same instant')
})

test('store: a path from the renderer cannot point outside the notes folder', () => {
  const inside = join(NOTES_ROOT, '2026-08-27-1400-sprint-planning')
  assert.equal(assertMeetingDir(inside), inside)
  // Trailing separators and dot segments still resolve to somewhere legitimate.
  assert.equal(assertMeetingDir(`${inside}/`), inside)
  assert.equal(assertMeetingDir(`${NOTES_ROOT}/x/../2026-08-27-1400-sprint-planning`), inside)

  // shell.openPath would have launched this one, and rename would have written to it.
  for (const escape of [
    '/Applications/Calculator.app',
    `${NOTES_ROOT}/../Downloads/evil.app`,
    join(NOTES_ROOT, '..'),
    NOTES_ROOT,
    '',
  ]) {
    assert.throws(() => assertMeetingDir(escape), /not a meeting folder/, `should refuse ${escape}`)
  }
})

test('meetings: an empty id is not a meeting', () => {
  // join(root, '', 'transcript.json') would read a stray file in the notes root.
  assert.equal(safeId(''), false)
  assert.equal(safeId('2026-08-27-1400-sprint-planning'), true)
  assert.equal(safeId('../etc'), false)
  assert.equal(safeId('.hidden'), false)
})
