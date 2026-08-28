/*
 * Watches the page's own microphone track, in the page's own JavaScript world.
 *
 * Deliberately not "find the mute button and read it". Every meeting site has a
 * different button, moves it, and renames its attributes, and a selector that has to be
 * relearned per site and re-fixed per redesign is a maintenance promise this cannot
 * keep. What every one of them has in common is the standard way to mute a WebRTC call:
 * take the track getUserMedia handed you and set `enabled = false`. Patching that is one
 * piece of code that works on Meet, Zoom and Teams without knowing anything about them.
 *
 * MAIN world because that is where the page's MediaStreamTrack lives — an isolated
 * content script has its own copy of every prototype and would patch nothing. That also
 * means no chrome.* APIs here, so the result goes out by postMessage for bridge.js.
 */
;(() => {
  const TAG = 'meeting-inspector-mic'

  /** The tracks the page asked the user for — its microphone. Everything else on the
   * call is somebody else's audio arriving over the network, and muting them is not
   * what this is about. */
  const mine = new Set()
  let last = null

  function report() {
    for (const track of [...mine]) if (track.readyState === 'ended') mine.delete(track)
    // No microphone open at all reads as "nothing to say", not as muted: before the
    // call starts and after it ends, this app should be left alone.
    const muted = mine.size > 0 && [...mine].every((track) => !track.enabled)
    if (muted === last) return
    last = muted
    window.postMessage({ source: TAG, muted }, window.origin)
  }

  const media = navigator.mediaDevices
  if (media && typeof media.getUserMedia === 'function') {
    const original = media.getUserMedia.bind(media)
    media.getUserMedia = async function (constraints) {
      const stream = await original(constraints)
      for (const track of stream.getAudioTracks()) {
        mine.add(track)
        track.addEventListener('ended', report)
      }
      report()
      return stream
    }
  }

  // `enabled` is an accessor on the prototype, so one patch covers every track the page
  // will ever have — including the ones created before this ran.
  const enabled = Object.getOwnPropertyDescriptor(MediaStreamTrack.prototype, 'enabled')
  if (enabled && enabled.set) {
    Object.defineProperty(MediaStreamTrack.prototype, 'enabled', {
      ...enabled,
      set(value) {
        enabled.set.call(this, value)
        if (this.kind === 'audio') report()
      },
    })
  }

  // Ending a track re-runs the check, but an ended microphone is deliberately NOT
  // reported as muted: a call that has finished ends its tracks, and reading that as
  // "mute yourself" would mute this app's recording at the end of every meeting — a
  // wrong action, where the alternative is only a miss. A site that mutes by stopping
  // the track and re-acquiring on unmute is therefore not detected, which is the right
  // way round to be wrong. (Meet, Zoom and Teams all mute with `enabled = false`.)
  const stop = MediaStreamTrack.prototype.stop
  MediaStreamTrack.prototype.stop = function () {
    stop.call(this)
    if (this.kind === 'audio') report()
  }
})()
