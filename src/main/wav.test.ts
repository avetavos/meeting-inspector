import assert from 'node:assert/strict'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  NOTES_ROOT,
  assertMeetingDir,
  createMeetingDir,
  localIso,
  readMeta,
  readTranscript,
  deleteMeeting,
  dropEchoedMic,
  dropSpeakers,
  migrateMeetingMeta,
  setMeetingTitle,
  setSpeakerCount,
  uuidv7,
  writeTranscript,
} from './store.ts'
import { displayTitle, safeId, titlePartOf, untitledTitle } from '../shared/meetings.ts'
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

test('store: ids are uuid v7, and they sort into the order the meetings happened', () => {
  const at = new Date(2026, 7, 27, 14, 0)
  const id = uuidv7(at)
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, 'version 7, RFC variant')

  // The whole reason for v7 over v4/v5: plain string order is time order, so a folder
  // listing and the meetings list agree without anyone parsing a date out of a name.
  const ids = [
    uuidv7(new Date(2026, 7, 27, 14, 0)),
    uuidv7(new Date(2026, 7, 27, 14, 1)),
    uuidv7(new Date(2026, 7, 28, 9, 0)),
    uuidv7(new Date(2027, 0, 1, 0, 0)),
  ]
  assert.deepEqual([...ids].sort(), ids)

  // Same millisecond, different meeting — 74 random bits, so nothing collides the way
  // the old minute-resolution id did (MEDIUM 3).
  assert.notEqual(uuidv7(at), uuidv7(at))
})

test('store: a new meeting gets its title in meeting.json, not in its folder name', async () => {
  const root = join(tmpdir(), `create-test-${process.pid}`)
  const at = new Date(2026, 7, 27, 14, 0)
  const { id, dir } = await createMeetingDir('ประชุม ทีม / Q3: แผน', at, root)

  assert.equal(dir, join(root, id))
  assert.match(id, /^[0-9a-f]{8}-/, 'the folder name is the id, and the id is a uuid')
  // Freetext: slashes and colons used to be stripped because the title WAS a path.
  assert.deepEqual(await readMeta(dir), { id, title: 'ประชุม ทีม / Q3: แผน', startedAt: localIso(at) })

  // Untitled is a real state now, not a folder named after the clock.
  const untitled = await createMeetingDir('   ', at, root)
  assert.equal((await readMeta(untitled.dir))?.title, '')
})

test('meetings: an untitled meeting reads as the time it happened', () => {
  assert.equal(displayTitle('', '2026-08-27T14:00:00'), '27-08-2026 14:00')
  assert.equal(displayTitle('   ', '2026-08-27T14:00:00'), '27-08-2026 14:00')
  assert.equal(displayTitle('sprint planning', '2026-08-27T14:00:00'), 'sprint planning')
})

test('meetings: the composer placeholder is exactly what an untitled meeting gets called', () => {
  // The whole point of showing it before the recording exists — if these two ever
  // disagree, the placeholder is promising a name the meeting will not have.
  const at = new Date(2026, 7, 27, 14, 0)
  assert.equal(untitledTitle(at), displayTitle('', localIso(at)))
  assert.equal(untitledTitle(at), '27-08-2026 14:00')
})

