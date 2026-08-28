import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext } from 'node:vm'

/**
 * The browser extension's detector, run against stand-ins for the two things it patches.
 *
 * It cannot be exercised any other way from here — it only ever runs inside a meeting
 * page, in the page's own JavaScript world — and it is the piece most worth pinning
 * down: it decides when this app's microphone follows the meeting's, and it does it by
 * rewriting a prototype accessor that every WebRTC site depends on. A patch that
 * reports the wrong thing mutes a recording nobody asked to mute; one that breaks
 * `enabled` breaks the meeting itself.
 */
const EXT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'extension')

type FakeTrack = { kind: string; readyState: string; enabled: boolean; stop: () => void; addEventListener: (e: string, fn: () => void) => void }

/** A page with a MediaStreamTrack prototype shaped like the real one — `enabled` as an
 * accessor on the prototype, `stop()` as a method — and a getUserMedia to hand them out. */
async function loadDetector(): Promise<{
  posted: { muted: boolean }[]
  getUserMedia: () => Promise<{ getAudioTracks: () => FakeTrack[] }>
}> {
  const source = await readFile(join(EXT, 'detector.js'), 'utf8')
  const posted: { muted: boolean }[] = []

  class MediaStreamTrack {
    kind = 'audio'
    readyState = 'live'
    private on: Record<string, (() => void)[]> = {}
    private _enabled = true
    get enabled(): boolean {
      return this._enabled
    }
    set enabled(value: boolean) {
      this._enabled = value
    }
    stop(): void {
      this.readyState = 'ended'
    }
    addEventListener(event: string, fn: () => void): void {
      ;(this.on[event] ??= []).push(fn)
    }
  }

  const make = (): FakeTrack => new MediaStreamTrack() as unknown as FakeTrack
  const context = {
    MediaStreamTrack,
    navigator: {
      mediaDevices: {
        getUserMedia: async () => {
          const tracks = [make()]
          return { getAudioTracks: () => tracks }
        },
      },
    },
    window: {
      origin: 'https://meet.google.com',
      postMessage: (message: { source: string; muted: boolean }) => {
        if (message.source === 'meeting-inspector-mic') posted.push({ muted: message.muted })
      },
    },
  }
  createContext(context)
  runInContext(source, context)
  return { posted, getUserMedia: context.navigator.mediaDevices.getUserMedia }
}

test('extension: a muted microphone is reported once, and unmuting is reported once', async () => {
  const { posted, getUserMedia } = await loadDetector()
  const [track] = (await getUserMedia()).getAudioTracks()
  assert.ok(track)

  // Opening the microphone is not muting it — an unmuted call must not arrive as one.
  assert.deepEqual(posted, [{ muted: false }])

  track.enabled = false
  assert.deepEqual(posted, [{ muted: false }, { muted: true }])

  // Setting the same value again is not a change, and this fires on every mute button
  // press some sites make on every keystroke of a push-to-talk key.
  track.enabled = false
  assert.equal(posted.length, 2, 'only changes are reported')

  track.enabled = true
  assert.deepEqual(posted.at(-1), { muted: false })
})

test('extension: the patched `enabled` still does what the page asked it to', async () => {
  const { getUserMedia } = await loadDetector()
  const [track] = (await getUserMedia()).getAudioTracks()
  assert.ok(track)
  // The meeting mutes itself through this setter. Reporting the value while failing to
  // set it would leave the user talking into a call that thinks it is muted.
  track.enabled = false
  assert.equal(track.enabled, false)
  track.enabled = true
  assert.equal(track.enabled, true)
})

test('extension: a call that ends does not read as the user muting themselves', async () => {
  const { posted, getUserMedia } = await loadDetector()
  const [track] = (await getUserMedia()).getAudioTracks()
  assert.ok(track)
  track.stop()
  assert.equal(track.readyState, 'ended', 'stop() must still stop the track')
  // The tempting reading is "the microphone stopped, so they are muted". It is wrong,
  // and wrong in the expensive direction: every call ends by ending its tracks, so it
  // would mute this app's recording at the end of every meeting. Missing a site that
  // mutes by stopping the track is the cheaper mistake — nothing happens.
  assert.deepEqual(posted.at(-1), { muted: false })
})

test('extension: no microphone open at all is not "muted"', async () => {
  // Before the call and after it, this app must be left alone rather than told to mute
  // a recording the meeting has nothing to do with.
  const { posted } = await loadDetector()
  assert.deepEqual(posted, [])
})
