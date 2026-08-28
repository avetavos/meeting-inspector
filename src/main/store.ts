import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import type { MeetingLanguage, Transcript } from '../shared/meetings.ts'
import { safeId, stampOf, startedAtFromId, titleOf } from '../shared/meetings.ts'
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
 *
 * HIGH 1: that legacy fallback also used to swallow a *modern* write that withheld
 * transcribedAt on purpose — a 'live'/'after' pass that lost chunks (finishSessionStop,
 * index.ts) still pushes whatever segments it did get through before giving up, so
 * `segments.length > 0` alone cannot tell "written before transcribedAt existed" apart
 * from "written today, and failed". `transcribedAt` and `language` were added in the
 * same change (git blame both to the same commit) and every write path since sets
 * `language` unconditionally, transcribedAt or not (Transcript.language's own doc
 * comment) — so a transcript that has `language` but not `transcribedAt` was written
 * by code that knows about transcribedAt and chose not to set it, which is never the
 * legacy case. Only a transcript with neither field at all predates both and gets the
 * old "trust the segments" treatment.
 */
export function meetingDone(transcript: Transcript | null): boolean {
  if (!transcript) return false
  if (transcript.transcribedAt !== undefined) return true
  if (transcript.language !== undefined) return false
  return transcript.segments.length > 0
}

/**
 * Builds the Transcript to persist after a retroactive/batch replay pass (transcribeOne,
 * index.ts) — pulled out of index.ts so the "don't destroy an existing transcript when
 * the WAVs are gone" rule (HIGH 2) is testable without spawning whisper-server. `total`
 * is transcribeRecorded's own return value: 0 means neither track had anything to
 * replay — most likely the WAVs were deleted to reclaim disk after an earlier
 * successful transcription. Writing `{ ...previous, segments: [] }` in that case used
 * to still carry `previous.transcribedAt` through the spread, leaving the meeting
 * "Done" with its real text silently gone. Throwing instead of returning a value means
 * the caller must not write anything at all — transcript.json stays exactly as it was.
 */
export function finishReplayTranscript(
  previous: Transcript,
  collected: Transcript['segments'],
  language: MeetingLanguage,
  total: number,
): Transcript {
  if (total === 0) {
    throw new Error("no audio found to transcribe — the recording's WAV files are missing or empty")
  }
  return { ...previous, segments: collected, language, transcribedAt: localIso(new Date()) }
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
 * Removes a saved meeting's audio, and — unless `keepTranscript` — the meeting itself.
 *
 * The two WAVs are almost the whole size of a meeting on disk and nothing reads them
 * again once it has been transcribed, so "keep the words, drop the audio" is the case
 * worth having. It is only offered for a meeting that HAS been transcribed: dropping
 * the audio of one that has not leaves a folder with nothing in it, still listed as a
 * recording that can never be transcribed, which is why the renderer warns twice and
 * then deletes the whole thing instead (see index.ts's meeting:delete).
 *
 * `force: true` throughout — a WAV already gone (a half-deleted folder, a second click)
 * is the desired end state, not an error.
 */
export async function deleteMeeting(id: string, keepTranscript: boolean, root = NOTES_ROOT): Promise<void> {
  if (!safeId(id)) throw new Error(`not a meeting: ${id}`)
  const dir = join(root, id)
  if (!keepTranscript) {
    await rm(dir, { recursive: true, force: true })
    return
  }
  for (const track of ['loopback', 'mic']) await rm(join(dir, `${track}.wav`), { force: true })
}

/**
 * Renames a saved meeting by moving its folder, and returns the id it now has.
 *
 * The title lives in the id (`titleOf`), so a rename has to move the folder for the
 * name on screen, the name in Finder and the name an MCP client reads to stay the one
 * name they have always been — rather than adding a second, shadowing title field that
 * only some of those three would know about, and that a meeting with no transcript.json
 * yet would have nowhere to live in.
 *
 * `rename` is left to arbitrate collisions itself, the way createMeetingDir leans on
 * `mkdir`: moving a directory onto a real meeting's folder fails with ENOTEMPTY/EEXIST
 * rather than swallowing it, so a clashing name walks to `-2`, `-3`, … instead. The
 * timestamp prefix is carried over verbatim (`stampOf`), so the list's order and any
 * suffix the original id already carried both survive.
 */
export async function renameMeeting(id: string, title: string, root = NOTES_ROOT): Promise<string> {
  if (!safeId(id)) throw new Error(`not a meeting: ${id}`)
  const stamp = stampOf(id)
  if (!stamp) throw new Error(`not a renamable meeting: ${id}`)
  const named = slug(title)
  const base = named ? `${stamp}-${named}` : stamp

  for (let n = 1; ; n++) {
    const next = n === 1 ? base : `${base}-${n}`
    if (next === id) return id
    const dir = join(root, next)
    try {
      await rename(join(root, id), dir)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOTEMPTY' || code === 'EEXIST') continue
      throw err
    }
    // transcript.json and transcript.md both carry the id; writeTranscript regenerates
    // the markdown from it. Best-effort: a meeting recorded but never transcribed has
    // no transcript to fix up, and that is not a reason to fail the rename.
    const transcript = await readTranscript(dir).catch(() => null)
    if (transcript) await writeTranscript(dir, { ...transcript, id: next })
    return next
  }
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