test('meetings: a pre-uuid id still gives up its title half, for the migration', () => {
  assert.equal(titlePartOf('2026-08-27-1400-sprint-planning'), 'sprint-planning')
  assert.equal(titlePartOf('2026-08-27-1400-ประชุม-ทีม'), 'ประชุม-ทีม')
  assert.equal(titlePartOf('2026-08-27-1400'), '', 'stamped but never titled')
  assert.equal(titlePartOf('not-a-meeting-id'), null)
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
  // No meeting.json beside it, so the heading falls back to the time — the id is a uuid
  // now and would tell a reader nothing.
  assert.match(md, /# 27-08-2026 14:00/)
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

test('store: retitling a meeting rewrites meeting.json and leaves the folder — and the id — alone', async () => {
  const root = join(tmpdir(), `rename-test-${process.pid}-a`)
  const { id, dir } = await createMeetingDir('sprint planning', new Date(2026, 7, 27, 14, 0), root)
  await fixture(root, id, true)

  await setMeetingTitle(id, '  สรุป sprint / Q3  ', root)
  assert.equal(await exists(dir), true, 'nothing moves — the id is not made out of the title any more')
  const meta = await readMeta(dir)
  assert.equal(meta?.id, id)
  assert.equal(meta?.title, 'สรุป sprint / Q3', 'trimmed, but otherwise stored exactly as typed')

  // Blank is a real title, not a folder called "-": it reads back as the time.
  await setMeetingTitle(id, '   ', root)
  assert.equal((await readMeta(dir))?.title, '')

  // Two meetings can hold the same title now — there is no folder left to collide.
  const other = await createMeetingDir('', new Date(2026, 7, 27, 15, 0), root)
  await setMeetingTitle(other.id, 'standup', root)
  await setMeetingTitle(id, 'standup', root)
  assert.equal((await readMeta(dir))?.title, 'standup')
  assert.equal((await readMeta(other.dir))?.title, 'standup')
})

test('store: meetings recorded before uuids keep their folder and gain a meeting.json', async () => {
  const root = join(tmpdir(), `migrate-test-${process.pid}`)
  await fixture(root, '2026-08-27-1400-sprint-planning', true)
  await fixture(root, '2026-08-27-1500', true)

  assert.equal(await migrateMeetingMeta(root), 2)
  // The folder name IS the id, and voices.json/MCP clients already hold those — so it
  // must not have moved.
  assert.equal(await exists(join(root, '2026-08-27-1400-sprint-planning')), true)
  const meta = await readMeta(join(root, '2026-08-27-1400-sprint-planning'))
  assert.equal(meta?.id, '2026-08-27-1400-sprint-planning')
  assert.equal(meta?.title, 'sprint-planning')
  assert.equal((await readMeta(join(root, '2026-08-27-1500')))?.title, '', 'never titled, and it stays that way')

  // Idempotent: a second launch must not overwrite a title the user has since changed.
  await setMeetingTitle('2026-08-27-1400-sprint-planning', 'retro', root)
  assert.equal(await migrateMeetingMeta(root), 0)
  assert.equal((await readMeta(join(root, '2026-08-27-1400-sprint-planning')))?.title, 'retro')
})

test('store: a speaker who turns out to be noise takes their lines with them', () => {
  const transcript = {
    id: 'x',
    startedAt: '2026-08-27T14:00:00+07:00',
    durationSec: 60,
    speakers: { me: 'คุณ', SPEAKER_04: '', SPEAKER_19: '', SPEAKER_06: 'บิว' },
    segments: [
      { t0: 0, t1: 2, speaker: 'me', text: 'สวัสดีครับ' },
      { t0: 2, t1: 3, speaker: 'SPEAKER_04', text: 'อืม' },
      { t0: 3, t1: 5, speaker: 'SPEAKER_06', text: 'ตัว backend พร้อมยัง' },
      { t0: 5, t1: 6, speaker: 'SPEAKER_19', text: 'ครับๆ' },
    ],
    speakerVoices: {
      SPEAKER_04: { voiceId: 'v4', name: '' },
      SPEAKER_06: { voiceId: 'v6', name: 'บิว' },
    },
  }

  const kept = dropSpeakers(transcript, ['SPEAKER_04', 'SPEAKER_19'])
  assert.deepEqual(Object.keys(kept.speakers), ['me', 'SPEAKER_06'])
  assert.deepEqual(kept.segments.map((s) => s.speaker), ['me', 'SPEAKER_06'])
  // The link to the noise voice goes too, or the transcript points at a voice it has no
  // audio filed under any more.
  assert.deepEqual(kept.speakerVoices, { SPEAKER_06: { voiceId: 'v6', name: 'บิว' } })
  // The original is untouched — the caller writes what comes back.
  assert.equal(transcript.segments.length, 4)
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
  await assert.rejects(() => setMeetingTitle('../../etc', 'x', root))
})

test('store: the speakers coming back into the mic are dropped, real speech is not', () => {
  const line = 'ส่วนขาแรกที่เป็นขา agent ที่บอกว่าขา with lead เราก็จะปล่อยให้มันเหมือนเดิมไปนะครับ'
  const kept = dropEchoedMic([
    { t0: 7.0, t1: 12.0, speaker: 'SPEAKER_00', text: line },
    // The microphone's copy of that same sentence: a moment later, cut short, and
    // punctuated differently by whisper because the chunk boundaries fell elsewhere.
    { t0: 7.4, t1: 10.1, speaker: 'me', text: 'ส่วนขาแรกที่เป็นขา agent ที่บอกว่า' },
    // Genuinely ours: nothing on the other track says this.
    { t0: 13.0, t1: 15.0, speaker: 'me', text: 'เดี๋ยวผมขอเช็คของฝั่งผมก่อนนะครับ' },
    // Short agreement over the top of them — people do this constantly, and it must
    // survive even though it is a prefix of what the other side said.
    { t0: 7.5, t1: 7.9, speaker: 'me', text: 'ครับ' },
    // The same words, but half a minute later: a callback, not an echo.
    { t0: 60.0, t1: 64.0, speaker: 'me', text: line },
  ])

  assert.deepEqual(
    kept.map((s) => `${s.speaker}@${s.t0}`),
    ['SPEAKER_00@7', 'me@13', 'me@7.5', 'me@60'],
  )
})

test('store: an echo pass over a meeting with no other track changes nothing', () => {
  // A mic-only recording (nothing was playing) has no reference to match against, so
  // every line must survive however long or repetitive it is.
  const only = [
    { t0: 0, t1: 4, speaker: 'me', text: 'เอาละครับวันนี้เรามาคุยเรื่อง deploy กัน' },
    { t0: 5, t1: 9, speaker: 'me', text: 'เอาละครับวันนี้เรามาคุยเรื่อง deploy กัน' },
  ]
  assert.deepEqual(dropEchoedMic(only), only)
  assert.deepEqual(dropEchoedMic([]), [])
})

test('store: the headcount is per meeting, survives a rename, and can be cleared', async () => {
  const root = join(tmpdir(), `count-test-${process.pid}`)
  const { id, dir } = await createMeetingDir('sprint planning', new Date(2026, 7, 27, 14, 0), root)

  assert.equal((await readMeta(dir))?.speakerCount, undefined, 'unknown until someone says')

  await setSpeakerCount(id, 4, root)
  assert.equal((await readMeta(dir))?.speakerCount, 4)

  // Renaming must not quietly drop it — both write the same file.
  await setMeetingTitle(id, 'retro', root)
  const renamed = await readMeta(dir)
  assert.equal(renamed?.title, 'retro')
  assert.equal(renamed?.speakerCount, 4)

  // Cleared back to "let clustering decide" — the key goes, rather than becoming a 0
  // that reads as a real answer of nobody.
  await setSpeakerCount(id, null, root)
  assert.equal('speakerCount' in (await readMeta(dir))!, false)
  await setSpeakerCount(id, 6, root)
  await setSpeakerCount(id, 0, root)
  assert.equal('speakerCount' in (await readMeta(dir))!, false, '0 is not a headcount')
})
