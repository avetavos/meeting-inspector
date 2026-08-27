import type { Language, McpState, Transcript } from '../preload/index.ts'
import { titleOf } from '../shared/meetings.ts'
import { Recorder, openMicTap, type Track } from './recorder.ts'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

/** Every user-visible string in the renderer. English is the default voice; Thai is kept as-is. */
const en = {
  titlePlaceholder: 'Meeting title',
  start: 'Start recording',
  stop: 'End meeting',
  meterOthers: 'Others',
  meterUs: 'You',
  settingsSummary: 'Settings',
  voicesHeading: (n: number) => `Voices I recognise (${n})`,
  voicesEmpty: 'No voices yet — name a speaker after a meeting and I will know them next time',
  voicesForget: 'Forget',
  micTest: 'Test my microphone',
  micTestStop: 'Stop',
  micTestLine: 'Read this out loud: "วันนี้เราจะคุยเรื่อง deploy กับ migration ของฐานข้อมูลครับ"',
  micTestSpeech: 'hearing speech',
  micTestDropped: 'ignoring this',
  micTestHeard: (text: string) => `Transcribed: ${text}`,
  micTestNothing: 'Nothing survived the filter.',
  micVerdictQuiet: 'The microphone barely picked anything up. This is not the filter — check the input device, or speak closer.',
  micVerdictTooStrict: (pct: number) =>
    `Your voice registered only ${pct}% of the time and nothing reached the transcript. This level is too strict for this room.`,
  micVerdictPatchy: (pct: number) =>
    `Your voice registered ${pct}% of the time — it is dropping in and out, so parts of a meeting would go missing.`,
  micVerdictGood: (pct: number) =>
    `Your voice registered ${pct}% of the time and came through to the transcript. This level suits this room.`,
  micVerdictTryStricter: 'If the room still produces lines when nobody talks, move up one and test again.',
  micLower: 'Lower it one step',
  micRaise: 'Raise it one step',
  noiseLabel: 'Ignore noise',
  noiseLow: 'Keep everything',
  noiseMedium: 'Balanced',
  noiseHigh: 'Speech only',
  noiseHint: {
    low: 'Room tone is still ignored. Faint talking in a noisy room is kept — with it, the odd line the room made rather than a person.',
    medium: 'The default. Room tone ignored, quiet and distant speech still transcribed.',
    high: 'Also drops very faint speech in a noisy room. Use this if lines appear when nobody is talking.',
  } as Record<string, string>,
  mcpLabel: 'Turn on the MCP server so a local AI assistant can pull the transcript to summarize it',
  permWhy: {
    screen: 'Needed to record system audio — everyone else in the meeting',
    microphone: 'Needed to record your microphone',
  },
  permNeverAsked: (name: string, why: string) => `Never asked for ${name} access — ${why}`,
  permDenied: (name: string, why: string) => `${name} access is off — ${why}`,
  permGrant: (name: string) => `Allow ${name}`,
  permOpenSettings: 'Open System Settings',
  trackLost: (track: string) => `${track} track stopped unexpectedly — stop and start again`,
  startFailed: (msg: string) => `Couldn't start recording: ${msg}`,
  transcribingRest: "Transcribing what's left…",
  saved: (dur: string, segments: number) => `Saved ${dur} · ${segments} segment${segments === 1 ? '' : 's'} — `,
  queueBacklog: (depth: number) => `Falling behind on transcription — ${depth} chunk${depth === 1 ? '' : 's'} queued`,
  whisperError: (msg: string) => `whisper-server didn't start: ${msg}`,
  diarizing: "Working out who's speaking…",
  diarizeError: (msg: string) => `Couldn't split speakers: ${msg} (the transcript is still there)`,
  modelsMissing: (count: number, size: string) =>
    `Missing ${count} model file${count === 1 ? '' : 's'} (${size}) — you can record, but can't transcribe yet`,
  modelsResumable: (size: string) => ` · ${size} already downloaded, will pick up where it left off`,
  downloadModels: 'Download models',
  cancel: 'Cancel',
  downloading: 'Downloading…',
  downloadCancelled: 'Cancelled — will resume next time',
  downloadComplete: 'Download complete',
  speakerSave: 'Save names',
  speakerSaved: 'Saved',
  speakerMergeHint: 'If someone got split into two speakers, give them the same name to merge them.',
  copy: 'Copy',
  copied: 'Copied',
  portMoved:
    "⚠️ Port 8787 was taken, so a different one was used — any config you'd already set up won't connect. Use the lines below to set it up again.",
  speakerDefaults: { me: 'You', them: 'Others' },
  modelNames: {
    'ggml-large-v3.bin': 'Whisper large-v3 — transcribes speech',
    'ggml-silero-v5.1.2.bin': 'Silero VAD — keeps silence from sounding like speech',
    'pyannote-segmentation-3-0.onnx': 'pyannote — splits the audio by who is talking',
    'campplus-sv-zh_en.onnx': 'CAM++ — tells speakers apart',
  } as Record<string, string>,
}

