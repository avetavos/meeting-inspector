import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import type { MeetingLanguage, Transcript } from '../shared/meetings.ts'
import { startedAtFromId, titleOf } from '../shared/meetings.ts'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
// Type-only: verbatimModuleSyntax strips this at compile time, so it does not drag
// settings.ts's `electron` import into a module store.test.ts exercises with plain
// node:test (same requirement as everything else in this file).
import type { TranscribeMode } from './settings.ts'

// Override for throwaway test/verification runs (voices.ts's VOICES_FILE already has
// the same escape hatch) — nothing in the app reads this except the default here.
export const NOTES_ROOT = process.env['MEETING_INSPECTOR_NOTES_ROOT'] ?? join(homedir(), 'Documents', 'MeetingNotes')

/**
 * Paths that arrive over IPC are renderer-supplied, so main must not trust them.
 * Without this, `shell.openPath` would launch anything and the rename handler would
 * read and write `transcript.json` in any directory on the machine.
 */
export function assertMeetingDir(dir: string): string {
  const resolved = resolve(dir)
  if (!resolved.startsWith(NOTES_ROOT + sep)) {
    throw new Error(`not a meeting folder: ${dir}`)
  }
  return resolved
}

/**
 * `2026-08-27-1400-sprint-planning` — sorts by time, still readable in Finder.
 *
 * An untitled meeting is just the stamp. The date is already in there, so adding a
 * date-shaped title would only repeat it; `titleOf` renders the stamp back as a
 * readable time when there is nothing else to show.
 */
export function meetingId(title: string, at: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const stamp = `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}`
  const named = slug(title)
  return named ? `${stamp}-${named}` : stamp
}

/** Thai is kept as-is; only what a path cannot hold is stripped. */
export function slug(title: string): string {
  const s = title
    .normalize('NFC')
    .trim()
    .replace(/[\p{Cc}/\\:]/gu, '')
    .replace(/\s+/gu, '-')
    .replace(/^[.-]+/, '')
  return s
}

/**
 * `root` defaults to NOTES_ROOT and is only ever overridden by tests — same pattern as
 * listMeetings/walkMeetings below.
 *
 * meetingId has minute resolution, so starting, stopping, and starting again inside the
 * same clock-minute with no title (or the same title) used to collide on the exact same
 * id: `mkdir(dir, {recursive:true})` succeeds on a folder that already exists, and
 * WavWriter.open's `'w'` mode then truncates whatever the first recording had already
 * written (MEDIUM 3) — silent loss of a real recording, and 'manual' mode's whole pitch
 * is exactly the back-to-back recordings that make this reachable. `mkdir` with
 * `recursive: false` on a candidate id throws EEXIST if that folder is already taken,
 * which this walks past (id-2, id-3, …) until one is actually free — the same collision
 * rule Finder/Save As uses, and atomic against another process racing the same id
 * (unlike checking existence first and creating second).
 */
