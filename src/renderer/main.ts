import type { McpState, Provider, ProviderInfo, Settings, Transcript } from '../preload/index.ts'
import { Recorder, type Track } from './recorder.ts'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const title = $<HTMLInputElement>('title')
const toggle = $<HTMLButtonElement>('toggle')
const elapsed = $('elapsed')
const warnings = $('warnings')
const done = $('done')
const queue = $('queue')
const speakerPanel = $('speakers')
const transcript = $('transcript')
const summaryBar = $('summarybar')
const summaryOut = $('summary')
const apiKeyInput = $<HTMLInputElement>('apikey')
const saveKeyButton = $<HTMLButtonElement>('savekey')
const keyState = $('keystate')
const providerSelect = $<HTMLSelectElement>('provider')
const modelInput = $<HTMLInputElement>('model')
const mcpToggle = $<HTMLInputElement>('mcp')
const mcpStateEl = $('mcpstate')
const tunnelToggle = $<HTMLInputElement>('tunnel')
const tunnelStateEl = $('tunnelstate')
const meters: Record<Track, HTMLElement> = { loopback: $('m-loopback'), mic: $('m-mic') }

let recorder: Recorder | null = null
let ticker: number | undefined

/**
 * During the meeting a segment is only ever "us" or "them" (spec §4.2); diarization
 * replaces the `them` half with real speakers once the recording is complete.
 */
let segments: Transcript['segments'] = []
let speakers: Record<string, string> = { me: 'คุณ', them: 'คนอื่น' }
let meetingDir: string | null = null

/** Claude is the default (spec §3); the rest are one dropdown away. */
let settings: Settings = { provider: 'claude', models: {}, mcp: false, tunnel: false }
let providers: Record<Provider, ProviderInfo> | null = null
const current = (): ProviderInfo => providers?.[settings.provider] ?? { label: settings.provider, model: '', price: [0, 0] }

const PERMISSION_LABEL = {
  screen: ['Screen Recording', 'ต้องมีเพื่ออัดเสียงระบบ (เสียงคนอื่นในที่ประชุม)'],
  microphone: ['Microphone', 'ต้องมีเพื่ออัดเสียงเรา'],
} as const

/**
 * macOS has no not-determined state for Screen Recording — never-granted reads back
 * as "denied". So at launch we only speak up about the mic, which does distinguish
 * the two; the screen box appears once a capture attempt has actually failed.
 */
async function showPermissionWarnings(includeScreen = false): Promise<void> {
  const status = await window.api.permissions()
  warnings.replaceChildren()
  for (const which of includeScreen ? (['screen', 'microphone'] as const) : (['microphone'] as const)) {
    if (status[which] === 'granted') continue
    const [name, why] = PERMISSION_LABEL[which]
    const box = document.createElement('div')
    box.className = 'warn'
    box.textContent = `ยังไม่ได้สิทธิ์ ${name} (${status[which]}) — ${why}`
    const open = document.createElement('button')
    open.textContent = 'เปิด System Settings'
    open.onclick = () => window.api.openPrivacySettings(which)
    box.append(document.createElement('br'), open)
    warnings.append(box)
  }
}

function fmt(sec: number): string {
  const p = (n: number) => String(Math.floor(n)).padStart(2, '0')
  return `${p(sec / 60)}:${p(sec % 60)}`
}

function renderTranscript(): void {
  transcript.replaceChildren(
    ...segments.map((s) => {
      const row = document.createElement('p')
      if (s.speaker === 'me') row.className = 'me'
      const at = document.createElement('span')
      at.className = 't'
      at.textContent = fmt(s.t0)
      const who = document.createElement('span')
      who.className = 'who'
      who.textContent = speakers[s.speaker] ?? s.speaker
      const text = document.createElement('span')
      text.textContent = s.text
      row.append(at, who, text)
      return row
    }),
  )
  transcript.scrollTop = transcript.scrollHeight
}

function renderSpeakerPanel(): void {
  speakerPanel.replaceChildren()
  if (!meetingDir) return

  const inputs = new Map<string, HTMLInputElement>()
  for (const label of Object.keys(speakers)) {
    const row = document.createElement('div')
    row.className = 'who'
    const tag = document.createElement('code')
    tag.textContent = label
    const input = document.createElement('input')
    input.value = speakers[label] ?? label
    input.oninput = () => {
      speakers[label] = input.value
      renderTranscript()
    }
    inputs.set(label, input)
    row.append(tag, input)
    speakerPanel.append(row)
  }

  const save = document.createElement('button')
  save.textContent = 'บันทึกชื่อ'
  save.onclick = async () => {
    if (!meetingDir) return
    save.disabled = true
    const named = Object.fromEntries(
      [...inputs].map(([label, input]) => [label, input.value.trim() || label]),
    )
    speakers = (await window.api.renameSpeakers(meetingDir, named)).speakers
    save.disabled = false
    save.textContent = 'บันทึกแล้ว'
  }

  const hint = document.createElement('div')
  hint.className = 'hint'
  hint.textContent = 'ถ้าแยกคนพูดผิด ตั้งชื่อเดียวกันให้สองคน = รวมเป็นคนเดียว'
  speakerPanel.append(save, hint)
}

