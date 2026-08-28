import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assignSpeakers, speakerNames, type SpeakerLabels, type Turn } from './diarize.ts'

const EN: SpeakerLabels = { me: 'You', them: 'Others', speaker: (n) => `Speaker ${n}` }

const seg = (t0: number, t1: number, speaker = 'them') => ({ t0, t1, speaker, text: `${t0}-${t1}` })
const turn = (start: number, end: number, speaker: number): Turn => ({ start, end, speaker })

test('merge: a segment takes the speaker it overlaps most', () => {
  const turns = [turn(0, 10, 0), turn(9, 20, 1)]
  // Straddles the boundary: 1s inside speaker 0, 4s inside speaker 1.
  const [only] = assignSpeakers([seg(8, 13)], turns)
  assert.equal(only!.speaker, 'SPEAKER_01')
})

test('merge: an exact tie keeps the earlier turn instead of flip-flopping', () => {
  const turns = [turn(0, 10, 0), turn(10, 20, 1)]
  const [only] = assignSpeakers([seg(5, 15)], turns)
  assert.equal(only!.speaker, 'SPEAKER_00')
})

test('merge: a segment overlapping nothing stays unattributed', () => {
  const turns = [turn(0, 10, 0)]
  const [gap] = assignSpeakers([seg(30, 35)], turns)
  assert.equal(gap!.speaker, 'them', 'better unattributed than attributed to whoever was nearest')
})

test('merge: the mic track is never reassigned', () => {
  // Spec §4.1: the mic track is us by construction, whatever the loopback turns say.
  const turns = [turn(0, 100, 3)]
  const [mine] = assignSpeakers([seg(10, 20, 'me')], turns)
  assert.equal(mine!.speaker, 'me')
})

test('speaker names: placeholders follow first appearance, typed names survive', () => {
  const segments = [
    seg(0, 5, 'SPEAKER_01'),
    seg(5, 9, 'me'),
    seg(9, 12, 'SPEAKER_00'),
    seg(12, 15, 'SPEAKER_01'),
  ]
  assert.deepEqual(speakerNames(segments, { me: 'You' }, EN), {
    me: 'You',
    SPEAKER_01: 'Speaker 1',
    SPEAKER_00: 'Speaker 2',
  })
  assert.deepEqual(speakerNames(segments, { me: 'ผม', SPEAKER_01: 'พี่โจ้' }, EN), {
    me: 'ผม',
    SPEAKER_01: 'พี่โจ้',
    SPEAKER_00: 'Speaker 1',
  })
})

test('speaker names: an unattributed segment keeps its own label', () => {
  assert.deepEqual(speakerNames([seg(0, 5)], {}, EN), { me: 'You', them: 'Others' })
})

test('speaker names (HIGH 3): a key previously tied to a recognised voice does not blindly keep that name', () => {
  const segments = [seg(0, 5, 'SPEAKER_00')]
  // Last pass: SPEAKER_00 was recognised as Alice, and speakerVoices recorded that.
  // This pass reclustered the same raw key onto someone identify() has not yet
  // checked — the stale name must not be trusted as a placeholder before that check
  // even runs, or a wrong name can outlive identify() disagreeing with it.
  const named = speakerNames(segments, { SPEAKER_00: 'Alice' }, EN, { SPEAKER_00: { voiceId: 'v1', name: 'Alice' } })
  assert.equal(named['SPEAKER_00'], 'Speaker 1', 'must fall back to a neutral placeholder, not the stale name')
})

test('speaker names: an untracked (manually typed) name is still kept — only voice-tracked keys are distrusted', () => {
  const segments = [seg(0, 5, 'SPEAKER_00')]
  // No speakerVoices entry for this key at all (e.g. typed by hand after remember()
  // itself failed) — nothing this pass can confirm or refute about it, so the
  // existing "keeps names the user already typed" behaviour must survive.
  const named = speakerNames(segments, { SPEAKER_00: 'Bob' }, EN)
  assert.equal(named['SPEAKER_00'], 'Bob')
})
