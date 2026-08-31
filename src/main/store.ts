import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import type { MeetingLanguage, Transcript } from '../shared/meetings.ts'
import { displayTitle, safeId, startedAtFromId, titlePartOf } from '../shared/meetings.ts'
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
 * UUID v7 — the first 48 bits are the millisecond the meeting started, so ids sort into
 * the order meetings actually happened (v4 and v5 do not sort at all) and a folder
 * listing is still chronological even though nothing in the name is readable any more.
 *
 * Hand-rolled rather than adding a uuid dependency for twelve lines: `randomUUID()` is
 * v4 only, and everything else here is layout — the version nibble, the variant bits,
 * and the timestamp in the first six bytes.
 */
export function uuidv7(at: Date = new Date()): string {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  const ms = at.getTime()
  for (let i = 0; i < 6; i++) b[i] = Math.floor(ms / 2 ** (8 * (5 - i))) & 0xff
  b[6] = (b[6]! & 0x0f) | 0x70
  b[8] = (b[8]! & 0x3f) | 0x80
  const hex = [...b].map((n) => n.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * A meeting's own identity, beside its audio rather than encoded in the folder name.
 *
 * The title used to BE the id (`2026-08-27-1400-sprint-planning`), which meant a title
 * could only hold what a path can hold, and renaming a meeting had to move its folder —
 * changing the id every other store keyed by it (voices.json, an MCP client's notes)
 * had already written down. Split apart: the id is a uuid nothing ever rewrites, the
 * title is freetext, and `startedAt` is recorded at creation so a meeting that never
 * got as far as a transcript still knows when it happened.
 */
export type MeetingMetaFile = { id: string; title: string; startedAt: string }

const META = 'meeting.json'

export async function readMeta(dir: string): Promise<MeetingMetaFile | null> {
  return readFile(join(dir, META), 'utf8').then(
    (raw) => JSON.parse(raw) as MeetingMetaFile,
    () => null,
  )
}

export async function writeMeta(dir: string, meta: MeetingMetaFile): Promise<void> {
  await writeFile(join(dir, META), JSON.stringify(meta, null, 2) + '\n')
}

/**
 * `root` defaults to NOTES_ROOT and is only ever overridden by tests — same pattern as
 * listMeetings/walkMeetings below.
 *
 * The old timestamp-and-slug id had minute resolution, so two recordings started inside
 * the same clock-minute collided on the same folder and the second one's WavWriter
 * truncated the first (MEDIUM 3) — which is why this used to walk `id-2`, `id-3`, … past
 * whatever `mkdir` refused. A uuid v7 carries 74 random bits, so there is nothing left
 * to collide and nothing left to walk past.
 */
export async function createMeetingDir(
  title: string,
  at = new Date(),
  root = NOTES_ROOT,
): Promise<{ id: string; dir: string }> {
  const id = uuidv7(at)
  const dir = join(root, id)
  await mkdir(dir, { recursive: true })
  await writeMeta(dir, { id, title: title.trim(), startedAt: localIso(at) })
  return { id, dir }
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

/** transcript.json is the data; transcript.md is the same thing for human eyes — which
 * is why the meta is read here: the markdown's heading is the meeting's name, and since
 * the id became a uuid the transcript itself no longer carries one. */
export async function writeTranscript(dir: string, transcript: Transcript): Promise<void> {
  const sorted = { ...transcript, segments: [...transcript.segments].sort((a, b) => a.t0 - b.t0) }
  const meta = await readMeta(dir)
  await writeFile(join(dir, 'transcript.json'), JSON.stringify(sorted, null, 2) + '\n')
  await writeFile(join(dir, 'transcript.md'), renderMarkdown(sorted, displayTitle(meta?.title ?? '', sorted.startedAt)))
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
export async function walkMeetings(
  root = NOTES_ROOT,
): Promise<{ id: string; meta: MeetingMetaFile | null; transcript: Transcript | null }[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const out: { id: string; meta: MeetingMetaFile | null; transcript: Transcript | null }[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(root, entry.name)
    out.push({ id: entry.name, meta: await readMeta(dir), transcript: await readTranscript(dir).catch(() => null) })
  }
  return out
}

/**
 * Gives every pre-uuid meeting the meeting.json it was recorded before — one pass at
 * startup, so from then on exactly one place holds a title and nothing has to parse one
 * back out of a folder name.
 *
 * The folders keep their old names on purpose. A folder name IS the id (that is the
 * whole reason this split was needed), and voices.json's `firstHeard.meetingId` and any
 * MCP client that wrote one down both already hold those — renaming them to uuids would
 * mean rewriting every one of those stores to buy nothing but a tidier listing.
 */
export async function migrateMeetingMeta(root = NOTES_ROOT): Promise<number> {
  let written = 0
  for (const { id, meta, transcript } of await walkMeetings(root)) {
    // A folder name that is not a usable id could never be opened anyway (meetingPath
    // refuses it) — leave it alone rather than stamping metadata onto it.
    if (meta || !safeId(id)) continue
    await writeMeta(join(root, id), {
      id,
      // The slug half of the old id, verbatim — `sprint-planning` stays `sprint-planning`
      // rather than being guessed back into `sprint planning`, since a real title can
      // contain hyphens and there is no way to tell the two apart afterwards. An id that
      // was never a stamped one at all (a folder the user made by hand) keeps its whole
      // name as the title.
      title: titlePartOf(id) ?? id,
      startedAt: transcript?.startedAt ?? startedAtFromId(id) ?? '',
    })
    written++
  }
  return written
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
 * Drops mic lines that are the room's own speakers coming back in.
 *
 * The two tracks are recorded and transcribed separately (spec §4.1): `loopback` is
 * what the meeting app played, `mic` is what the microphone heard. On speakers rather
 * than headphones the microphone hears both — so the far end's own sentence is
 * transcribed twice, once under their name and once, a moment later and often cut
 * short, under "You". Nothing downstream can tell those apart afterwards, and
 * diarization happily files the echo as its own speaker.
 *
 * The near-end signal never leaks the other way (the loopback track is system output;
 * your voice is not in it), so the mic copy is always the one to drop.
 *
 * Deliberately a text-and-time match rather than acoustic echo cancellation, which is
 * the real answer and needs an adaptive filter running against the loopback signal at
 * capture time — far more than this buys. ponytail: heuristic, and the ceiling is
 * visible — someone deliberately repeating a long sentence back within a couple of
 * seconds loses their copy of it. `MIN_ECHO_CHARS` keeps that away from the short
 * agreements ("ครับ", "ok") people genuinely say over each other all the time, and the
 * whole pass is off with one setting.
 */
const MIN_ECHO_CHARS = 10
/** Compared with spacing and punctuation removed: whisper punctuates the same audio
 * differently depending on how much of it a chunk contained, so the echo copy is
 * rarely character-identical to the original. */
const normalize = (text: string): string => text.replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase()

export function dropEchoedMic(segments: Transcript['segments'], withinSec = 2): Transcript['segments'] {
  const others = segments.filter((s) => s.speaker !== 'me').map((s) => ({ ...s, text: normalize(s.text) }))
  if (others.length === 0) return segments

  return segments.filter((segment) => {
    if (segment.speaker !== 'me') return true
    const mine = normalize(segment.text)
    if (mine.length < MIN_ECHO_CHARS) return true
    return !others.some((other) => {
      // Overlapping in time, give or take the lag between something being played and
      // the microphone hearing it.
      if (other.t1 + withinSec < segment.t0 || segment.t1 + withinSec < other.t0) return false
      // Either direction: the echo is usually the shorter of the two (the microphone
      // catches the tail end of a sentence, or whisper cuts the chunk differently), but
      // it can be the longer one when the far end's own line was the clipped one.
      return other.text.startsWith(mine) || mine.startsWith(other.text)
    })
  })
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
 *
 * Deliberately a real delete, not the Trash, in BOTH cases here — but index.ts sends the
 * whole-meeting case to the Trash before ever reaching this, and only the audio-only
 * case actually lands on the `!keepTranscript` branch through the app. Reclaiming disk
 * is the entire point of dropping the audio, and a 350MB file sitting in the Trash has
 * not reclaimed anything.
 */
export async function deleteMeeting(id: string, keepTranscript: boolean, root = NOTES_ROOT): Promise<void> {
  const dir = meetingPath(id, root)
  if (!keepTranscript) {
    await rm(dir, { recursive: true, force: true })
    return
  }
  for (const track of ['loopback', 'mic']) await rm(join(dir, `${track}.wav`), { force: true })
}

/** A meeting's folder, with the id checked first — for the one caller that has to act
 * on the folder itself rather than ask this module to (index.ts moves it to the Trash,
 * which needs Electron and so cannot happen in here). */
export function meetingPath(id: string, root = NOTES_ROOT): string {
  if (!safeId(id)) throw new Error(`not a meeting: ${id}`)
  return join(root, id)
}

/**
 * Sets a saved meeting's title, which is now the whole operation: the title lives in
 * meeting.json, so nothing moves and the id does not change.
 *
 * It used to have to move the folder, because the title was half the folder name — and
 * so the id changed under every store that had written one down, which is why voices.ts
 * needed a pass to follow a rename at all. Freetext, too: a title no longer has to
 * survive being a path component, so it is stored exactly as typed.
 */
export async function setMeetingTitle(id: string, title: string, root = NOTES_ROOT): Promise<void> {
  const dir = meetingPath(id, root)
  const meta = await readMeta(dir)
  const transcript = meta ? null : await readTranscript(dir).catch(() => null)
  await writeMeta(dir, {
    id,
    title: title.trim(),
    startedAt: meta?.startedAt ?? transcript?.startedAt ?? startedAtFromId(id) ?? '',
  })
}

/**
 * Drops a "speaker" that turned out not to be one — their lines go with them.
 *
 * Diarization clusters whatever is voice-shaped, so a door, a cough, a fan or a burst
 * of hold music comes back as a person with a few lines of hallucinated text under
 * them. Until now the only thing the speaker editor could do with that row was name it:
 * there was no way to say "this is not a person", and the noise stayed in the transcript
 * and in every summary built from it.
 *
 * Segments, not just the name — an unnamed cluster's text is exactly what makes it
 * worth deleting. `speakerVoices` loses the key too, so nothing points at a voice that
 * this meeting no longer has any audio filed under (the caller, index.ts, is what then
 * forgets the pending voice itself).
 */
export function dropSpeakers(transcript: Transcript, labels: string[]): Transcript {
  const drop = new Set(labels)
  const kept = <T,>(record: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(record).filter(([key]) => !drop.has(key)))
  return {
    ...transcript,
    speakers: kept(transcript.speakers),
    segments: transcript.segments.filter((segment) => !drop.has(segment.speaker)),
    ...(transcript.speakerVoices ? { speakerVoices: kept(transcript.speakerVoices) } : {}),
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
    .map(({ id, meta, transcript }) => {
      const startedAt = meta?.startedAt || transcript?.startedAt || startedAtFromId(id) || ''
      return {
        id,
        // The stored title, resolved to a readable time for a meeting nobody named —
        // the same rule the composer's placeholder promises (shared/meetings.ts).
        title: displayTitle(meta?.title ?? '', startedAt),
        startedAt,
        durationSec: transcript?.durationSec ?? 0,
        transcribed: meetingDone(transcript),
        language: transcript?.language ?? null,
      }
    })
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

function renderMarkdown(t: Transcript, title: string): string {
  const clock = (sec: number) => {
    const p = (n: number) => String(Math.floor(n)).padStart(2, '0')
    return `${p(sec / 60)}:${p(sec % 60)}`
  }
  const lines = t.segments.map(
    (s) => `**${t.speakers[s.speaker] ?? s.speaker}** \`${clock(s.t0)}\`  ${s.text}`,
  )
  return [`# ${title}`, '', `${t.startedAt} · ${Math.round(t.durationSec / 60)} นาที`, '', ...lines, ''].join('\n')
}