const usd = (n: number) => `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`

async function renderSummaryBar(): Promise<void> {
  summaryBar.replaceChildren()
  if (!meetingDir) return

  const run = document.createElement('button')
  run.textContent = 'สรุปด้วย Claude'
  const note = document.createElement('span')
  note.className = 'hint'
  summaryBar.append(run, note)

  run.textContent = `สรุปด้วย ${current().label}`
  if (!(await window.api.hasKey(settings.provider))) {
    run.disabled = true
    note.textContent = `ต้องใส่ API key ของ ${current().label} ในหน้าตั้งค่าก่อน`
    return
  }

  const dir = meetingDir
  // Priced from the real transcript before spending anything (spec §9). Only Claude
  // can do that; the others report what the run actually cost.
  window.api
    .estimateSummary(dir)
    .then((c) => {
      note.textContent = c
        ? `~${c.inputTokens.toLocaleString()} token เข้า ≈ ${usd(c.usd)}`
        : 'รู้ราคาหลังสรุปเสร็จ'
    })
    .catch(() => {})

  run.onclick = async () => {
    run.disabled = true
    run.textContent = 'กำลังสรุป…'
    summaryOut.textContent = ''
    try {
      const cost = await window.api.runSummary(dir)
      note.textContent = `${cost.inputTokens.toLocaleString()} เข้า / ${cost.outputTokens.toLocaleString()} ออก · ${usd(cost.usd)} · เขียนลง summary.md แล้ว`
    } catch (err) {
      note.textContent = `สรุปไม่สำเร็จ: ${err instanceof Error ? err.message : String(err)}`
    } finally {
      run.disabled = false
      run.textContent = `สรุปอีกครั้งด้วย ${current().label}`
    }
  }
}

async function showKeyState(): Promise<void> {
  const { label } = current()
  keyState.textContent = (await window.api.hasKey(settings.provider))
    ? `มี API key ของ ${label} แล้ว (เก็บเข้ารหัสไว้ในเครื่อง ไม่เคยส่งเข้าหน้าจอ)`
    : `ยังไม่มี API key ของ ${label} — ใส่ของคุณเองเพื่อใช้สรุป`
}

/** Blank model means "whatever this provider currently ships" — the placeholder shows it. */
function syncProviderFields(): void {
  modelInput.value = settings.models[settings.provider] ?? ''
  modelInput.placeholder = current().model
  apiKeyInput.placeholder = `${current().label} API key`
  void showKeyState()
}

function showMcpState(state: McpState): void {
  mcpToggle.checked = state.enabled
  tunnelToggle.checked = state.tunnelOn
  tunnelToggle.disabled = !state.enabled

  mcpStateEl.replaceChildren()
  if (state.url && state.token) {
    const url = document.createElement('div')
    url.append('URL: ', code(state.url))
    const token = document.createElement('div')
    token.append('Bearer token: ', code(state.token))
    mcpStateEl.append(url, token)
  }

  tunnelStateEl.className = state.tunnelOn ? 'danger' : ''
  tunnelStateEl.replaceChildren()
  if (state.tunnelUrl) {
    tunnelStateEl.append('⚠️ transcript เข้าถึงได้จากอินเทอร์เน็ตแล้ว: ', code(state.tunnelUrl))
  } else if (state.enabled) {
    tunnelStateEl.textContent = 'ปิดอยู่ — cloud client อย่าง ChatGPT/Grok ต่อ localhost ไม่ได้ เปิดเมื่อไหร่เท่ากับ transcript ออกอินเทอร์เน็ต'
  }
}

const code = (text: string) => {
  const el = document.createElement('code')
  el.textContent = text
  return el
}

async function loadSettings(): Promise<void> {
  ;[settings, providers] = await Promise.all([window.api.getSettings(), window.api.providers()])
  providerSelect.replaceChildren(
    ...Object.entries(providers).map(([id, info]) => {
      const option = document.createElement('option')
      option.value = id
      option.textContent = info.label
      return option
    }),
  )
  providerSelect.value = settings.provider
  syncProviderFields()
  showMcpState(await window.api.mcpState())
}

function setLevel(track: Track, rms: number): void {
  // sqrt curve: speech sits low on a linear scale and the bar would look dead.
  meters[track].style.width = `${Math.min(100, Math.sqrt(rms) * 180)}%`
}