const th: typeof en = {
  titlePlaceholder: 'ชื่อการประชุม',
  start: 'เริ่มอัด',
  stop: 'จบประชุม',
  meterOthers: 'คนอื่น',
  meterUs: 'เรา',
  settingsSummary: 'ตั้งค่า',
  voicesHeading: (n: number) => `เสียงที่จำได้ (${n} คน)`,
  voicesEmpty: 'ยังไม่จำเสียงใคร — ตั้งชื่อคนพูดหลังประชุมสักครั้ง ครั้งหน้าจะเติมชื่อให้เอง',
  voicesForget: 'ลืมเสียงนี้',
  micTest: 'ทดสอบไมค์',
  micTestStop: 'หยุด',
  micTestLine: 'อ่านประโยคนี้ออกเสียง: "วันนี้เราจะคุยเรื่อง deploy กับ migration ของฐานข้อมูลครับ"',
  micTestSpeech: 'ได้ยินเป็นเสียงพูด',
  micTestDropped: 'กำลังทิ้งเสียงนี้',
  micTestHeard: (text: string) => `ถอดได้ว่า: ${text}`,
  micTestNothing: 'ไม่มีอะไรรอดผ่านตัวกรอง',
  micVerdictQuiet: 'ไมค์แทบไม่ได้ยินอะไรเลย อันนี้ไม่ใช่เรื่องระดับกรอง ลองเช็คว่าเลือกไมค์ถูกตัวไหม หรือพูดใกล้ขึ้น',
  micVerdictTooStrict: (pct: number) =>
    `เสียงคุณถูกนับเป็นเสียงพูดแค่ ${pct}% ของเวลา และไม่มีอะไรถึง transcript เลย ระดับนี้เข้มเกินไปสำหรับห้องนี้`,
  micVerdictPatchy: (pct: number) =>
    `เสียงคุณถูกนับเป็นเสียงพูด ${pct}% ของเวลา ติดๆ หลุดๆ แบบนี้ประชุมจริงจะขาดหายเป็นช่วงๆ`,
  micVerdictGood: (pct: number) =>
    `เสียงคุณถูกนับเป็นเสียงพูด ${pct}% ของเวลา และถอดออกมาได้ ระดับนี้เหมาะกับห้องนี้`,
  micVerdictTryStricter: 'ถ้ายังมีบรรทัดโผล่ตอนไม่มีใครพูด ลองเพิ่มอีกขั้นแล้วทดสอบใหม่',
  micLower: 'ลดลงหนึ่งขั้น',
  micRaise: 'เพิ่มขึ้นหนึ่งขั้น',
  noiseLabel: 'กรองเสียงรบกวน',
  noiseLow: 'เก็บทุกอย่าง',
  noiseMedium: 'สมดุล',
  noiseHigh: 'เอาแต่เสียงพูด',
  noiseHint: {
    low: 'เสียงห้องเปล่ายังถูกกรองอยู่ แต่คนคุยแผ่วๆ ในห้องที่มีเสียงรบกวนจะถูกเก็บไว้ — แลกกับบางบรรทัดที่ห้องสร้างขึ้นเอง ไม่ใช่คนพูด',
    medium: 'ค่าเริ่มต้น กรองเสียงห้องออก แต่ยังถอดเสียงคนที่พูดเบาหรืออยู่ไกลไมค์',
    high: 'ตัดเสียงพูดที่แผ่วมากในห้องที่มีเสียงรบกวนออกด้วย ใช้เมื่อมีบรรทัดโผล่ทั้งที่ไม่มีใครพูด',
  } as Record<string, string>,
  mcpLabel: 'เปิด MCP server ให้ AI ในเครื่องดึง transcript ไปสรุป',
  permWhy: {
    screen: 'ต้องมีเพื่ออัดเสียงระบบ (เสียงคนอื่นในที่ประชุม)',
    microphone: 'ต้องมีเพื่ออัดเสียงเรา',
  },
  permNeverAsked: (name, why) => `ยังไม่เคยขอสิทธิ์ ${name} — ${why}`,
  permDenied: (name, why) => `ไม่ได้สิทธิ์ ${name} — ${why}`,
  permGrant: (name) => `ขอสิทธิ์ ${name}`,
  permOpenSettings: 'เปิด System Settings',
  trackLost: (track) => `${track} track หยุดกลางคัน — กดหยุดแล้วเริ่มใหม่`,
  startFailed: (msg) => `เริ่มอัดไม่ได้: ${msg}`,
  transcribingRest: 'กำลังถอดเสียงส่วนที่เหลือ…',
  saved: (dur, segments) => `บันทึกแล้ว ${dur} · ${segments} ท่อน — `,
  queueBacklog: (depth) => `ถอดเสียงตามไม่ทัน — ค้างอยู่ ${depth} ท่อน`,
  whisperError: (msg) => `whisper-server ไม่ขึ้น: ${msg}`,
  diarizing: 'กำลังแยกว่าใครพูด…',
  diarizeError: (msg) => `แยกคนพูดไม่สำเร็จ: ${msg} (transcript ยังอยู่ครบ)`,
  modelsMissing: (count, size) => `ยังไม่มีโมเดล ${count} ไฟล์ (${size}) — อัดเสียงได้ แต่ยังถอดเสียงไม่ได้`,
  modelsResumable: (size) => ` · โหลดค้างไว้ ${size} จะโหลดต่อจากเดิม`,
  downloadModels: 'โหลดโมเดล',
  cancel: 'ยกเลิก',
  downloading: 'กำลังโหลด…',
  downloadCancelled: 'ยกเลิกแล้ว — ครั้งหน้าจะโหลดต่อจากเดิม',
  downloadComplete: 'โหลดครบแล้ว',
  speakerSave: 'บันทึกชื่อ',
  speakerSaved: 'บันทึกแล้ว',
  speakerMergeHint: 'ถ้าแยกคนพูดผิด ตั้งชื่อเดียวกันให้สองคน = รวมเป็นคนเดียว',
  copy: 'คัดลอก',
  copied: 'คัดลอกแล้ว',
  portMoved: '⚠️ port 8787 ไม่ว่าง ต้องย้ายไป port อื่น — config ที่ตั้งไว้เดิมจะต่อไม่ติด ใช้บรรทัดข้างล่างตั้งใหม่',
  speakerDefaults: { me: 'คุณ', them: 'คนอื่น' },
  modelNames: {
    'ggml-large-v3.bin': 'Whisper large-v3 — ถอดเสียง',
    'ggml-silero-v5.1.2.bin': 'Silero VAD — กันหลอนตอนเงียบ',
    'pyannote-segmentation-3-0.onnx': 'pyannote — แบ่งช่วงคนพูด',
    'campplus-sv-zh_en.onnx': 'CAM++ — จำแนกว่าใครเป็นใคร',
  } as Record<string, string>,
}

