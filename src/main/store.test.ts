import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  createMeetingDir,
  finishReplayTranscript,
  listMeetings,
  meetingDone,
  micTestLocked,
  resolveLanguage,
  transcribeStatus,
  transcriptionBusy,
  writeTranscript,
  type Transcript,
} from './store.ts'

const base: Transcript = {
  id: 'x',
  startedAt: '2026-08-27T14:00:00+07:00',
  durationSec: 60,
  speakers: { me: 'You' },
  segments: [],
}

test('meetingDone: no transcript at all is not done', () => {
  assert.equal(meetingDone(null), false)
})

test('meetingDone: transcribedAt set is done, even with zero segments (nobody spoke)', () => {
  assert.equal(meetingDone({ ...base, segments: [], transcribedAt: '2026-08-27T14:10:00+07:00' }), true)
})

test('meetingDone: no transcribedAt and no segments is not transcribed yet', () => {
  // 'manual' mode's transcript, written at session:stop, before the user runs it.
  assert.equal(meetingDone({ ...base, segments: [] }), false)
})

test('meetingDone: a pre-existing transcript (no transcribedAt field) with segments reads as done', () => {
  // Written before `transcribedAt` existed — spec item 2: no migration step, so this
  // has to be inferred from the segments it does have.
  const legacy = { ...base, segments: [{ t0: 0, t1: 1, speaker: 'me', text: 'hi' }] } as Transcript
  assert.equal(meetingDone(legacy), true)
})

test('meetingDone (HIGH 1): a modern write that withheld transcribedAt on purpose reads as NOT done, even with segments', () => {
  // Mirrors exactly what finishSessionStop (index.ts) writes for a 'live'/'after' pass
  // that lost chunks: the successful segments it did get through are kept (pushed live
  // via onSegments as each chunk succeeded), `language` is always set (Transcript's own
  // doc comment — written unconditionally on every modern path), and `transcribedAt` is
  // withheld because transcribeOk was false. Same shape as the "legacy" transcript
  // above (segments, no transcribedAt) except for `language` — that is the one thing
  // that must tell them apart, or this reads as falsely "Done" forever.
  const failedPass: Transcript = {
    ...base,
    language: 'th',
    segments: [{ t0: 0, t1: 1, speaker: 'them', text: 'partial before the chunk that failed' }],
  }
  assert.equal(meetingDone(failedPass), false)
})

test('finishReplayTranscript (HIGH 2): no audio found throws rather than silently wiping an existing transcript', () => {
  const previous: Transcript = {
    ...base,
    language: 'en',
    transcribedAt: '2026-08-01T09:00:00+07:00',
    segments: [{ t0: 0, t1: 1, speaker: 'me', text: 'real content from an earlier successful pass' }],
  }
  // total === 0: transcribeRecorded found neither track had anything (both WAVs
  // missing or empty — e.g. deleted to reclaim disk after that earlier pass).
  assert.throws(() => finishReplayTranscript(previous, [], 'en', 0))
})

test('finishReplayTranscript: a successful pass stamps transcribedAt and replaces segments/language', () => {
  const previous: Transcript = { ...base, language: 'th' }
  const collected = [{ t0: 0, t1: 2, speaker: 'me', text: 'hi' }]
  const updated = finishReplayTranscript(previous, collected, 'en', 1000)
  assert.equal(updated.segments, collected)
  assert.equal(updated.language, 'en')
  assert.ok(updated.transcribedAt)
})

test('resolveLanguage: a meeting with its own recorded language uses that, not the fallback', () => {
  // The core regression this whole feature exists to fix (spec item 1): a meeting
  // recorded in English must decode as English even if the setting has since flipped
  // back to Thai by the time it is retroactively transcribed.
  assert.equal(resolveLanguage('en', 'th'), 'en')
})

test('resolveLanguage: a meeting that predates the field falls back to the given current setting', () => {
  assert.equal(resolveLanguage(undefined, 'th'), 'th')
  assert.equal(resolveLanguage(null, 'en'), 'en')
})

test('transcriptionBusy: a live recording or a running batch locks a pass-disturbing setting', () => {
  assert.equal(transcriptionBusy(true, false), true)
  assert.equal(transcriptionBusy(false, true), true)
  assert.equal(transcriptionBusy(true, true), true)
  assert.equal(transcriptionBusy(false, false), false)
})

test('micTestLocked: refuses during a non-live recording or a batch, allows during live or idle', () => {
  assert.equal(micTestLocked('after', false), true)
  assert.equal(micTestLocked('manual', false), true)
  assert.equal(micTestLocked(null, true), true, 'a batch pass locks it even with nothing recording')
  assert.equal(micTestLocked('live', false), false, 'live mode already hits the same server this way')
  assert.equal(micTestLocked(null, false), false, 'nothing running at all')
})

test('transcribeStatus: running wins over everything else', () => {
  assert.equal(transcribeStatus(true, true, true), 'transcribing')
})

test('transcribeStatus: done, failed, and not-transcribed', () => {
  assert.equal(transcribeStatus(true, false, false), 'done')
  assert.equal(transcribeStatus(false, false, true), 'failed')
  assert.equal(transcribeStatus(false, false, false), 'not-transcribed')
  // A meeting that finished successfully is done even if it carries a stale failed
  // flag from an earlier attempt — the caller is expected to clear that flag on
  // success, but the derivation itself should not let a stale flag override reality.
  assert.equal(transcribeStatus(true, false, true), 'done')
})

