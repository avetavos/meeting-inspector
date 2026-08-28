/*
 * The only thing that talks to Meeting Inspector.
 *
 * One POST per change, fire and forget. The app is on this machine, on loopback, and if
 * it is closed there is nothing to tell — a failed request means the meeting is being
 * held without it, which is not an error worth surfacing on a page the user is trying
 * to talk in.
 */
async function post(muted) {
  const { port = 8787, token = '' } = await chrome.storage.local.get(['port', 'token'])
  if (!token) return
  await fetch(`http://127.0.0.1:${port}/mic`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ muted }),
  })
}

chrome.runtime.onMessage.addListener((message) => {
  if (typeof message?.muted === 'boolean') void post(message.muted).catch(() => {})
  // No response, and no `return true`: nothing is waiting for one.
})