const STR: Record<Language, typeof en> = { en, th }

let lang: Language = 'en'
const t = () => STR[lang]

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
const meterLabels: Record<Track, HTMLElement> = { loopback: $('meter-others-label'), mic: $('meter-us-label') }
const settingsSummary = $('settings-summary')
const voicesEl = $('voices')
const noiseSelect = $<HTMLSelectElement>('noise')
const noiseLabel = $('noise-label')
const noiseHint = $('noisehint')
const micToggle = $<HTMLButtonElement>('mictest-toggle')
const micLevel = $('mictest-level')
const micVerdictEl = $('mictest-verdict')
const micLine = $('mictest-line')
const micHeard = $('mictest-heard')
const mcpLabel = $('mcp-label')
const langRadios: Record<Language, HTMLInputElement> = {
  en: $<HTMLInputElement>('lang-en'),
  th: $<HTMLInputElement>('lang-th'),
}

let recorder: Recorder | null = null
let ticker: number | undefined

/**
 * During the meeting a segment is only ever "us" or "them" (spec §4.2); diarization
 * replaces the `them` half with real speakers once the recording is complete.
 */
let segments: Transcript['segments'] = []
let speakers: Record<string, string> = { ...en.speakerDefaults }
let meetingDir: string | null = null

const PERMISSION_NAME = { screen: 'Screen Recording', microphone: 'Microphone' } as const

