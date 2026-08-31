import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clusteringFor, loopbackSpeakers, assignSpeakers, speakerNames, type SpeakerLabels, type Turn, foldBriefSpeakers } from './diarize.ts'

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

test('merge: re-running diarization re-labels segments a previous pass already labelled', () => {
  // The whole point of meeting:rediarize (index.ts) — telling diarization how many
  // people were actually in the room and splitting again. Skipping anything that was
  // not `them` made that a silent no-op: after one pass every loopback segment carries a
  // SPEAKER_xx, so the second pass returned all of them untouched and its clustering was
  // discarded.
  const turns = [turn(0, 10, 0), turn(10, 20, 1)]
  const again = assignSpeakers([seg(1, 5, 'SPEAKER_44'), seg(12, 18, 'SPEAKER_07'), seg(2, 4, 'me')], turns)
  assert.deepEqual(again.map((s) => s.speaker), ['SPEAKER_00', 'SPEAKER_01', 'me'])

  // And a segment the new clustering has no turn for goes back to unattributed rather
  // than keeping a key from the old one, which now means somebody else.
  const orphaned = assignSpeakers([seg(90, 95, 'SPEAKER_44')], turns)
  assert.equal(orphaned[0]!.speaker, 'them')
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

test('diarize: a cough is not a speaker; a quiet person still is, barely', () => {
  const segments = [
    { t0: 0, t1: 8, speaker: 'SPEAKER_00', text: 'คนที่พูดจริง' },
    // A chair scrape diarization clustered on its own: 0.6s total across the meeting.
    { t0: 9.0, t1: 9.6, speaker: 'SPEAKER_28', text: 'อือ' },
    // Two short lines from one cluster that ADD UP past the floor — a genuinely quiet
    // person, kept. The floor is about the total, not any single line.
    { t0: 12.0, t1: 13.2, speaker: 'SPEAKER_30', text: 'ครับ' },
    { t0: 20.0, t1: 21.1, speaker: 'SPEAKER_30', text: 'เห็นด้วยครับ' },
    // Ours and the already-unattributed pass through untouched.
    { t0: 30, t1: 31, speaker: 'me', text: 'โอเค' },
    { t0: 32, t1: 32.5, speaker: 'them', text: '…' },
  ]
  const folded = foldBriefSpeakers(segments)
  assert.deepEqual(
    folded.map((s) => s.speaker),
    ['SPEAKER_00', 'them', 'SPEAKER_30', 'SPEAKER_30', 'me', 'them'],
  )
  // The noise line itself survives — it is attribution that changes, never text.
  assert.equal(folded[1]!.text, 'อือ')
})

test('diarize: a known headcount replaces the threshold guess entirely', () => {
  // The threshold ladder only exists because the headcount is unknown. Given one,
  // sherpa is told to produce exactly that many speakers — this is the whole fix for a
  // four-person meeting coming back as twenty-three.
  assert.deepEqual(clusteringFor(0.7, 4), { numClusters: 4, threshold: 0.7 })
  assert.deepEqual(clusteringFor(0.85, 1), { numClusters: 1, threshold: 0.85 })
  // A fractional count could only come from a mistyped field; floor it rather than hand
  // sherpa something it will interpret however it likes.
  assert.deepEqual(clusteringFor(0.7, 3.9), { numClusters: 3, threshold: 0.7 })

  // "I don't know" is a real answer and must go back to letting clustering decide —
  // -1 is sherpa's own sentinel for that, and only then does the threshold mean anything.
  for (const unknown of [undefined, null, 0]) {
    assert.deepEqual(clusteringFor(0.7, unknown), { numClusters: -1, threshold: 0.7 }, `${unknown}`)
  }
})

test('diarize: the headcount counts the user, the loopback track does not', () => {
  // Clustering runs on loopback.wav alone, and the user's own voice is not in it (their
  // microphone is a separate track, `me` by construction) — so a four-person meeting is
  // three voices to split. Asking sherpa for 4 asks it to find someone who is not there.
  assert.equal(loopbackSpeakers(4), 3)
  assert.equal(loopbackSpeakers(2), 1)
  assert.equal(loopbackSpeakers(12.7), 11, 'a mistyped fraction floors rather than reaching sherpa')

  // A meeting of one is the user alone: nothing on the loopback track to split, so back
  // to letting clustering decide rather than asking for zero speakers.
  for (const none of [1, 0, null, undefined]) {
    assert.equal(loopbackSpeakers(none), null, `${none}`)
  }

  // And that null is exactly what clusteringFor reads as "decide for yourself".
  assert.deepEqual(clusteringFor(0.7, loopbackSpeakers(1)), { numClusters: -1, threshold: 0.7 })
  assert.deepEqual(clusteringFor(0.7, loopbackSpeakers(4)), { numClusters: 3, threshold: 0.7 })
})