async function start(): Promise<void> {
  done.replaceChildren()
  speakerPanel.replaceChildren()
  summaryBar.replaceChildren()
  summaryOut.textContent = ''
  transcript.replaceChildren()
  segments = []
  speakers = { me: 'คุณ', them: 'คนอื่น' }
  meetingDir = null
  await window.api.requestPermissions()
  toggle.disabled = true
  try {
    const started = await Recorder.start(title.value, {
      onLevel: setLevel,
      onTrackLost: (track) => {
        warnings.textContent = `${track} track หยุดกลางคัน — กดหยุดแล้วเริ่มใหม่`
      },
    })
    recorder = started.recorder
  } catch (err) {
    await showPermissionWarnings(true)
    warnings.prepend(`เริ่มอัดไม่ได้: ${err instanceof Error ? err.message : String(err)}`)
    return
  } finally {
    toggle.disabled = false
  }

  const t0 = Date.now()
  ticker = window.setInterval(() => (elapsed.textContent = fmt((Date.now() - t0) / 1000)), 500)
  toggle.textContent = 'จบประชุม'
  title.disabled = true
  warnings.replaceChildren()
}

async function stop(): Promise<void> {
  const r = recorder
  recorder = null
  clearInterval(ticker)
  toggle.disabled = true
  // stop() only resolves once the queued tail chunks have come back and the
  // transcript is on disk, which can take a chunk or two.
  done.textContent = 'กำลังถอดเสียงส่วนที่เหลือ…'
  const result = await r?.stop()
  toggle.disabled = false
  toggle.textContent = 'เริ่มอัด'
  title.disabled = false
  elapsed.textContent = ''
  for (const track of ['loopback', 'mic'] as const) setLevel(track, 0)
  if (!result) {
    done.replaceChildren()
    return
  }

  meetingDir = result.dir
  done.textContent = `บันทึกแล้ว ${fmt(result.durationSec)} · ${result.segments} ท่อน — `
  const open = document.createElement('a')
  open.href = '#'
  open.textContent = result.id
  open.onclick = () => void window.api.reveal(result.dir)
  done.append(open)
  void renderSummaryBar()
}

window.api.onSegments((track, incoming) => {
  segments.push(...incoming.map((s) => ({ ...s, speaker: track === 'mic' ? 'me' : 'them' })))
  segments.sort((a, b) => a.t0 - b.t0)
  renderTranscript()
})
window.api.onQueue((depth) => {
  // Nothing is dropped; a deep queue just means the transcript lags further behind.
  queue.textContent = depth > 3 ? `ถอดเสียงตามไม่ทัน — ค้างอยู่ ${depth} ท่อน` : ''
})
window.api.onTranscriptError((message) => {
  warnings.textContent = `whisper-server ไม่ขึ้น: ${message}`
})

window.api.onDiarizing(() => {
  queue.textContent = 'กำลังแยกว่าใครพูด…'
})
window.api.onDiarized((dir, updated) => {
  queue.textContent = ''
  meetingDir = dir
  segments = updated.segments
  speakers = updated.speakers
  renderTranscript()
  renderSpeakerPanel()
  void renderSummaryBar()
})
window.api.onDiarizeError((message) => {
  queue.textContent = ''
  warnings.textContent = `แยกคนพูดไม่สำเร็จ: ${message} (transcript ยังอยู่ครบ)`
})

window.api.onSummaryDelta((text) => {
  summaryOut.textContent += text
  summaryOut.scrollTop = summaryOut.scrollHeight
})

async function flip(el: HTMLInputElement, status: HTMLElement, run: () => Promise<McpState>): Promise<void> {
  el.disabled = true
  try {
    showMcpState(await run())
  } catch (err) {
    el.checked = !el.checked
    status.textContent = err instanceof Error ? err.message : String(err)
  } finally {
    el.disabled = false
  }
}

mcpToggle.onchange = () => void flip(mcpToggle, mcpStateEl, () => window.api.toggleMcp(mcpToggle.checked))
tunnelToggle.onchange = () => {
  if (tunnelToggle.checked) tunnelStateEl.textContent = 'กำลังเปิด tunnel…'
  void flip(tunnelToggle, tunnelStateEl, () => window.api.toggleTunnel(tunnelToggle.checked))
}

providerSelect.onchange = async () => {
  settings = await window.api.setSettings({ provider: providerSelect.value as Provider })
  syncProviderFields()
  await renderSummaryBar()
}

modelInput.onchange = async () => {
  settings = await window.api.setSettings({
    models: { ...settings.models, [settings.provider]: modelInput.value.trim() },
  })
  await renderSummaryBar()
}

saveKeyButton.onclick = async () => {
  saveKeyButton.disabled = true
  try {
    await window.api.setKey(settings.provider, apiKeyInput.value)
    apiKeyInput.value = ''
    await showKeyState()
    await renderSummaryBar()
  } catch (err) {
    keyState.textContent = err instanceof Error ? err.message : String(err)
  } finally {
    saveKeyButton.disabled = false
  }
}

toggle.onclick = () => void (recorder ? stop() : start())
void showPermissionWarnings()
void loadSettings()
