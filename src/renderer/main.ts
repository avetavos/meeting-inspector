import { Recorder, type Track } from './recorder.ts'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const title = $<HTMLInputElement>('title')
const toggle = $<HTMLButtonElement>('toggle')
const elapsed = $('elapsed')
const warnings = $('warnings')
const done = $('done')
const meters: Record<Track, HTMLElement> = { loopback: $('m-loopback'), mic: $('m-mic') }

let recorder: Recorder | null = null
let ticker: number | undefined

const PERMISSION_LABEL = {
  screen: ['Screen Recording', 'ต้องมีเพื่ออัดเสียงระบบ (เสียงคนอื่นในที่ประชุม)'],
  microphone: ['Microphone', 'ต้องมีเพื่ออัดเสียงเรา'],
} as const

async function showPermissionWarnings(): Promise<void> {
  const status = await window.api.permissions()
  warnings.replaceChildren()
  for (const which of ['screen', 'microphone'] as const) {
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
    warnings.textContent = `เริ่มอัดไม่ได้: ${err instanceof Error ? err.message : String(err)}`
    await showPermissionWarnings()
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
  const result = await r?.stop()
  toggle.disabled = false
  toggle.textContent = 'เริ่มอัด'
  title.disabled = false
  elapsed.textContent = ''
  for (const track of ['loopback', 'mic'] as const) setLevel(track, 0)
  if (!result) return

  done.textContent = `บันทึกแล้ว ${fmt(result.loopback.durationSec)} — `
  const open = document.createElement('a')
  open.href = '#'
  open.textContent = result.id
  open.onclick = () => void window.api.reveal(result.dir)
  done.append(open)
}

toggle.onclick = () => void (recorder ? stop() : start())
void showPermissionWarnings()
