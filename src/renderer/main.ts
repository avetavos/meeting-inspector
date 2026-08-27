import type { McpState, ModelStatus, Transcript } from '../preload/index.ts'
import { Recorder, type Track } from './recorder.ts'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

/** Electron prefixes every rejected invoke with its own plumbing; users do not need it. */
const reason = (err: unknown) =>
  (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': \w*Error: /, '')

const title = $<HTMLInputElement>('title')
const toggle = $<HTMLButtonElement>('toggle')
const elapsed = $('elapsed')
const warnings = $('warnings')
const done = $('done')
const queue = $('queue')
const speakerPanel = $('speakers')
const transcript = $('transcript')
const modelsEl = $('models')
const mcpToggle = $<HTMLInputElement>('mcp')
const mcpStateEl = $('mcpstate')
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

    // not-determined means macOS has never asked. Sending someone to System Settings
    // then is a dead end — an app only appears in that list once it has asked at
    // least once. So ask, and let the OS add us to the list.
    const canAsk = which === 'microphone' && status[which] === 'not-determined'
    const box = document.createElement('div')
    box.className = 'warn'
    box.textContent = canAsk ? `ยังไม่เคยขอสิทธิ์ ${name} — ${why}` : `ไม่ได้สิทธิ์ ${name} — ${why}`

    const action = document.createElement('button')
    action.textContent = canAsk ? `ขอสิทธิ์ ${name}` : 'เปิด System Settings'
    action.onclick = async () => {
      action.disabled = true
      if (canAsk) await window.api.requestPermissions()
      else await window.api.openPrivacySettings(which)
      await showPermissionWarnings(includeScreen)
    }
    box.append(document.createElement('br'), action)
    warnings.append(box)
  }
}

function fmt(sec: number): string {
  const p = (n: number) => String(Math.floor(n)).padStart(2, '0')
  return `${p(sec / 60)}:${p(sec % 60)}`
}