export async function createMeetingDir(
  title: string,
  at = new Date(),
  root = NOTES_ROOT,
): Promise<{ id: string; dir: string }> {
  const base = meetingId(title, at)
  await mkdir(root, { recursive: true })
  for (let n = 1; ; n++) {
    const id = n === 1 ? base : `${base}-${n}`
    const dir = join(root, id)
    try {
      await mkdir(dir)
      return { id, dir }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
  }
}

export type { Transcript } from '../shared/meetings.ts'

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

/**
 * One walk of `root`, each meeting's transcript read best-effort. A missing or corrupt
 * transcript.json comes back as `transcript: null` rather than dropping the folder —
 * mcp.ts's diskStore.list() filters those out itself (nothing to summarize without a
 * transcript), but the meetings panel must not: a recording with no usable transcript
 * is exactly what the user wants to see and re-transcribe (spec item 3).
 */
export async function walkMeetings(root = NOTES_ROOT): Promise<{ id: string; transcript: Transcript | null }[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const out: { id: string; transcript: Transcript | null }[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    out.push({ id: entry.name, transcript: await readTranscript(join(root, entry.name)).catch(() => null) })
  }
  return out
}

/**
 * Not `segments.length === 0` alone — a meeting where nobody spoke would then look
 * untranscribed forever and be re-run on every batch (spec item 2). `transcribedAt` is
 * the explicit signal; transcripts written before it existed have no way to say so, but
 * they DO have segments if they were ever transcribed, so that reads as done too.
 */
export function meetingDone(transcript: Transcript | null): boolean {
  if (!transcript) return false
  return transcript.transcribedAt !== undefined || transcript.segments.length > 0
}

/**
 * The language a meeting is (or will be) transcribed in: its own recorded language if
 * it has one, else the given fallback (the *current* meetingLanguage setting, always
 * passed explicitly by the caller — this function does not know about settings.json).
 * Every caller that resolves a meeting's decode language (transcribeOne's retroactive
 * pass, meeting:list's display column) routes through here, so "meetings recorded
 * before this field existed fall back to today's setting" is one rule, not one per
 * call site (spec item 1).
 */
export function resolveLanguage(stored: MeetingLanguage | null | undefined, fallback: MeetingLanguage): MeetingLanguage {
  return stored ?? fallback
}

/**
 * Whether a setting that would disturb a whisper-server pass already in flight is safe
 * to change right now (spec item 2 — the general rule, not just the microphone test's
 * narrow case). `recording` covers session:start through the end of session:stop's own
 * offline pass — index.ts's `current` stays set that whole time, not just while PCM is
 * still arriving; `batch` covers the meetings-list queue. Settings that only take
 * effect on the *next* recording or pass (transcribeMode, asrModel, meetingLanguage —
 * see Session/Transcript.language and resolveLanguage above) are deliberately not
 * gated by this: changing those mid-pass never touches whatever is already running.
 */
export function transcriptionBusy(recording: boolean, batch: boolean): boolean {
  return recording || batch
}

/**
 * mic:transcribe (index.ts) sends straight to the shared whisper-server, bypassing the
 * FIFO queue (Whisper.transcribeOnce) — safe to run alongside a *live* recording, which
 * is already hitting that same server the same way and expects other requests to queue
 * behind it (whisper.ts's enqueue doc comment), but not alongside a non-live recording
 * (which never touches whisper-server at all until session:stop) or a batch pass
 * (whose own requests would then queue behind an unrelated mic-test request).
 * `recordingMode` is `null` when nothing is currently recording.
 */
export function micTestLocked(recordingMode: TranscribeMode | null, batch: boolean): boolean {
  return (recordingMode !== null && recordingMode !== 'live') || batch
}

export type TranscribeStatus = 'not-transcribed' | 'transcribing' | 'done' | 'failed'

/**
 * Disk only ever knows "done" or "not done" (meetingDone above) — "transcribing" and
 * "failed" are the batch queue's own runtime state, layered on top by the caller
 * (index.ts), since nothing on disk records an in-progress or failed attempt.
 */
export function transcribeStatus(transcribed: boolean, running: boolean, failed: boolean): TranscribeStatus {
  if (running) return 'transcribing'
  if (transcribed) return 'done'
  if (failed) return 'failed'
  return 'not-transcribed'
}

export type MeetingListItem = {
  id: string
  title: string
  startedAt: string
  durationSec: number
  transcribed: boolean
  /** The meeting's own recorded language, or `null` if it predates that field — left
   * unresolved here (not run through resolveLanguage) because this module has no
   * access to the *current* setting to fall back to; the caller (index.ts's
   * meeting:list, which does) is the one place that fallback belongs. */
  language: MeetingLanguage | null
}

/**
 * Every recorded meeting, newest first — the meetings panel's data source (spec item
 * 3). Reuses walkMeetings rather than re-walking NOTES_ROOT a second way, and unlike
 * mcp.ts's diskStore.list() never drops a folder just for having no usable transcript.
 */
export async function listMeetings(root = NOTES_ROOT): Promise<MeetingListItem[]> {
  const walked = await walkMeetings(root)
  return walked
    .map(({ id, transcript }) => ({
      id,
      title: titleOf(id),
      startedAt: transcript?.startedAt ?? startedAtFromId(id) ?? '',
      durationSec: transcript?.durationSec ?? 0,
      transcribed: meetingDone(transcript),
      language: transcript?.language ?? null,
    }))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
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