/** Remembered so a language switch re-renders the panel with the same screen/mic scope. */
let permissionsIncludeScreen = false

/**
 * macOS has no not-determined state for Screen Recording — never-granted reads back
 * as "denied". So at launch we only speak up about the mic, which does distinguish
 * the two; the screen box appears once a capture attempt has actually failed.
 */
async function showPermissionWarnings(includeScreen = false): Promise<void> {
  permissionsIncludeScreen = includeScreen
  const status = await window.api.permissions()
  warnings.replaceChildren()
  for (const which of includeScreen ? (['screen', 'microphone'] as const) : (['microphone'] as const)) {
    if (status[which] === 'granted') continue
    const name = PERMISSION_NAME[which]
    const why = t().permWhy[which]

    // not-determined means macOS has never asked. Sending someone to System Settings
    // then is a dead end — an app only appears in that list once it has asked at
    // least once. So ask, and let the OS add us to the list.
    const canAsk = which === 'microphone' && status[which] === 'not-determined'
    const box = document.createElement('div')
    box.className = 'warn'
    box.textContent = canAsk ? t().permNeverAsked(name, why) : t().permDenied(name, why)

    const action = document.createElement('button')
    action.textContent = canAsk ? t().permGrant(name) : t().permOpenSettings
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

/** Falls back to the raw filename so an unrecognized model never crashes the panel. */
const modelName = (file: string) => t().modelNames[file] ?? file

/**
 * Three gigabytes of models are fetched on first run rather than shipped in the
 * installer (spec §12). The app records fine without them; only transcription and
 * diarization wait, so this panel informs rather than blocks.
 *
 * One bar covers every missing file rather than one per file — the large-v3 weights
 * alone are 3.0 of the 3.1 GB total, so four bars would mostly sit empty. `received`
 * is a running per-file byte count (seeded from each file's resumeFrom) that
 * `onModelProgress` updates as events arrive; the bar shows their sum over the total
 * across all missing files.
 */
let overallTotal = 0
const received = new Map<string, number>()
let overallFill: HTMLElement | null = null
let overallName: HTMLElement | null = null
let overallSize: HTMLElement | null = null

function updateOverallBar(): void {
  if (!overallFill || !overallSize) return
  const sum = [...received.values()].reduce((a, b) => a + b, 0)
  overallFill.style.width = `${overallTotal ? (sum / overallTotal) * 100 : 0}%`
  overallSize.textContent = `${size(sum)} / ${size(overallTotal)}`
}

async function renderModels(note = ''): Promise<void> {
  const missing = (await window.api.modelStatus()).filter((m) => !m.present)
  modelsEl.replaceChildren()
  overallFill = overallName = overallSize = null
  received.clear()
  if (missing.length === 0) {
    if (note) modelsEl.textContent = note
    return
  }

  const box = document.createElement('div')
  box.className = 'warn'
  overallTotal = missing.reduce((sum, m) => sum + m.bytes, 0)
  const resumable = missing.filter((m) => m.resumeFrom > 0)
  box.textContent =
    t().modelsMissing(missing.length, size(overallTotal)) +
    (resumable.length > 0 ? t().modelsResumable(size(resumable.reduce((s, m) => s + m.resumeFrom, 0))) : '')

  for (const spec of missing) received.set(spec.file, spec.resumeFrom)

  const barRow = document.createElement('div')
  barRow.className = 'file'
  overallName = document.createElement('span')
  overallSize = document.createElement('span')
  overallSize.className = 'size'
  const bar = document.createElement('span')
  bar.className = 'bar'
  overallFill = document.createElement('i')
  bar.append(overallFill)
  barRow.append(overallName, overallSize, bar)
  box.append(barRow)
  updateOverallBar()

  const button = document.createElement('button')
  button.textContent = t().downloadModels
  const cancel = document.createElement('button')
  cancel.textContent = t().cancel
  cancel.hidden = true
  const status = document.createElement('div')
  status.className = 'hint'
  if (note) status.textContent = note

  button.onclick = async () => {
    button.hidden = true
    cancel.hidden = false
    status.textContent = t().downloading
    let outcome: string
    try {
      outcome = (await window.api.downloadModels()).cancelled ? t().downloadCancelled : t().downloadComplete
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

const content = $('content')

/**
 * The transcript is not its own scroller — the whole content column is, with the
 * capsule sticky on top of it — so scrolling `#transcript` did nothing at all.
 *
 * Only follows when the reader is already at the bottom. Yanking the view back down
 * while someone is reading an earlier line is worse than not following.
 */
function followTranscript(): void {
  const distanceFromBottom = content.scrollHeight - content.scrollTop - content.clientHeight
  if (distanceFromBottom > 120) return
  content.scrollTo({ top: content.scrollHeight, behavior: 'smooth' })
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
  followTranscript()
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
  save.textContent = t().speakerSave
  save.onclick = async () => {
    if (!meetingDir) return
    save.disabled = true
    const named = Object.fromEntries(
      [...inputs].map(([label, input]) => [label, input.value.trim() || label]),
    )
    speakers = (await window.api.renameSpeakers(meetingDir, named)).speakers
    save.disabled = false
    save.textContent = t().speakerSaved
  }

  const hint = document.createElement('div')
  hint.className = 'hint'
  hint.textContent = t().speakerMergeHint
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
  copy.textContent = t().copy
  copy.onclick = async () => {
    await navigator.clipboard.writeText(value)
    copy.textContent = t().copied
    setTimeout(() => (copy.textContent = t().copy), 1500)
  }
  row.append(name, el, copy)
  return row
}

function showMcpState(state: McpState): void {
  mcpToggle.checked = state.enabled
  mcpStateEl.replaceChildren()
  if (state.portMoved) {
    const moved = document.createElement('div')
    moved.textContent = t().portMoved
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

/**
 * The voices the app has learned. Naming a speaker after a meeting teaches it one;
 * this is where you take it back.
 */
async function renderVoices(): Promise<void> {
  const names = await window.api.knownVoices()
  voicesEl.replaceChildren()

  const heading = document.createElement('div')
  heading.className = 'hint'
  heading.textContent = names.length > 0 ? t().voicesHeading(names.length) : t().voicesEmpty
  voicesEl.append(heading)

  for (const name of names) {
    const row = document.createElement('div')
    row.className = 'voice'
    const who = document.createElement('span')
    who.textContent = name
    const forget = document.createElement('button')
    forget.textContent = t().voicesForget
    forget.onclick = async () => {
      forget.disabled = true
      await window.api.forgetVoice(name)
      await renderVoices()
    }
    row.append(who, forget)
    voicesEl.append(row)
  }
}

/**
 * Lets someone hear what the noise setting does to their own room before a meeting
 * depends on it. Live meter, a live verdict from the same gate the recorder uses,
 * and what actually survives to the transcript.
 */
let micStop: (() => void) | null = null
let micFrames: Float32Array[] = []
let micProbes = { checks: 0, heard: 0, loudest: 0 }

const LEVELS = ['low', 'medium', 'high'] as const

/**
 * Turns the test into an answer rather than a reading. How often the gate counted
 * the voice, and whether anything reached the transcript, is what decides whether
 * this level suits this room.
 */
function micVerdict(text: string): { message: string; move?: 'low' | 'medium' | 'high' } {
  const pct = micProbes.checks > 0 ? Math.round((micProbes.heard / micProbes.checks) * 100) : 0
  const index = LEVELS.indexOf(noiseSelect.value as (typeof LEVELS)[number])
  const softer = LEVELS[index - 1]
  const harder = LEVELS[index + 1]

  // A silent microphone is not a filter problem, and telling someone to lower the
  // setting would send them the wrong way entirely.
  if (micProbes.loudest < 0.01) return { message: t().micVerdictQuiet }
  // Already at the most permissive level: lowering is not on offer, so the advice
  // has to be about the microphone instead of the setting.
  if (!text.trim()) {
    const message = `${t().micTestNothing} ${softer ? t().micVerdictTooStrict(pct) : t().micVerdictQuiet}`
    return { message, move: softer }
  }
  if (pct < 50) {
    return softer ? { message: t().micVerdictPatchy(pct), move: softer } : { message: t().micVerdictPatchy(pct) }
  }
  return { message: `${t().micVerdictGood(pct)} ${harder ? t().micVerdictTryStricter : ''}`.trim(), move: undefined }
}

async function toggleMicTest(): Promise<void> {
  if (micStop) {
    micStop()
    micStop = null
    micToggle.textContent = t().micTest
    micLine.textContent = ''
    micVerdictEl.textContent = ''
    micVerdictEl.className = ''
    micLevel.className = ''
    micLevel.style.width = '0%'

    const total = micFrames.reduce((n, f) => n + f.length, 0)
    const all = new Int16Array(total)
    let at = 0
    for (const f of micFrames) for (const v of f) all[at++] = Math.max(-1, Math.min(1, v)) * 32767
    micFrames = []
    if (total > 16000) {
      micHeard.textContent = '…'
      const text = await window.api.transcribeMic(all.buffer as ArrayBuffer)
      const { message, move } = micVerdict(text)
      micHeard.replaceChildren()
      if (text.trim()) {
        const heard = document.createElement('div')
        heard.textContent = t().micTestHeard(text.trim())
        micHeard.append(heard)
      }
      const verdict = document.createElement('div')
      verdict.textContent = message
      micHeard.append(verdict)
      if (move) {
        const fix = document.createElement('button')
        const goingDown = LEVELS.indexOf(move) < LEVELS.indexOf(noiseSelect.value as (typeof LEVELS)[number])
        fix.textContent = goingDown ? t().micLower : t().micRaise
        fix.onclick = async () => {
          noiseSelect.value = move
          noiseSelect.dispatchEvent(new Event('change'))
          micHeard.replaceChildren()
        }
        micHeard.append(fix)
      }
    }
    return
  }

  micHeard.replaceChildren()
  micFrames = []
  micProbes = { checks: 0, heard: 0, loudest: 0 }
  try {
    micStop = await openMicTap((frame) => {
      micFrames.push(frame)
      let sum = 0
      for (const v of frame) sum += v * v
      const rms = Math.sqrt(sum / frame.length)
      micProbes.loudest = Math.max(micProbes.loudest, rms)
      setMicLevel(rms)
    })
  } catch (err) {
    micHeard.textContent = reason(err)
    return
  }
  micToggle.textContent = t().micTestStop
  micLine.textContent = t().micTestLine
  void probeLoop()
}

function setMicLevel(rms: number): void {
  micLevel.style.width = `${Math.min(100, Math.sqrt(rms) * 180)}%`
}

/** Asks main, every second, whether the last two seconds count as speech right now. */
async function probeLoop(): Promise<void> {
  while (micStop) {
    const recent = micFrames.slice(-20)
    const total = recent.reduce((n, f) => n + f.length, 0)
    if (total > 16000) {
      const pcm = new Int16Array(total)
      let at = 0
      for (const f of recent) for (const v of f) pcm[at++] = Math.max(-1, Math.min(1, v)) * 32767
      const speech = await window.api.probeMic(pcm.buffer as ArrayBuffer).catch(() => false)
      if (!micStop) break
      micProbes.checks += 1
      if (speech) micProbes.heard += 1
      micVerdictEl.textContent = speech ? t().micTestSpeech : t().micTestDropped
      micVerdictEl.className = speech ? 'speech' : 'dropped'
      // The bar itself says whether this is counted, so the level and the verdict
      // are one thing to watch rather than two.
      micLevel.className = speech ? 'speech' : ''
    }
    await new Promise((r) => setTimeout(r, 500))
  }
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
  speakers = { ...t().speakerDefaults }
  meetingDir = null
  await window.api.requestPermissions()
  toggle.disabled = true
  try {
    const started = await Recorder.start(title.value, {
      onLevel: setLevel,
      onTrackLost: (track) => {
        warnings.textContent = t().trackLost(track)
      },
    })
    recorder = started.recorder
  } catch (err) {
    await showPermissionWarnings(true)
    warnings.prepend(t().startFailed(reason(err)))
    return
  } finally {
    toggle.disabled = false
  }

  const t0 = Date.now()
  ticker = window.setInterval(() => (elapsed.textContent = fmt((Date.now() - t0) / 1000)), 500)
  toggle.textContent = t().stop
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
  done.textContent = t().transcribingRest
  const result = await r?.stop()
  document.body.classList.remove('recording')
  toggle.disabled = false
  toggle.textContent = t().start
  title.disabled = false
  elapsed.textContent = ''
  for (const track of ['loopback', 'mic'] as const) setLevel(track, 0)
  if (!result) {
    done.replaceChildren()
    return
  }

  meetingDir = result.dir
  done.textContent = t().saved(fmt(result.durationSec), result.segments)
  const open = document.createElement('a')
  open.href = '#'
  open.textContent = titleOf(result.id)
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
  queue.textContent = depth > 3 ? t().queueBacklog(depth) : ''
})
window.api.onTranscriptError((message) => {
  warnings.textContent = t().whisperError(message)
})

window.api.onDiarizing(() => {
  queue.textContent = t().diarizing
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
  warnings.textContent = t().diarizeError(message)
})

window.api.onModelProgress(({ file, received: bytes }) => {
  if (!overallFill) return
  received.set(file, bytes)
  if (overallName) overallName.textContent = modelName(file)
  updateOverallBar()
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

/** Applies the given language to every static label and re-renders every dynamic panel. */
function applyLanguage(l: Language): void {
  lang = l
  document.documentElement.lang = l
  langRadios.en.checked = l === 'en'
  langRadios.th.checked = l === 'th'

  title.placeholder = t().titlePlaceholder
  toggle.textContent = recorder ? t().stop : t().start
  meterLabels.loopback.textContent = t().meterOthers
  meterLabels.mic.textContent = t().meterUs
  settingsSummary.textContent = t().settingsSummary
  noiseLabel.textContent = t().noiseLabel
  const options = noiseSelect.options
  options[0]!.textContent = t().noiseLow
  options[1]!.textContent = t().noiseMedium
  options[2]!.textContent = t().noiseHigh
  noiseHint.textContent = t().noiseHint[noiseSelect.value] ?? ''
  micToggle.textContent = micStop ? t().micTestStop : t().micTest
  micLine.textContent = micStop ? t().micTestLine : ''
  void renderVoices()
  mcpLabel.textContent = t().mcpLabel

  void showPermissionWarnings(permissionsIncludeScreen)
  void renderModels()
  renderSpeakerPanel()
  void window.api.mcpState().then(showMcpState)
}

for (const [code, radio] of Object.entries(langRadios) as [Language, HTMLInputElement][]) {
  radio.onchange = async () => {
    if (!radio.checked) return
    applyLanguage((await window.api.setLanguage(code)).language)
  }
}

toggle.onclick = () => void (recorder ? stop() : start())
micToggle.onclick = () => void toggleMicTest()

noiseSelect.onchange = async () => {
  noiseSelect.disabled = true
  try {
    // Applies to the next chunk, not the next launch — the whole point is trying a
    // level and hearing whether it helped.
    await window.api.setNoiseFilter(noiseSelect.value as 'low' | 'medium' | 'high')
    noiseHint.textContent = t().noiseHint[noiseSelect.value] ?? ''
  } finally {
    noiseSelect.disabled = false
  }
}

void window.api.getSettings().then((settings) => {
  noiseSelect.value = settings.noiseFilter
  applyLanguage(settings.language)
})
