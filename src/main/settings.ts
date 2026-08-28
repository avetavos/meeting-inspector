import { access, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PREFERRED_PORT } from './mcp.ts'
import { MEETING_LANGUAGES, type MeetingLanguage } from '../shared/meetings.ts'
// Re-exported: everything outside this file that used to import MeetingLanguage from
// here (preload/index.ts, renderer/main.ts) still can — only the definition moved, to
// shared/meetings.ts, so a Transcript can carry it without dragging this file's
// electron import along.
export { MEETING_LANGUAGES, type MeetingLanguage } from '../shared/meetings.ts'
export type Language = 'en' | 'th'

/** How hard to work at ignoring everything that is not speech. Rooms differ. */
export type NoiseFilter = 'low' | 'medium' | 'high'

/**
 * 'after': nothing is transcribed while recording — whisper-server (3.4GB RSS) never
 * spawns during the meeting, and the whole recording is transcribed in one pass at the
 * end. 'live': today's behaviour, transcript fills in as people talk. 'manual': like
 * 'after' but the automatic pass at the end is skipped too — the recording is left
 * untranscribed until the user picks it from the meetings list, alone or batched with
 * others, so a day of back-to-back recordings can be transcribed unattended overnight
 * instead of costing a pass after every single one.
 */
export type TranscribeMode = 'after' | 'live' | 'manual'

/**
 * Which whisper model transcribes speech — bigger is not simply "better": 'medium'
 * sits between the other two on RAM but is the slowest of the three. Measured on this
 * machine against 27 technical terms in a Thai + English dev-meeting recording:
 *   turbo  (ggml-large-v3-turbo-q5_0.bin): 0.78 GB RSS, 14.2x realtime, ~2 min per
 *          30 min of audio, 22/27 terms — lightest and fastest by far.
 *   medium (ggml-medium.bin):              1.96 GB RSS,  3.8x realtime, ~8 min per
 *          30 min of audio, 25/27 terms — better jargon than turbo under 2 GB, but
 *          the slowest of the three.
 *   large  (ggml-large-v3.bin):            3.43 GB RSS,  5.3x realtime, ~6 min per
 *          30 min of audio, 26/27 terms — most accurate, most RAM.
 * 'small' and 'base' are deliberately not offered: 13/27 and 5/27 terms on the same
 * test, not usable for this team's jargon.
 */
export type AsrModel = 'turbo' | 'medium' | 'large'

export type Settings = {
  /** On by default: leaving the app open is how a connected assistant reaches it. */
  mcp: boolean
  /** UI language. English by default; Thai is one switch away in settings. */
  language: Language
  /**
   * The current default: what a new recording captures as its own Transcript.language
   * (session:start, index.ts) and never re-reads afterwards, plus the fallback
   * store.ts's `resolveLanguage` uses for a meeting that predates that field. Not
   * `Language` above, which is the UI's own EN/TH strings; a Thai interface
   * transcribing an English meeting is a normal combination, so the two must never be
   * coupled. Default 'th': this is a Thai team's tool, and that is today's (implicit)
   * behaviour before this setting existed.
   *
   * Guessing wrong is expensive, not just wrong: measured on this machine (same audio,
   * only this setting changed), an all-English meeting decoded as 'th' cost 9.0% CER
   * (17/18 terms) vs. 0.6% CER (18/18 terms) decoded as 'en'. A Thai meeting decoded as
   * 'en' cost 34.0% CER (21/27 terms) vs. 15.7% CER (22/27 terms) decoded as 'th'.
   */
  meetingLanguage: MeetingLanguage
  noiseFilter: NoiseFilter
  transcribeMode: TranscribeMode
  /** Default 'turbo': lightest on RAM, and the default recording mode ('after') means
   * this is what most 16GB machines will run unattended. */
  asrModel: AsrModel
  /** Port the MCP server should hold. Client configs name it, so it is worth keeping. */
  mcpPort: number
  /**
   * Whether the first-run onboarding flow has been completed (or skipped past its
   * finish step). Not simply "false when absent" like every other field above: a
   * missing settings.json means a genuine first run, but an existing settings.json
   * that merely predates this field means someone upgrading into this build, who must
   * not be dropped into onboarding on their next launch. getSettings() below tells the
   * two apart by whether the file existed at all, not by this field's own value.
   */
  onboarded: boolean
}

/** Below 1024 needs root; the app has no business asking for that. Exported so the
 * main-process write path can reject garbage instead of trusting the renderer's copy
 * of this same check. */
export const validPort = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= 1024 && n <= 65535