const size = (bytes: number) =>
  bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`

/**
 * Three gigabytes of models are fetched on first run rather than shipped in the
 * installer (spec §12). The app records fine without them; only transcription and
 * diarization wait, so this panel informs rather than blocks.
 */
const bars = new Map<string, { fill: HTMLElement; size: HTMLElement; total: number }>()

async function renderModels(note = ''): Promise<void> {
  const missing = (await window.api.modelStatus()).filter((m) => !m.present)
  modelsEl.replaceChildren()
  bars.clear()
  if (missing.length === 0) {
    if (note) modelsEl.textContent = note
    return
  }

  const box = document.createElement('div')
  box.className = 'warn'
  const total = missing.reduce((sum, m) => sum + m.bytes, 0)
  const resumable = missing.filter((m) => m.resumeFrom > 0)
  box.textContent =
    `ยังไม่มีโมเดล ${missing.length} ไฟล์ (${size(total)}) — อัดเสียงได้ แต่ยังถอดเสียงไม่ได้` +
    (resumable.length > 0
      ? ` · โหลดค้างไว้ ${size(resumable.reduce((s, m) => s + m.resumeFrom, 0))} จะโหลดต่อจากเดิม`
      : '')

  for (const spec of missing) box.append(modelRow(spec))

  const button = document.createElement('button')
  button.textContent = 'โหลดโมเดล'
  const cancel = document.createElement('button')
  cancel.textContent = 'ยกเลิก'
  cancel.hidden = true
  const status = document.createElement('div')
  status.className = 'hint'
  if (note) status.textContent = note

  button.onclick = async () => {
    button.hidden = true
    cancel.hidden = false
    status.textContent = 'กำลังโหลด…'
    let outcome: string
    try {
      outcome = (await window.api.downloadModels()).cancelled
        ? 'ยกเลิกแล้ว — ครั้งหน้าจะโหลดต่อจากเดิม'
        : 'โหลดครบแล้ว'
    } catch (err) {
      outcome = reason(err)
    }
    // Re-rendering replaces this panel, so the outcome has to be handed forward
    // rather than written into an element that is about to be thrown away.
    await renderModels(outcome)
  }
  cancel.onclick = () => void window.api.cancelModels()

  const row = document.createElement('div')
  row.className = 'row'
  row.append(button, cancel, status)
  box.append(row)
  modelsEl.append(box)
}

function modelRow(spec: ModelStatus): HTMLElement {
  const row = document.createElement('div')
  row.className = 'file'
  const name = document.createElement('span')
  name.textContent = spec.label
  const sizeEl = document.createElement('span')
  sizeEl.className = 'size'
  sizeEl.textContent = size(spec.bytes)
  const bar = document.createElement('span')
  bar.className = 'bar'
  const fill = document.createElement('i')
  fill.style.width = `${(spec.resumeFrom / spec.bytes) * 100}%`
  bar.append(fill)
  row.append(name, sizeEl, bar)
  bars.set(spec.file, { fill, size: sizeEl, total: spec.bytes })
  return row
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

function copyRow(label: string, value: string): HTMLElement {
  const row = document.createElement('div')
  row.className = 'copyrow'
  const name = document.createElement('span')
  name.textContent = `${label}: `
  const el = document.createElement('code')
  el.textContent = value
  const copy = document.createElement('button')
  copy.textContent = 'คัดลอก'
  copy.onclick = async () => {
    await navigator.clipboard.writeText(value)
    copy.textContent = 'คัดลอกแล้ว'
    setTimeout(() => (copy.textContent = 'คัดลอก'), 1500)
  }
  row.append(name, el, copy)
  return row
}

function showMcpState(state: McpState): void {
  mcpToggle.checked = state.enabled
  mcpStateEl.replaceChildren()
  if (state.portMoved) {
    const moved = document.createElement('div')
    moved.textContent = '⚠️ port 8787 ไม่ว่าง ต้องย้ายไป port อื่น — config ที่ตั้งไว้เดิมจะต่อไม่ติด ใช้บรรทัดข้างล่างตั้งใหม่'
    mcpStateEl.append(moved)
  }
  if (!state.url || !state.token) return

  mcpStateEl.append(
    copyRow('URL', state.url),
    copyRow('Bearer token', state.token),
    // Claude Code speaks HTTP and can send a header.
    copyRow(
      'Claude Code',
      `claude mcp add --scope user --transport http meeting-inspector ${state.url} --header "Authorization: Bearer ${state.token}"`,
    ),
    // Claude Desktop and ChatGPT Desktop load local servers over stdio, so they go
    // through a bridge. Token in the URL, which saves quoting a header inside JSON.
    copyRow(
      'Claude Desktop / ChatGPT Desktop',
      JSON.stringify({
        'meeting-inspector': { command: 'npx', args: ['-y', 'mcp-remote', `${state.url}${state.token}`] },
      }),
    ),
  )
}

function setLevel(track: Track, rms: number): void {
  // sqrt curve: speech sits low on a linear scale and the bar would look dead.
  meters[track].style.width = `${Math.min(100, Math.sqrt(rms) * 180)}%`
}

async function start(): Promise<void> {
  done.replaceChildren()
  speakerPanel.replaceChildren()
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
    warnings.prepend(`เริ่มอัดไม่ได้: ${reason(err)}`)
    return
  } finally {
    toggle.disabled = false
  }

  const t0 = Date.now()
  ticker = window.setInterval(() => (elapsed.textContent = fmt((Date.now() - t0) / 1000)), 500)
  toggle.textContent = 'จบประชุม'
  title.disabled = true
  warnings.replaceChildren()
  document.body.classList.add('recording')
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
  document.body.classList.remove('recording')
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
})
window.api.onDiarizeError((message) => {
  queue.textContent = ''
  warnings.textContent = `แยกคนพูดไม่สำเร็จ: ${message} (transcript ยังอยู่ครบ)`
})

window.api.onModelProgress(({ file, received, total }) => {
  const bar = bars.get(file)
  if (!bar) return
  bar.fill.style.width = `${(received / total) * 100}%`
  bar.size.textContent = `${size(received)} / ${size(total)}`
})

mcpToggle.onchange = async () => {
  mcpToggle.disabled = true
  try {
    showMcpState(await window.api.toggleMcp(mcpToggle.checked))
  } catch (err) {
    mcpToggle.checked = !mcpToggle.checked
    mcpStateEl.textContent = reason(err)
  } finally {
    mcpToggle.disabled = false
  }
}

toggle.onclick = () => void (recorder ? stop() : start())
void showPermissionWarnings()
void renderModels()
void window.api.mcpState().then(showMcpState)