test('writeTranscript: segments are sorted by t0 regardless of input order', async () => {
  // The single place segment order is now enforced — index.ts used to also sort at
  // session:stop and transcribeOne, redundantly (chunker.test.ts had a tautological
  // test standing in for this instead of a real one), so this is what backs removing
  // those.
  const root = await mkdtemp(join(tmpdir(), 'store-sort-test-'))
  const dir = join(root, 'unsorted')
  await mkdir(dir, { recursive: true })
  const segments = [
    { t0: 10, t1: 11, speaker: 'me', text: 'second' },
    { t0: 0, t1: 1, speaker: 'me', text: 'first' },
  ]
  await writeTranscript(dir, { ...base, id: 'unsorted', segments })

  const written = JSON.parse(await readFile(join(dir, 'transcript.json'), 'utf8')) as Transcript
  assert.deepEqual(written.segments.map((s) => s.text), ['first', 'second'])
})

test('listMeetings: a folder whose transcript.json is missing or corrupt is not hidden', async () => {
  const root = await mkdtemp(join(tmpdir(), 'store-test-'))

  const good = join(root, '2026-08-27-1400-sprint-planning')
  await mkdir(good, { recursive: true })
  await writeTranscript(good, { ...base, id: 'good', segments: [{ t0: 0, t1: 1, speaker: 'me', text: 'hi' }] })

  // No transcript.json at all — e.g. a recording that crashed before it ever wrote one.
  const missing = join(root, '2026-08-20-1000-crashed')
  await mkdir(missing, { recursive: true })

  // transcript.json present but not valid JSON.
  const corrupt = join(root, '2026-08-15-0900-corrupt')
  await mkdir(corrupt, { recursive: true })
  await writeFile(join(corrupt, 'transcript.json'), '{not json')

  const items = await listMeetings(root)
  assert.deepEqual(
    items.map((m) => m.id).sort(),
    ['2026-08-15-0900-corrupt', '2026-08-20-1000-crashed', '2026-08-27-1400-sprint-planning'],
  )

  const missingItem = items.find((m) => m.id === '2026-08-20-1000-crashed')!
  assert.equal(missingItem.transcribed, false)
  // Falls back to the id's own timestamp rather than an empty string, so it still
  // sorts and displays something.
  assert.equal(missingItem.startedAt, '2026-08-20T10:00:00')

  const corruptItem = items.find((m) => m.id === '2026-08-15-0900-corrupt')!
  assert.equal(corruptItem.transcribed, false)

  const goodItem = items.find((m) => m.id === '2026-08-27-1400-sprint-planning')!
  assert.equal(goodItem.transcribed, true)

  // Newest first.
  assert.deepEqual(
    items.map((m) => m.id),
    ['2026-08-27-1400-sprint-planning', '2026-08-20-1000-crashed', '2026-08-15-0900-corrupt'],
  )
})

test('listMeetings: sorts by the transcript\'s own startedAt, never by folder name (spec item b)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'store-sort-order-test-'))
  // Folder names sort the opposite way from their real recording time — a renamed or
  // hand-created folder must not be able to reorder the list.
  const aaa = join(root, 'aaa-renamed-folder')
  await mkdir(aaa, { recursive: true })
  await writeTranscript(aaa, { ...base, id: 'aaa', startedAt: '2026-08-10T09:00:00+07:00' })

  const zzz = join(root, 'zzz-actually-newest')
  await mkdir(zzz, { recursive: true })
  await writeTranscript(zzz, { ...base, id: 'zzz', startedAt: '2026-08-27T09:00:00+07:00' })

  const middle = join(root, 'middle-meeting')
  await mkdir(middle, { recursive: true })
  await writeTranscript(middle, { ...base, id: 'middle', startedAt: '2026-08-20T09:00:00+07:00' })

  const items = await listMeetings(root)
  assert.deepEqual(items.map((m) => m.id), ['zzz-actually-newest', 'middle-meeting', 'aaa-renamed-folder'])
})

test('createMeetingDir: two recordings in the same minute get their own folders (MEDIUM 3)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'store-collision-test-'))
  const at = new Date(2026, 7, 27, 14, 0)

  // The old id had minute resolution, so this used to land all three in one folder and
  // the third recording's WavWriter truncated the first. A uuid carries 74 random bits
  // past the timestamp, so there is nothing left to collide.
  const dirs = new Set<string>()
  for (let n = 0; n < 3; n++) dirs.add((await createMeetingDir('daily standup', at, root)).dir)
  assert.equal(dirs.size, 3)

  // An untitled meeting is no different — the title was never part of the id.
  const untitled = new Set<string>()
  for (let n = 0; n < 2; n++) untitled.add((await createMeetingDir('', at, root)).dir)
  assert.equal(untitled.size, 2)
})

test('listMeetings: language is the meeting\'s own stored value, or null if it predates the field — left unresolved for the caller to fall back on', async () => {
  const root = await mkdtemp(join(tmpdir(), 'store-lang-test-'))

  const withLang = join(root, '2026-08-27-1400-english-standup')
  await mkdir(withLang, { recursive: true })
  await writeTranscript(withLang, { ...base, id: 'withLang', language: 'en' })

  const legacy = join(root, '2026-08-20-1000-before-the-field')
  await mkdir(legacy, { recursive: true })
  await writeTranscript(legacy, { ...base, id: 'legacy' })

  const items = await listMeetings(root)
  assert.equal(items.find((m) => m.id === '2026-08-27-1400-english-standup')?.language, 'en')
  assert.equal(items.find((m) => m.id === '2026-08-20-1000-before-the-field')?.language, null)
})
