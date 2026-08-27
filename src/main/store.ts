import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const NOTES_ROOT = join(homedir(), 'Documents', 'MeetingNotes')

/** `2026-08-27-1400-sprint-planning` — sorts by time, still readable in Finder. */
export function meetingId(title: string, at: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const stamp = `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}`
  return `${stamp}-${slug(title)}`
}

/** Thai is kept as-is; only what a path cannot hold is stripped. */
export function slug(title: string): string {
  const s = title
    .normalize('NFC')
    .trim()
    .replace(/[\p{Cc}/\\:]/gu, '')
    .replace(/\s+/gu, '-')
    .replace(/^[.-]+/, '')
  return s || 'meeting'
}

export async function createMeetingDir(title: string, at = new Date()): Promise<{ id: string; dir: string }> {
  const id = meetingId(title, at)
  const dir = join(NOTES_ROOT, id)
  await mkdir(dir, { recursive: true })
  return { id, dir }
}

export type Transcript = {
  id: string
  startedAt: string
  durationSec: number
  /** Before diarization: just the two tracks. Step 5 replaces `them` with SPEAKER_xx. */
  speakers: Record<string, string>
  segments: { t0: number; t1: number; speaker: string; text: string }[]
}

/** Local time with a real offset, so a transcript read months later still says when. */
export function localIso(d: Date): string {
  const p = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, '0')
  const offset = -d.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  const time = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  return `${date}T${time}${sign}${p(offset / 60)}:${p(offset % 60)}`
}

/** transcript.json is the data; transcript.md is the same thing for human eyes. */
export async function writeTranscript(dir: string, transcript: Transcript): Promise<void> {
  const sorted = { ...transcript, segments: [...transcript.segments].sort((a, b) => a.t0 - b.t0) }
  await writeFile(join(dir, 'transcript.json'), JSON.stringify(sorted, null, 2) + '\n')
  await writeFile(join(dir, 'transcript.md'), renderMarkdown(sorted))
}

export async function readTranscript(dir: string): Promise<Transcript> {
  return JSON.parse(await readFile(join(dir, 'transcript.json'), 'utf8')) as Transcript
}

function renderMarkdown(t: Transcript): string {
  const clock = (sec: number) => {
    const p = (n: number) => String(Math.floor(n)).padStart(2, '0')
    return `${p(sec / 60)}:${p(sec % 60)}`
  }
  const lines = t.segments.map(
    (s) => `**${t.speakers[s.speaker] ?? s.speaker}** \`${clock(s.t0)}\`  ${s.text}`,
  )
  return [`# ${t.id}`, '', `${t.startedAt} · ${Math.round(t.durationSec / 60)} นาที`, '', ...lines, ''].join('\n')
}
