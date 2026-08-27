import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  createMeetingDir,
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

test('createMeetingDir: two recordings in the same minute get different folders, never overwriting each other (MEDIUM 3)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'store-collision-test-'))
  const at = new Date(2026, 7, 27, 14, 0)

  const first = await createMeetingDir('daily standup', at, root)
  const second = await createMeetingDir('daily standup', at, root)
  const third = await createMeetingDir('daily standup', at, root)

  assert.equal(first.id, '2026-08-27-1400-daily-standup')
  assert.equal(second.id, '2026-08-27-1400-daily-standup-2')
  assert.equal(third.id, '2026-08-27-1400-daily-standup-3')
  assert.notEqual(first.dir, second.dir)
  assert.notEqual(second.dir, third.dir)
})

test('createMeetingDir: an untitled meeting (just the timestamp) collides the same way', async () => {
  const root = await mkdtemp(join(tmpdir(), 'store-collision-test-'))
  const at = new Date(2026, 7, 27, 14, 0)

  const first = await createMeetingDir('', at, root)
  const second = await createMeetingDir('', at, root)

  assert.equal(first.id, '2026-08-27-1400')
  assert.equal(second.id, '2026-08-27-1400-2')
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
