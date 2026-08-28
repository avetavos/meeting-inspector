import assert from 'node:assert/strict'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
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
  deleteMeeting,
  renameMeeting,
  writeTranscript,
} from './store.ts'
import { safeId, titleOf, untitledTitle } from '../shared/meetings.ts'
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

test('meetings: the composer placeholder is exactly what an untitled meeting gets called', () => {
  // The whole point of showing it before the recording exists — if these two ever
  // disagree, the placeholder is promising a name the meeting will not have.
  const at = new Date(2026, 7, 27, 14, 0)
  assert.equal(untitledTitle(at), titleOf(meetingId('', at)))
  assert.equal(untitledTitle(at), '27-08-2026 14:00')
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

/** A meeting folder on disk: both WAVs plus, optionally, a transcript. */
async function fixture(root: string, id: string, transcribed: boolean): Promise<string> {
  const dir = join(root, id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'loopback.wav'), 'audio')
  await writeFile(join(dir, 'mic.wav'), 'audio')
  if (transcribed) {
    await writeTranscript(dir, {
      id,
      startedAt: localIso(new Date(2026, 7, 27, 14, 0, 0)),
      durationSec: 60,
      speakers: { me: 'You' },
      segments: [{ t0: 0, t1: 1, speaker: 'me', text: 'hello' }],
    })
  }
  return dir
}

const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false)

test('store: renaming a meeting moves the folder, keeps the timestamp, and re-stamps the transcript', async () => {
  const root = join(tmpdir(), `rename-test-${process.pid}-a`)
  await fixture(root, '2026-08-27-1400', true)

  const next = await renameMeeting('2026-08-27-1400', 'สรุป sprint', root)
  assert.equal(next, '2026-08-27-1400-สรุป-sprint', 'the stamp is carried over verbatim; only the title part changes')
  assert.equal(await exists(join(root, '2026-08-27-1400')), false, 'the old folder must not be left behind')
  // The id is inside transcript.json (and transcript.md renders from it), so a rename
  // that only moved the folder would leave the transcript claiming the old name.
  assert.equal((await readTranscript(join(root, next))).id, next)
  assert.match(await readFile(join(root, next, 'transcript.md'), 'utf8'), /2026-08-27-1400-สรุป-sprint/)

  // Renaming back to nothing returns to the bare stamp, not a folder called "-".
  assert.equal(await renameMeeting(next, '   ', root), '2026-08-27-1400')
})

test('store: a rename onto a name another meeting already holds walks past it instead of swallowing it', async () => {
  const root = join(tmpdir(), `rename-test-${process.pid}-b`)
  await fixture(root, '2026-08-27-1400-standup', true)
  await fixture(root, '2026-08-27-1500', true)

  const next = await renameMeeting('2026-08-27-1500', 'standup', root)
  assert.equal(next, '2026-08-27-1500-standup', 'a different stamp is not a collision at all')

  // Same stamp, same title — this one genuinely collides, and the meeting already
  // sitting there must survive untouched.
  await fixture(root, '2026-08-27-1400-retro', true)
  const bumped = await renameMeeting('2026-08-27-1400-retro', 'standup', root)
  assert.equal(bumped, '2026-08-27-1400-standup-2')
  assert.equal(await exists(join(root, '2026-08-27-1400-standup', 'loopback.wav')), true, 'the meeting that was already there must not have been clobbered')

  // Renaming a meeting to the name it already has is a no-op, not a walk to "-2".
  assert.equal(await renameMeeting('2026-08-27-1400-standup', 'standup', root), '2026-08-27-1400-standup')
})

test('store: deleting audio keeps the transcript; deleting the meeting takes the folder', async () => {
  const root = join(tmpdir(), `delete-test-${process.pid}`)
  const kept = await fixture(root, '2026-08-27-1400-kept', true)
  const gone = await fixture(root, '2026-08-27-1500-gone', true)

  await deleteMeeting('2026-08-27-1400-kept', true, root)
  assert.equal(await exists(join(kept, 'loopback.wav')), false)
  assert.equal(await exists(join(kept, 'mic.wav')), false)
  assert.equal(await exists(join(kept, 'transcript.json')), true, 'the whole point of audio-only: the words survive')
  // Idempotent — a second click, or a half-deleted folder, is the desired end state.
  await deleteMeeting('2026-08-27-1400-kept', true, root)

  await deleteMeeting('2026-08-27-1500-gone', false, root)
  assert.equal(await exists(gone), false)

  // An id that could climb out of the notes folder is refused before anything is touched.
  await assert.rejects(() => deleteMeeting('../../etc', false, root))
  await assert.rejects(() => renameMeeting('../../etc', 'x', root))
})