// mcp.ts's PREFERRED_PORT is the single source of truth for 8787 — a second literal
// here would silently disagree with it if either one moved, and portMoved would start
// lying.
const DEFAULTS: Settings = {
  mcp: true,
  language: 'en',
  meetingLanguage: 'th',
  noiseFilter: 'medium',
  transcribeMode: 'after',
  asrModel: 'turbo',
  mcpPort: PREFERRED_PORT,
  // Never actually used as-is — both return paths below compute this from whether
  // settings.json existed, not from this placeholder. Present only so the object
  // satisfies Settings' type.
  onboarded: false,
}
/**
 * Electron is imported lazily (same pattern as voices.ts's voicesFile()) so this
 * module can be exercised outside the app — settings.ts used to import `electron` at
 * module scope, which meant the `onboarded` rule below (whether an existing user gets
 * dumped into onboarding on upgrade) had zero test coverage, since nothing importing
 * `electron` can be loaded under plain `node:test`.
 */
async function settingsFile(): Promise<string> {
  const override = process.env['SETTINGS_FILE']
  if (override) return override
  const { app } = await import('electron')
  return join(app.getPath('userData'), 'settings.json')
}

/**
 * Reads only the keys this version knows about. Spreading the file wholesale kept
 * settings from removed features alive forever — a stale `provider` and `workerUrl`
 * outlived the code that used them — and let a corrupt value through unchecked.
 */
export async function getSettings(): Promise<Settings> {
  const file = await settingsFile()
  // Checked separately from the read below: a file that exists but fails to parse
  // (corrupt) still means someone had already set this app up, so it must not read as
  // a fresh install and force onboarding on them — only a file that never existed at
  // all does that.
  const fileExisted = await access(file).then(() => true, () => false)
  try {
    const stored = JSON.parse(await readFile(file, 'utf8')) as Partial<Settings>
    return {
      mcp: typeof stored.mcp === 'boolean' ? stored.mcp : DEFAULTS.mcp,
      language: stored.language === 'th' || stored.language === 'en' ? stored.language : DEFAULTS.language,
      meetingLanguage: MEETING_LANGUAGES.includes(stored.meetingLanguage as MeetingLanguage)
        ? (stored.meetingLanguage as MeetingLanguage)
        : DEFAULTS.meetingLanguage,
      noiseFilter: ['low', 'medium', 'high'].includes(stored.noiseFilter as string)
        ? (stored.noiseFilter as NoiseFilter)
        : DEFAULTS.noiseFilter,
      transcribeMode:
        stored.transcribeMode === 'live' || stored.transcribeMode === 'after' || stored.transcribeMode === 'manual'
          ? stored.transcribeMode
          : DEFAULTS.transcribeMode,
      asrModel: ['turbo', 'medium', 'large'].includes(stored.asrModel as string)
        ? (stored.asrModel as AsrModel)
        : DEFAULTS.asrModel,
      mcpPort: validPort(stored.mcpPort) ? stored.mcpPort : DEFAULTS.mcpPort,
      onboarded: typeof stored.onboarded === 'boolean' ? stored.onboarded : fileExisted,
    }
  } catch {
    return { ...DEFAULTS, onboarded: fileExisted }
  }
}

// LOW 11: settings:set (index.ts) spreads a renderer-supplied patch straight in — an
// unknown key (a stale field from a removed setting, or a typo) used to ride along in
// `next` and get written to disk, where it would sit unread forever and the file would
// grow without bound. getSettings() already re-validates every KNOWN field on the way
// back out, so this alone was hygiene rather than a live bug (nothing downstream ever
// trusted the stray key) — filtering it out here keeps the file itself honest too.
const KNOWN_KEYS = new Set<string>(Object.keys(DEFAULTS))

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const known = Object.fromEntries(Object.entries(patch).filter(([key]) => KNOWN_KEYS.has(key)))
  const next = { ...(await getSettings()), ...known }
  const file = await settingsFile()
  // Write-then-rename, not a direct write (LOW-MEDIUM 6): `writeFile` truncates the
  // file before writing its new content, so a crash or power loss mid-write left a
  // truncated settings.json — getSettings()'s catch branch then silently reset
  // everything to DEFAULTS (model back to turbo, port back to 8787, ...) while
  // `onboarded` still resolved true, so onboarding never came back to help either.
  // `rename` within the same directory is atomic: the file other readers ever see is
  // either the old complete one or the new complete one, never a partial write.
  // Onboarding writing several settings in quick succession made this more reachable.
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(next, null, 2))
  await rename(tmp, file)
  // Re-read rather than returning `next` verbatim: a caller can pass an unknown key or
  // an out-of-range value (an IPC handler is never as trustworthy as this module's own
  // callers), and getSettings() is the one place that already knows how to validate it.
  return getSettings()
}
