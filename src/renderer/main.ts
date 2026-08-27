import type { Segment } from '../preload/index.ts'
import { Recorder, type Track } from './recorder.ts'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const title = $<HTMLInputElement>('title')
const toggle = $<HTMLButtonElement>('toggle')
const elapsed = $('elapsed')
const warnings = $('warnings')
const done = $('done')
const queue = $('queue')
const transcript = $('transcript')
const meters: Record<Track, HTMLElement> = { loopback: $('m-loopback'), mic: $('m-mic') }

let recorder: Recorder | null = null
let ticker: number | undefined

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

// Live pass only labels "us" vs "them" (spec §4.2) — real names come from
// diarization after the meeting ends.
const WHO: Record<Track, string> = { mic: 'คุณ', loopback: 'คนอื่น' }

let segments: (Segment & { track: Track })[] = []

function addSegments(track: Track, incoming: Segment[]): void {
  segments.push(...incoming.map((s) => ({ ...s, track })))
  segments.sort((a, b) => a.t0 - b.t0)
  transcript.replaceChildren(
    ...segments.map((s) => {
      const p = document.createElement('p')
      if (s.track === 'mic') p.className = 'me'
      const t = document.createElement('span')
      t.className = 't'
      t.textContent = fmt(s.t0)
      const who = document.createElement('span')
      who.className = 'who'
      who.textContent = WHO[s.track]
      const text = document.createElement('span')
      text.textContent = s.text
      p.append(t, who, text)
      return p
    }),
  )
  transcript.scrollTop = transcript.scrollHeight
}

function setLevel(track: Track, rms: number): void {
  // sqrt curve: speech sits low on a linear scale and the bar would look dead.
  meters[track].style.width = `${Math.min(100, Math.sqrt(rms) * 180)}%`
}

function fmt(sec: number): string {
  const p = (n: number) => String(Math.floor(n)).padStart(2, '0')
  return `${p(sec / 60)}:${p(sec % 60)}`
}

async function start(): Promise<void> {
  done.replaceChildren()
  transcript.replaceChildren()
  segments = []
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

  done.textContent = `บันทึกแล้ว ${fmt(result.durationSec)} · ${result.segments} ท่อน — `
  const open = document.createElement('a')
  open.href = '#'
  open.textContent = result.id
  open.onclick = () => void window.api.reveal(result.dir)
  done.append(open)
}

window.api.onSegments(addSegments)
window.api.onQueue((depth) => {
  // Nothing is dropped; a deep queue just means the transcript lags further behind.
  queue.textContent = depth > 3 ? `ถอดเสียงตามไม่ทัน — ค้างอยู่ ${depth} ท่อน` : ''
})
window.api.onTranscriptError((message) => {
  warnings.textContent = `whisper-server ไม่ขึ้น: ${message}`
})

toggle.onclick = () => void (recorder ? stop() : start())
void showPermissionWarnings()
