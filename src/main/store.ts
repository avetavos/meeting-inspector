import { mkdir } from 'node:fs/promises'
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
