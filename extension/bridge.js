/*
 * Carries detector.js's finding from the page's world into the extension's.
 *
 * The detector cannot do this itself: it runs in the MAIN world so that it can patch
 * the page's own prototypes, and nothing there can see chrome.runtime. This file is the
 * other half of that trade — it has the APIs and none of the reach.
 */
window.addEventListener('message', (event) => {
  if (event.source !== window) return
  const data = event.data
  if (!data || data.source !== 'meeting-inspector-mic' || typeof data.muted !== 'boolean') return
  // The worker may be asleep; waking it is the point, and a failure here is not worth
  // anything more than being dropped — the next toggle will try again.
  chrome.runtime.sendMessage({ muted: data.muted }).catch(() => {})
})
