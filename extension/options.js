const $ = (id) => document.getElementById(id)
const state = $('state')

const show = (text, ok) => {
  state.textContent = text
  state.className = ok === undefined ? '' : ok ? 'ok' : 'bad'
}

chrome.storage.local.get(['token', 'port']).then(({ token = '', port = 8787 }) => {
  $('token').value = token
  $('port').value = port
})

$('save').addEventListener('click', async () => {
  const port = Number($('port').value)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return show('port ต้องเป็นตัวเลข 1024–65535', false)
  await chrome.storage.local.set({ token: $('token').value.trim(), port })
  show('บันทึกแล้ว', true)
})

/*
 * Muting and unmuting is the test, because there is nothing to read back: the endpoint
 * takes a boolean and answers with it. Doing both leaves the app exactly as it was.
 */
$('test').addEventListener('click', async () => {
  const { token = '', port = 8787 } = await chrome.storage.local.get(['token', 'port'])
  if (!token) return show('ยังไม่ได้ใส่ token', false)
  show('กำลังทดสอบ…')
  try {
    for (const muted of [true, false]) {
      const res = await fetch(`http://127.0.0.1:${port}/mic`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ muted }),
      })
      if (!res.ok) return show(res.status === 401 ? 'token ไม่ถูก' : `แอปตอบ ${res.status}`, false)
    }
    show('ถึงแอปแล้ว — ถ้ากำลังอัดอยู่จะเห็นไมค์กะพริบปิดแล้วเปิด', true)
  } catch {
    show('ต่อไม่ได้ — เปิดแอปไว้ไหม และเปิดเซิร์ฟเวอร์ MCP หรือยัง', false)
  }
})
