import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, session, shell, systemPreferences, type WebContents } from 'electron'
import { createReadStream } from 'node:fs'
import { mkdir, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { pipeline } from 'node:stream'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { runBatch, type BatchProgress } from './batch.ts'
import { Chunker, SAMPLE_RATE, type Chunk } from './chunker.ts'
import { SPEAKER_SPLIT_THRESHOLD, assignSpeakers, diarize, foldBriefSpeakers, loopbackSpeakers, speakerNames, type SpeakerLabels } from './diarize.ts'
import { ASR_MODELS, MODELS, downloadModel, modelStatus, type ModelSpec, type ModelStatus } from './download.ts'
import { PREFERRED_PORT, startMcp, type McpHandle } from './mcp.ts'
import { model } from './models.ts'
import { displayTitle, safeId, startedAtFromId, type LiveMeeting, type MeetingLanguage } from '../shared/meetings.ts'
import { TRACKS, transcribeRecorded, type ReplayServer, type Track } from './replay.ts'
import { mcpToken, openrouterKey, setOpenrouterKey } from './token.ts'
import { Remote, connect as connectOpenrouter } from './openrouter.ts'
import { getSettings, setSettings, validPort, type AsrModel, type Language, type Settings } from './settings.ts'
import { hasSpeech } from './vad.ts'
import {
  discardPending,
  forget,
  identify,
  knownVoices,
  nameVoice,
  pendingVoices,
  remember,
  renameVoices,
  resolveSpeakerNames,
  sampleWav,
  trackPending,
} from './voices.ts'
import {
  NOTES_ROOT,
  assertMeetingDir,
  createMeetingDir,
  deleteMeeting,
  dropEchoedMic,
  dropSpeakers,
  finishReplayTranscript,
  listMeetings,
  localIso,
  meetingPath,
  micTestLocked,
  migrateMeetingMeta,
  readMeta,
  readTranscript,
  resolveLanguage,
  setMeetingTitle,
  setSpeakerCount,
  transcribeStatus,
  transcriptionBusy,
  writeTranscript,
  type Transcript,
} from './store.ts'
import { bundlePathOf, clearUpdateLeftovers, downloadUpdate, installUpdate, latestUpdate, type UpdateInfo } from './update.ts'
import { WavWriter } from './wav.ts'
import { DEFAULT_PROMPT, Whisper } from './whisper.ts'

/** Decision 4.1: two tracks, never mixed — the mic track is "me" without any diarization. */
type Session = {
  id: string
  dir: string
  startedAt: number
  writers: Record<Track, WavWriter>
  chunkers: Record<Track, Chunker>
  segments: Transcript['segments']
  /** Set the moment stop begins: late PCM frames must not reach a closed writer. */
  stopping: boolean
  /** Read once at session:start — a mode flip mid-recording must not change how the
   * frames already being written are handled. */
  mode: Settings['transcribeMode']
  /** Read once at session:start, same as `mode` above and for the same reason: a
   * meetingLanguage change in Settings while this meeting is recording (or, for
   * 'after' mode, still being transcribed at session:stop) must not change what an
   * already-running pass decodes as. Carried into every Transcript this session
   * writes (spec item 1). */
  language: MeetingLanguage
}

/**
 * Written into transcript.json, so they follow the UI language at the time of the
 * meeting. Diarization replaces `them`; the user can rename either afterwards.
 */
const SPEAKER_LABELS: Record<Language, SpeakerLabels> = {
  en: { me: 'You', them: 'Others', speaker: (n) => `Speaker ${n}` },
  th: { me: 'คุณ', them: 'คนอื่น', speaker: (n) => `ผู้พูด ${n}` },
}

const speakerLabels = async (): Promise<SpeakerLabels> => SPEAKER_LABELS[(await getSettings()).language]

const defaultSpeakers = async (): Promise<Record<string, string>> => {
  const { me, them } = await speakerLabels()
  return { me, them }
}

/** The mic track is us by construction (spec §4.1); `them` is replaced by diarization. */
const SPEAKER: Record<Track, string> = { mic: 'me', loopback: 'them' }
let current: Session | null = null
// Claimed synchronously at the top of session:start, before its first await
// (createMeetingDir/WavWriter.open) — `current` itself is not set until those finish,
// so without this batch:start's own synchronous check could slip through that window
// and start a batch while a live session is still spinning up (MEDIUM 5).
let sessionStarting = false

// Set together, synchronously, at the top of session:stop, and cleared together in
// its `finally` — before-quit (HIGH 1) reads both while `current.stopping` is true to
// abort an in-flight 'after'-mode pass and then wait for the transcript it still
// writes, partial or not, rather than quitting out from under it.
let stopAbort: AbortController | null = null
let stopInFlight: Promise<void> | null = null

// The batch queue's currently-running meeting catches whisper's segments here instead
// of `current.segments` — the two never run at once (session:start refuses while a
// batch is running, batch:start refuses while `current` is set), so onSegments below
// only ever has one live destination at a time.
let batchSink: Transcript['segments'] | null = null

// One server for the app's lifetime: the 3GB model loads once, and by the time
// anyone presses record it is already warm. Chunks queue if it is still loading.
let whisper: Promise<Whisper> | null = null

function transcription(wc: WebContents): Promise<Whisper> {
  whisper ??= getSettings()
    .then((settings) =>
      Whisper.start({
        language: 'th',
        model: model(ASR_MODELS[settings.asrModel].file),
        prompt: DEFAULT_PROMPT,
        noiseFilter: async () => (await getSettings()).noiseFilter,
        onSegments: (track, segments) => {
          const withSpeaker = segments.map((s) => ({ ...s, speaker: SPEAKER[track as Track] }))
          if (current) {
            current.segments.push(...withSpeaker)
            // Only the live recording session's own transcript panel wants to hear
            // about these as they arrive — a batch item transcribing an older meeting
            // in the background must not spam whatever the user is looking at now.
            wc.send('transcript:segments', track, segments)
          } else {
            batchSink?.push(...withSpeaker)
          }
        },
        onDepth: (depth) => wc.send('transcript:queue', depth),
      }),
    )
    .catch((err: unknown) => {
      whisper = null // let the next recording retry rather than wedging for good
      wc.send('transcript:error', String(err))
      throw err
    })
  return whisper
}

/**
 * Gives the 3GB model back once nothing needs it, so a recording no longer costs
 * whisper-server's RSS for the rest of the app's life. Never call this while a live
 * recording is in progress — chunks are still arriving, and reloading the model
 * mid-meeting would be far worse than holding it.
 */
/**
 * The engine a recorded pass should run through: whisper on this machine, or the user's
 * chosen model at OpenRouter (spec: settings.ts's asrEngine).
 *
 * Falls back to whisper rather than failing when 'openrouter' is selected with no key —
 * a setting pointing at a key that has since been removed must not turn every recorded
 * meeting into an error, and the local engine is the one that always works. Only the
 * recorded paths call this; live transcription is whisper's alone (`transcription`).
 */
async function replayEngine(wc: WebContents): Promise<ReplayServer> {
  const settings = await getSettings()
  const key = settings.asrEngine === 'openrouter' ? await openrouterKey() : ''
  if (!key) return transcription(wc)
  return new Remote({
    apiKey: key,
    model: settings.remoteModel,
    noiseFilter: async () => (await getSettings()).noiseFilter,
    onSegments: (track, segments) => {
      const withSpeaker = segments.map((s) => ({ ...s, speaker: SPEAKER[track as Track] }))
      if (current) current.segments.push(...withSpeaker)
      else batchSink?.push(...withSpeaker)
    },
  })
}

function releaseWhisper(): void {
  const pending = whisper
  whisper = null
  void pending?.then((w) => w.stop()).catch(() => {})
}

/**
 * Runs once a meeting ends (spec §4.2). Kicked off without awaiting: the recording is
 * already safely on disk, so this can take its time on a long file.
 *
 * `notify` gates the two events that drive the main transcript panel. session:stop
 * (the meeting the user was just watching) wants them; the batch queue (spec item 4)
 * diarizing an older meeting in the background does not — sending them there would
 * silently overwrite whatever meeting the user actually has open right now. The
 * meetings panel already covers a batch item end to end with its own "Transcribing…"
 * status, so it does not need a separate diarizing sub-state.
 *
 * `signal`, if given, is only checked once before the (uninterruptible — see diarize.ts)
 * native clustering call starts: cancelling a batch pass mid-diarize cannot stop that one
 * meeting's diarization early (MEDIUM 5's real ceiling — sherpa's `process()` blocks the
 * event loop for the length of the call, nothing can pre-empt it), but it does stop the
 * queue from starting the *next* meeting's.
 */
async function diarizeMeeting(wc: WebContents, dir: string, notify = true, signal?: AbortSignal): Promise<boolean> {
  if (notify) wc.send('meeting:diarizing')
  try {
    // The headcount the user gave for THIS meeting, if any — it beats every threshold,
    // because the threshold is only ever a guess at what the count would have told us
    // outright (diarize.ts's clusteringFor).
    const turns = await diarize(
      join(dir, 'loopback.wav'),
      signal,
      SPEAKER_SPLIT_THRESHOLD[(await getSettings()).speakerSplit],
      loopbackSpeakers((await readMeta(dir))?.speakerCount),
    )
    const previous = await readTranscript(dir)
    // Noise clustered as people is folded away before anyone is asked to name it —
    // see foldBriefSpeakers' own comment for the threshold and the trade.
    const segments = foldBriefSpeakers(assignSpeakers(previous.segments, turns))
    // HIGH 3: previous.speakerVoices tells speakerNames() which keys not to trust a
    // stale name from — a key it recognised (named or pending) last pass is about to
    // be re-checked by identify() below, and a wrong guess in the meantime is worse
    // than a placeholder (see speakerNames' own doc comment).
    const named = speakerNames(segments, previous.speakers, await speakerLabels(), previous.speakerVoices)

    // A voice the user has named before comes back with its name already on it.
    const withTranscript: Transcript = { ...previous, segments, speakers: named }
    // Rebuilt from nothing every pass, never merged with previous.speakerVoices — a raw
    // speaker key means someone different every diarize run (see Transcript.speakerVoices'
    // own doc comment), so an old entry under a reused key would be actively wrong, not
    // just stale.
    const recognizedVoices: NonNullable<Transcript['speakerVoices']> = {}
    for (const speaker of Object.keys(named)) {
      if (speaker === 'me' || speaker === 'them') continue
      const known = await identify(dir, withTranscript, speaker).catch(() => null)
      if (known) {
        named[speaker] = known.name
        recognizedVoices[speaker] = { voiceId: known.id, name: known.name }
        continue
      }
      // Not a voice the app can name — cluster it against every other not-yet-named
      // voice (spec item 1) so the same stranger heard again, here or in a later
      // meeting, lands on the same pending entry instead of a fresh one. `named[speaker]`
      // is already the placeholder speakerNames() gave it just above; recorded as the
      // fallback display name (Transcript.speakerVoices' own doc comment) in case this
      // voice is later forgotten before ever being named.
      const pendingId = await trackPending(dir, withTranscript, speaker, basename(dir)).catch(() => null)
      if (pendingId) recognizedVoices[speaker] = { voiceId: pendingId, name: named[speaker]! }
    }

    const updated: Transcript = { ...withTranscript, speakers: named, speakerVoices: recognizedVoices }
    await writeTranscript(dir, updated)
    if (notify) {
      // The disk copy above stays raw (speaker keys, this pass's own placeholders) —
      // only what's handed to the renderer is resolved to the *current* voices.json
      // name (spec item 3), so a rename elsewhere never needs a rewrite pass here.
      const speakers = await resolveSpeakerNames(updated.speakers, updated.speakerVoices)
      wc.send('meeting:transcript', dir, { ...updated, speakers })
    }
    return true
  } catch (err) {
    // A deliberate cancel is not a failure worth logging — same treatment as
    // whisper.ts's pump() gives an aborted chunk.
    if (!signal?.aborted) console.error(`diarize: ${dir}`, err)
    if (notify) wc.send('meeting:diarize-error', String(err))
    // Reported, not thrown: every existing caller is fire-and-forget and a meeting whose
    // diarize pass failed still has its transcript, just without speakers split. The one
    // caller that must know is meeting:rediarize, which was asked to do exactly this and
    // would otherwise hand back the unchanged transcript as though it had worked.
    return false
  }
}

async function enqueue(wc: WebContents, track: Track, chunk: Chunk, language: MeetingLanguage, retry = true): Promise<void> {
  try {
    const server = await transcription(wc)
    // A dead whisper-server would swallow this chunk and every one after it without
    // anyone noticing, so start a fresh one and say so.
    if (!server.alive && retry) {
      whisper = null
      wc.send('transcript:error', 'whisper-server หยุดไป กำลังเริ่มใหม่ — ท่อนที่ค้างอยู่อาจหาย')
      return enqueue(wc, track, chunk, language, false)
    }
    server.enqueue(track, chunk, language)
  } catch {
    // transcription() already pushed the error to the renderer
  }
}

/**
 * Stands in for a transcript.json that is missing or corrupt — exactly the "recorded
 * but nothing usable came out of it" case the meetings list exists to surface (spec
 * item 3), so transcribeOne must be able to (re-)transcribe it rather than fail before
 * it even starts. Duration comes straight off the WAV files already on disk.
 */
async function fallbackTranscript(id: string, dir: string): Promise<Transcript> {
  const sizes = await Promise.all(
    TRACKS.map((track) =>
      stat(join(dir, `${track}.wav`))
        .then((st) => Math.max(0, st.size - 44))
        .catch(() => 0),
    ),
  )
  return {
    id,
    // meeting.json is written the moment the folder is (createMeetingDir), so it is the
    // answer here even when nothing else in the folder survived; the id parse is only
    // for a pre-uuid meeting that somehow got past the startup migration.
    startedAt: (await readMeta(dir))?.startedAt || startedAtFromId(id) || localIso(new Date()),
    durationSec: Math.max(...sizes) / 2 / SAMPLE_RATE,
    speakers: await defaultSpeakers(),
    segments: [],
  }
}

/**
 * One meeting from the batch queue (spec item 4): transcribes it exactly the way
 * 'after' mode does at session:stop. `finishReplayTranscript` (store.ts) is what
 * decides whether transcript.json gets written at all — HIGH 2: a meeting whose WAVs
 * are now missing or empty (e.g. deleted to reclaim disk after an earlier successful
 * transcription) must not have its existing transcript overwritten with empty
 * segments, so that case throws instead of returning a value, and this function writes
 * nothing and rethrows, leaving transcript.json exactly as it was.
 *
 * Deliberately does NOT diarize (unlike the single-recording path at session:stop) —
 * the caller (batch:start) diarizes every meeting this returns for, in a second pass,
 * only after the whole queue's transcription is done and whisper-server has been
 * released (MEDIUM 4): diarize.ts's ~1GB peak plus voices.ts re-reading each speaker's
 * WAV must never be concurrent with whisper's own 0.8-3.4GB RSS, or the two together
 * blow the RAM budget the settings UI advertises on a 16GB machine.
 */
async function transcribeOne(
  wc: WebContents,
  id: string,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
): Promise<string> {
  const dir = assertMeetingDir(join(NOTES_ROOT, id))
  const previous = await readTranscript(dir).catch(() => fallbackTranscript(id, dir))
  // The meeting's own recorded language wins; only a meeting that predates this field
  // (previous.language is undefined) falls back to today's setting — spec item 1.
  const language = resolveLanguage(previous.language, (await getSettings()).meetingLanguage)
  const collected: Transcript['segments'] = []
  batchSink = collected
  let total: number
  try {
    const server = await replayEngine(wc)
    total = await transcribeRecorded(server, dir, language, onProgress, signal)
  } finally {
    batchSink = null
  }
  // writeTranscript (store.ts) sorts segments by t0 before persisting — no need to do
  // it twice. Heals a legacy meeting along the way: once `language` is resolved (even
  // via the fallback above), it is persisted, so a second retroactive pass over the
  // same meeting no longer needs the fallback at all.
  // Same echo removal the live path applies — a retroactive pass reads the very same
  // two tracks, so it has the very same duplicates to drop.
  const settings = await getSettings()
  const heard = settings.echoFilter ? dropEchoedMic(collected) : collected
  await writeTranscript(dir, finishReplayTranscript(previous, heard, language, total))
  return dir
}

let downloads: AbortController | null = null
/** One update at a time, and cancellable while the download is still running — the
 * install itself is a few seconds of file moves with nothing worth interrupting. */
let updating: AbortController | null = null
/** Path of a .dmg already downloaded and waiting to be put in place — either right
 * away, or at quit (installOnQuit). Kept in main rather than handed back to the
 * renderer: it is a path on disk that only main is allowed to act on. */
let downloadedUpdate: string | null = null
let installOnQuit = false

/**
 * The app's one window, once it exists. Kept because the extension's mic report arrives
 * over HTTP with no `WebContents` attached to it — every other event main sends has a
 * request or a session to send it back through, and this one has neither.
 */
let mainWindow: BrowserWindow | null = null

/**
 * The app bundle to replace, or null when there is nothing legitimate to replace.
 * `isPackaged`, not just "is there an .app above the executable": under electron-vite
 * dev/preview there IS one — Electron's own, inside node_modules — and putting a
 * Meeting Inspector build there would wreck the dev install.
 */
const updateBundle = (): string | null => (app.isPackaged ? bundlePathOf(app.getPath('exe')) : null)

async function wipeDownloadedUpdate(): Promise<void> {
  const dmg = downloadedUpdate
  downloadedUpdate = null
  if (dmg) await rm(dirname(dmg), { recursive: true, force: true }).catch(() => {})
}

// The meetings-list batch queue (spec item 4). `batchFailed` is runtime-only — a
// restart forgets it, which is fine: the meeting really is still untranscribed, so it
// reads that way again rather than lying "done" or staying stuck "failed" forever.
let batchController: AbortController | null = null
let batchRunningId: string | null = null
const batchFailed = new Set<string>()

let mcp: McpHandle | null = null

/**
 * The meeting being recorded right now, for the `current_meeting` MCP tool — straight
 * out of `current`, with no disk read of the transcript at all, so an assistant asked a
 * question mid-meeting gets every line decoded so far rather than everything up to the
 * last flush (startLiveFlush, up to fifteen seconds behind).
 *
 * The title still comes from meeting.json, which was written when the folder was
 * (createMeetingDir) and is the one place a title lives.
 */
async function currentMeeting(): Promise<LiveMeeting | null> {
  const s = current
  if (!s) return null
  const meta = await readMeta(s.dir).catch(() => null)
  return {
    id: s.id,
    title: displayTitle(meta?.title ?? '', meta?.startedAt ?? localIso(new Date(s.startedAt))),
    startedAt: localIso(new Date(s.startedAt)),
    // The loopback track: both writers receive the same frames at the same rate, and
    // this is the one that carries the meeting itself.
    recordedSec: s.writers.loopback.durationSec,
    // 'after' and 'manual' decode nothing until the recording ends, so an empty
    // `segments` under those means "not decoded yet", not "nobody spoke" — which is
    // exactly what this flag exists to let the assistant say (LiveMeeting's own doc).
    transcribing: s.mode === 'live',
    speakers: await defaultSpeakers(),
    segments: s.segments,
  }
}

// startMcp's retry ladder can take a few hundred ms. Three IPC handlers can call
// restartMcp() close together (toggle, port change, the un-awaited call at startup),
// and without serializing them a slower call's assignment could overwrite a faster
// one's, orphaning a bound server nothing can ever close. Chaining onto this promise
// (and always resolving it, even on failure, so one failed restart doesn't wedge every
// restart after it) makes restarts run one at a time.
let restartChain: Promise<void> = Promise.resolve()

function restartMcp(): Promise<void> {
  const run = restartChain.catch(() => {}).then(doRestart)
  restartChain = run.catch(() => {})
  return run
}

async function doRestart(): Promise<void> {
  await mcp?.close()
  mcp = null
  if (!(await getSettings()).mcp) return
  const handle = await startMcp({
    token: await mcpToken(),
    root: NOTES_ROOT,
    port: (await getSettings()).mcpPort,
    // The browser extension's report of the meeting's own mute button. Sent to the
    // window rather than acted on here: muting is the renderer's — it owns the capture,
    // and it is also where the button the user might have just pressed lives.
    onMic: (muted) => mainWindow?.webContents.send('mic:external', muted),
    // Read at request time, never captured: `current` is null between meetings and a
    // different session on either side of one, so the closure has to look it up when
    // the question is actually asked.
    live: currentMeeting,
  })
  // Settings can change while startMcp() was retrying — e.g. the user flipped MCP
  // off during those few hundred ms. Since restarts are serialized, nothing else
  // could have already reassigned `mcp` out from under us, so this check is only
  // about whether we're still meant to be on; if not, close what we just opened
  // rather than leave it listening with the toggle off.
  if (!(await getSettings()).mcp) {
    await handle.close()
    return
  }
  mcp = handle
}

async function mcpState() {
  const { mcp: enabled, mcpPort } = await getSettings()
  return {
    enabled,
    url: mcp?.url ?? null,
    token: mcp ? await mcpToken() : null,
    requestedPort: mcpPort,
    port: mcp?.port ?? null,
    defaultPort: PREFERRED_PORT,
    // Anything else means the saved client configs are pointing at the wrong place.
    portMoved: mcp !== null && mcp.port !== mcpPort,
  }
}

function installDisplayMediaHandler(): void {
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_req, callback) => {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        // 4x4 rather than 0x0 — 0x0 trips GPU texture wrapping errors (electron#49607).
        thumbnailSize: { width: 4, height: 4 },
      })
      const screen = sources[0]
      if (!screen) return callback({})
      callback({ video: screen, audio: 'loopback' })
    },
    { useSystemPicker: false },
  )
}

function permissions() {
  return {
    // Loopback audio rides on Screen Recording: ScreenCaptureKit ties system audio to it.
    screen: systemPreferences.getMediaAccessStatus('screen'),
    microphone: systemPreferences.getMediaAccessStatus('microphone'),
  }
}

const PRIVACY_PANE: Record<'screen' | 'microphone', string> = {
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
}

/**
 * The transcript a recording session currently amounts to — used both by the periodic
 * flush below, mid-recording, and by finishSessionStop once the WAVs are closed. One
 * builder so a partial write and the final one can never disagree about anything but
 * `durationSec` and `done`.
 *
 * `done` becomes `transcribedAt`, and is only true once an ASR pass has actually run
 * over this meeting AND gotten through every chunk (spec item 2) — 'manual' mode leaves
 * it unset on purpose, a failed 'live'/'after' pass leaves it unset too, and a flush
 * mid-recording obviously never sets it. All of those read as "not transcribed yet" via
 * meetingDone (store.ts): `language` below is always set regardless, which is exactly
 * the signal meetingDone uses to tell a withheld-on-purpose write apart from a
 * transcript written before either field existed (segments alone used to read as done
 * either way — the trap the takeFailures()/transcribeOk plumbing exists to close).
 */
async function sessionTranscript(s: Session, durationSec: number, done: boolean): Promise<Transcript> {
  return {
    id: s.id,
    startedAt: localIso(new Date(s.startedAt)),
    durationSec,
    speakers: await defaultSpeakers(),
    // writeTranscript (store.ts) sorts by t0 before persisting — no need to do it
    // twice, even though 'after' mode transcribing the two tracks one after another
    // means these arrive with every mic segment after every loopback segment.
    // The microphone hears the meeting's own speakers on anything but headphones, so
    // the far end's sentences arrive twice — once from the loopback track under their
    // name, once from the mic a moment later under "You" (dropEchoedMic, store.ts).
    segments: (await getSettings()).echoFilter ? dropEchoedMic(s.segments) : s.segments,
    // Written unconditionally, in every mode — 'manual' mode writes no segments at all,
    // so this is the ONLY chance to record what language this meeting was spoken in; the
    // batch queue reads it back via resolveLanguage whenever the user eventually
    // transcribes it (spec item 1).
    language: s.language,
    ...(done ? { transcribedAt: localIso(new Date()) } : {}),
  }
}

/**
 * Writes what has been transcribed so far, every few seconds, while the meeting is
 * still running.
 *
 * transcript.json used to appear only at session:stop, so a meeting in progress was
 * invisible to everything that reads the archive from disk — an assistant connected
 * over MCP could not answer a question about the meeting the user was sitting in, only
 * about ones that had already ended. Now it can, and a crash or a power cut mid-meeting
 * leaves the words up to the last flush instead of nothing at all.
 *
 * Only when the segment count has actually moved: 'after' and 'manual' mode do not
 * transcribe anything until the recording ends, so for those this never writes a second
 * time, and a live meeting nobody is talking in does not rewrite the same file every
 * fifteen seconds either.
 *
 * `transcribedAt` is deliberately never set here (sessionTranscript's `done`), so a
 * meeting in progress reads as "not transcribed yet" everywhere on disk. It cannot be
 * re-transcribed out from under itself in the meantime — batch:start refuses while a
 * recording is running, and meeting:delete refuses through transcriptionBusy.
 *
 * ponytail: a fixed interval and a whole-file rewrite, not an append log — a meeting's
 * segments are a few hundred small objects, and JSON.stringify of that every fifteen
 * seconds is nothing next to the ASR pass already running.
 */
const LIVE_FLUSH_MS = 15_000
let liveFlush: NodeJS.Timeout | null = null
let liveFlushed = -1

async function flushLive(): Promise<void> {
  const s = current
  if (!s || s.stopping || s.segments.length === liveFlushed) return
  liveFlushed = s.segments.length
  await writeTranscript(s.dir, await sessionTranscript(s, s.writers.loopback.durationSec, false))
}

function startLiveFlush(): void {
  liveFlushed = -1
  liveFlush ??= setInterval(() => {
    // Best-effort: a failed flush is one stale read for an assistant, not a reason to
    // disturb a recording that is otherwise fine. session:stop writes the real one.
    void flushLive().catch((err: unknown) => console.error('live transcript flush:', err))
  }, LIVE_FLUSH_MS)
}

function stopLiveFlush(): void {
  if (liveFlush) clearInterval(liveFlush)
  liveFlush = null
}

/**
 * The rest of what session:stop used to do inline — split out so before-quit (HIGH 1)
 * has something to both abort and await instead of racing past it. `signal` only
 * matters for 'after' mode's offline pass below; 'live' mode's drain is a meeting's
 * last 1-2 chunks and is left to just finish (see `w.drain()` below).
 */
async function finishSessionStop(
  wc: WebContents,
  s: Session,
  signal: AbortSignal,
): Promise<{ id: string; dir: string; durationSec: number; segments: number }> {
  if (s.mode === 'live') {
    for (const track of TRACKS) {
      const tail = s.chunkers[track].flush()
      if (tail) void enqueue(wc, track, tail, s.language)
    }
  }
  const durations = { loopback: await s.writers.loopback.close(), mic: await s.writers.mic.close() }

  // Whether this session's ASR pass (if any) actually got through every chunk —
  // false keeps transcribedAt unset below, so a chunk that 500'd or a server that
  // died mid-meeting reads as "not transcribed yet" instead of a silently partial
  // transcript nothing ever surfaces again.
  let transcribeOk = true
  if (s.mode === 'live') {
    // Those tail chunks are still queued for ASR. Writing the transcript now would
    // silently drop the last minute of the meeting, so wait them out.
    const w = await whisper?.catch(() => null)
    if (w) {
      await w.drain().catch(() => {})
      // pump() (whisper.ts) only logs a failed chunk — this is what turns that into
      // something session:stop can act on.
      if (w.takeFailures() > 0) {
        transcribeOk = false
        wc.send('transcript:error', 'บาง chunk ถอดเสียงไม่สำเร็จ — transcript อาจไม่ครบ')
      }
    }
  } else if (s.mode === 'after') {
    // Nothing was transcribed while recording — the whole recording goes through ASR
    // now, one track at a time. A failure here (e.g. whisper-server won't start, or
    // before-quit aborting `signal` to save what already came back — HIGH 1) must not
    // lose the recording that is already safely on disk.
    transcribeOk = await replayEngine(wc)
      .then((server) => transcribeRecorded(server, s.dir, s.language, (fraction) => wc.send('meeting:transcribing', fraction), signal))
      .then(() => true)
      .catch((err: unknown) => {
        wc.send('transcript:error', String(err))
        return false
      })
  }
  // 'manual': nothing to transcribe here at all — the recording stays on disk,
  // untranscribed, until the user picks it from the meetings list (spec item 1).
  current = null
  // Safe from here in every mode: the recording is over, so nothing will enqueue
  // another chunk. diarizeMeeting (below) does not use whisper, so releasing before
  // it finishes is fine.
  releaseWhisper()

  const transcript = await sessionTranscript(
    s,
    Math.max(durations.loopback.durationSec, durations.mic.durationSec),
    s.mode !== 'manual' && transcribeOk,
  )
  await writeTranscript(s.dir, transcript)
  // Nothing to diarize yet in 'manual' mode — there are no segments, and running
  // pyannote over untranscribed audio would just be a wasted pass; the batch queue's
  // transcribeOne diarizes itself, once the meeting is actually transcribed (MEDIUM 4).
  if (s.mode !== 'manual') void diarizeMeeting(wc, s.dir)
  return { id: s.id, dir: s.dir, durationSec: transcript.durationSec, segments: s.segments.length }
}

function registerIpc(): void {
  ipcMain.handle('perm:check', () => permissions())

  ipcMain.handle('perm:request', async () => {
    if (systemPreferences.getMediaAccessStatus('microphone') === 'not-determined') {
      await systemPreferences.askForMediaAccess('microphone')
    }
    return permissions()
  })

  // Never fail silently on a denied permission (spec §11) — send the user to the right pane.
  ipcMain.handle('perm:open', (_e, which: 'screen' | 'microphone') =>
    shell.openExternal(PRIVACY_PANE[which]),
  )

  ipcMain.handle('session:start', async (_e, title: string) => {
    if (current || sessionStarting) throw new Error('already recording')
    // A batch transcription pass is already the heavy load this feature exists to
    // control at one at a time — starting a live recording on top of it would be a
    // second one. Refuse rather than silently queue the recording behind the batch:
    // the user pressed Start expecting it to start now.
    if (batchController) throw new Error('a transcription batch is running — stop it before recording')
    sessionStarting = true
    try {
      const { id, dir } = await createMeetingDir(title)
      // Read once — mode and language are both captured for the whole session's life
      // (Session's doc comments), so one read serves both rather than two.
      const settings = await getSettings()
      current = {
        id,
        dir,
        startedAt: Date.now(),
        writers: {
          loopback: await WavWriter.open(join(dir, 'loopback.wav')),
          mic: await WavWriter.open(join(dir, 'mic.wav')),
        },
        chunkers: { loopback: new Chunker(), mic: new Chunker() },
        segments: [],
        stopping: false,
        mode: settings.transcribeMode,
        language: settings.meetingLanguage,
      }
      // From here on the meeting is readable from disk as it happens, not only once it
      // ends (startLiveFlush's own doc comment).
      startLiveFlush()
      return { id, dir }
    } finally {
      sessionStarting = false
    }
  })

  ipcMain.handle('session:pcm', (e, track: Track, pcm: ArrayBuffer) => {
    if (!current || current.stopping) return
    // 'after' mode: just get it onto disk. No chunker, no enqueue, no whisper-server —
    // that is the entire point of the mode (spec item 2).
    if (current.mode === 'live') {
      for (const chunk of current.chunkers[track].push(new Int16Array(pcm))) {
        void enqueue(e.sender, track, chunk, current.language)
      }
    }
    return current.writers[track].write(Buffer.from(pcm))
  })

  ipcMain.handle('session:stop', async (e) => {
    if (!current || current.stopping) return null
    const s = current
    s.stopping = true
    // Before anything else: finishSessionStop is about to write the real transcript,
    // and a flush landing after it would overwrite the finished one with a version that
    // has no `transcribedAt` and none of 'after' mode's segments. `stopping` alone would
    // already stop the next tick, but the timer has no reason to keep running either.
    stopLiveFlush()
    // HIGH 1: 'after' mode's offline pass below can run for minutes, and before-quit
    // must not let Cmd-Q walk away from it before writeTranscript ever runs — it
    // aborts this signal (so the pass gives up promptly rather than making quit wait
    // out the whole recording) and then awaits `stopInFlight` (so it still gets the
    // transcript this handler writes either way, partial or not) before actually
    // quitting. Cleared together, synchronously, with no await in between, so
    // before-quit can never observe `current.stopping` true with either one unset.
    const abort = new AbortController()
    stopAbort = abort
    const run = finishSessionStop(e.sender, s, abort.signal)
    stopInFlight = run.then(
      () => {},
      () => {},
    ).finally(() => {
      stopInFlight = null
      stopAbort = null
    })
    return run
  })

  // Typing one name for two speakers is how you merge them (spec §8) — the summary
  // sees one person, and nothing has to reshuffle the segments.
 /**
   * Breaks the link between one speaker in one meeting and the stored voice it was
   * matched to. The report is "these are not the same person" — recognition put a name
   * on this speaker that belongs to somebody else.
   *
   * Only the link goes. The voice itself is untouched, because it is almost certainly
   * fine everywhere it was matched correctly, and renaming this speaker would otherwise
   * rename that innocent person in every meeting they appear in (remember(), voices.ts,
   * reuses whichever id the transcript already ties a speaker to — which is exactly the
   * propagation that has to be stopped first here). With the link gone, naming this
   * speaker starts over: it embeds this meeting's own audio for them and files it under
   * whatever name is typed, matching an existing person by name or minting a new one.
   */
  ipcMain.handle('meeting:unlink-speaker', async (_e, dir: string, speaker: string) => {
    if (typeof speaker !== 'string' || !speaker) throw new Error('meeting:unlink-speaker expects a speaker')
    const guarded = assertMeetingDir(dir)
    const previous = await readTranscript(guarded)
    const { [speaker]: _removed, ...speakerVoices } = previous.speakerVoices ?? {}
    // Emptied, not deleted. The name goes — it came from the match that just turned out
    // to be wrong — but the KEY has to stay: the speaker editor builds its rows from
    // this map, so a deleted key means the row to type the correction into disappears
    // the next time the meeting is opened, and that speaker can never be named again
    // (found by reopening the page in a test, not by reading the code). Empty is what
    // every reader here already treats as unnamed — the transcript falls straight back
    // to "Speaker N".
    const speakers = { ...previous.speakers, [speaker]: '' }
    const next: Transcript = { ...previous, speakers, speakerVoices }
    await writeTranscript(guarded, next)
    return { ...next, speakers: await resolveSpeakerNames(next.speakers, next.speakerVoices) }
  })

  /**
   * Deletes a "speaker" the user has listened to and decided is not one — a door, a
   * cough, hold music, a fan. Diarization clusters anything voice-shaped, whisper
   * hallucinates a line or two of text out of it, and the result was a person in the
   * transcript that nobody could remove: the speaker editor could only rename them.
   *
   * Their segments go with them (store.ts's dropSpeakers) — the hallucinated text is
   * the reason to delete the row at all — and so does the pending voice they were
   * tracked as, or Settings › Speakers would keep asking for a name for a fan.
   * `discardPending` refuses a voice that HAS a name by itself, so a mis-click on a
   * real, already-named person never throws away their stored voice; only this
   * meeting's lines go, and `voices:forget` remains the way to drop a person.
   */
  /**
   * Splits this meeting's speakers apart again, given how many people were actually in
   * it — the answer diarization has to guess at otherwise, and gets badly wrong on
   * conference audio (a four-person meeting came back as twenty-three speakers).
   *
   * Deliberately re-diarizes ONLY. Until now the only way to change how speakers were
   * split was to re-transcribe the whole meeting, which re-runs whisper over the entire
   * recording — minutes of work to redo a clustering pass that takes seconds and does
   * not touch a single word of the text.
   *
   * Refused mid-recording or mid-batch for a hard reason, not a cautious one: sherpa's
   * clustering is a synchronous native call that blocks the whole event loop for the
   * length of the pass (diarize.ts), so running it under a live recording would stall
   * the PCM writes of the meeting being recorded right now.
   *
   * `count` of null means "I don't know after all" — back to letting clustering decide,
   * which is a real answer and not the same as passing 0.
   */
  ipcMain.handle('meeting:rediarize', async (e, id: string, count: number | null) => {
    if (typeof id !== 'string') throw new Error('meeting:rediarize expects a meeting id')
    if (count !== null && (typeof count !== 'number' || !Number.isFinite(count) || count < 1 || count > 50)) {
      throw new Error('meeting:rediarize expects a speaker count between 1 and 50, or null')
    }
    if (transcriptionBusy(current !== null || sessionStarting, batchController !== null)) {
      throw new Error('ยังถอดเสียงอยู่ — รอให้เสร็จก่อนแล้วค่อยแยกคนพูดใหม่')
    }
    const dir = assertMeetingDir(join(NOTES_ROOT, id))
    // "Keep the words, drop the audio" is offered in the meetings list, and diarization
    // reads the loopback WAV — say so plainly rather than failing inside sherpa.
    const wav = await stat(join(dir, 'loopback.wav')).then((st) => st.size > 44, () => false)
    if (!wav) throw new Error('ไม่มีไฟล์เสียงของการประชุมนี้แล้ว — แยกคนพูดใหม่ไม่ได้')
    await setSpeakerCount(id, count)
    // notify:false — this handler returns the transcript to whoever asked for it, and
    // the 'meeting:transcript' broadcast is for the *live session's* panel, which is not
    // what is being re-diarized here.
    if (!(await diarizeMeeting(e.sender, dir, false))) throw new Error('แยกคนพูดไม่สำเร็จ — transcript เดิมไม่ถูกแตะ')
    const updated = await readTranscript(dir)
    return { ...updated, speakers: await resolveSpeakerNames(updated.speakers, updated.speakerVoices) }
  })

  ipcMain.handle('meeting:drop-speakers', async (_e, dir: string, labels: string[]) => {
    if (!Array.isArray(labels) || labels.length === 0 || labels.some((l) => typeof l !== 'string')) {
      throw new Error('meeting:drop-speakers expects at least one speaker')
    }
    const guarded = assertMeetingDir(dir)
    const previous = await readTranscript(guarded)
    const next = dropSpeakers(previous, labels)
    await writeTranscript(guarded, next)
    for (const label of labels) {
      const voiceId = previous.speakerVoices?.[label]?.voiceId
      if (voiceId) await discardPending(voiceId).catch(() => false)
    }
    return { ...next, speakers: await resolveSpeakerNames(next.speakers, next.speakerVoices) }
  })

  ipcMain.handle('meeting:rename', async (_e, dir: string, speakers: Record<string, string>) => {
    const guarded = assertMeetingDir(dir)
    const previous = await readTranscript(guarded)
    // LOW 10: a blank name means "this speaker has no name", which is a real state —
    // the renderer sends one for an unnamed speaker, and for one whose wrong voice match
    // was just reported. Blanks are filtered out rather than merged, so the stored value
    // stays whatever it was (usually blank) instead of being overwritten with an empty
    // string that later readers would have to special-case. The IPC handler is the trust
    // boundary, not the renderer, and a
    // caller sending one directly used to merge it straight into `speakers` (only the
    // `remember()` loop below skipped it, leaving a blank display name — resolved to
    // `''` by resolveSpeakerNames/`?? speaker`, since `''` is not nullish). Filtered
    // out here instead of merged and only guarded against below.
    const named = Object.fromEntries(Object.entries(speakers).filter(([, name]) => name.trim()))
    const merged = { ...previous.speakers, ...named }
    // Untouched keys keep whatever they already resolved to — see remember()'s doc
    // comment for why only the id already on `previous.speakerVoices` (not one minted
    // below, mid-loop) decides propagation.
    const speakerVoices = { ...previous.speakerVoices }

    // Typing a name is the only moment we know whose voice this is. Learn it here so
    // the next meeting can fill it in on its own — and, when this speaker was already
    // a voice the app recognised (named or still pending), retarget that same id so
    // every other meeting pointing at it picks up the new name too (spec item 3).
    for (const [speaker, name] of Object.entries(named)) {
      if (speaker === 'me' || speaker === name) continue
      const id = await remember(guarded, { ...previous, speakers: merged }, speaker, name.trim()).catch(() => null)
      if (id) {
        speakerVoices[speaker] = { voiceId: id, name: name.trim() }
      } else if (speakerVoices[speaker]) {
        // remember() declined — this speaker has under two seconds of their own audio
        // in this meeting, which is not enough to learn a voice from (voices.ts).
        // The rename still has to take: `speakerVoices[speaker].name` is what
        // resolveSpeakerNames falls back to when the voice behind it is gone, so
        // leaving the old name here means the user retypes the name, saves, and watches
        // it change back — found by renaming a speaker whose lines were all short.
        speakerVoices[speaker] = { ...speakerVoices[speaker], name: name.trim() }
      }
    }

    const updated: Transcript = { ...previous, speakers: merged, speakerVoices }
    await writeTranscript(guarded, updated)
    const displaySpeakers = await resolveSpeakerNames(updated.speakers, updated.speakerVoices)
    return { ...updated, speakers: displaySpeakers }
  })

  // Microphone test: is what I just said speech at the current setting, and what
  // survives of it? Answering both is the only way the slider means anything.
  ipcMain.handle('mic:probe', async (_e, pcm: ArrayBuffer) =>
    hasSpeech(new Int16Array(pcm), (await getSettings()).noiseFilter),
  )

  ipcMain.handle('mic:transcribe', async (e, pcm: ArrayBuffer) => {
    // 'after'/'manual' mode's whole point is that whisper-server never spawns during a
    // recording (spec item 2) — transcription() would spawn it right here otherwise,
    // paying the 3.4GB cost mid-meeting. In 'live' mode it is already running, so this
    // is safe — but a batch's own requests must not queue behind an unrelated mic-test
    // one either (micTestLocked's doc comment). See releaseWhisper's contract just
    // above for the matching guard.
    //
    // LOW 8: `sessionStarting` is checked here too, same reason mic:test-end (below)
    // already checks it — session:start hasn't set `current` yet while it's still
    // awaiting createMeetingDir/WavWriter.open, and micTestLocked's `current?.mode ??
    // null` alone reads that window as "nothing recording" and would let a mic-test
    // request spawn (or reuse) whisper-server into what is about to become an
    // 'after'-mode recording, defeating the exact thing that mode exists for.
    if (sessionStarting || micTestLocked(current?.mode ?? null, batchController !== null)) {
      throw new Error('mic test ใช้ไม่ได้ระหว่างถอดเสียงอยู่')
    }
    const samples = new Int16Array(pcm)
    const settings = await getSettings()
    if (!(await hasSpeech(samples, settings.noiseFilter))) return ''
    // Always the current setting, never a captured one: this is a live test of today's
    // configuration, not a recording, so there is no meeting for a language to belong to.
    return (await transcription(e.sender)).transcribeOnce(samples, settings.meetingLanguage)
  })

  // The renderer calls this once, when the mic test is toggled off — not after every
  // probe, which would spawn and kill whisper-server every few seconds. Guarded the
  // same as settings:set (line below): releaseWhisper's own contract says never call it
  // during a recording or a running batch, and unlike settings:set this handler used to
  // ignore that entirely. `sessionStarting` is included (LOW 9) — session:start hasn't
  // set `current` yet while it's still awaiting createMeetingDir/WavWriter.open, and a
  // mic:test-end landing in exactly that window must not release the model out from
  // under the live recording that is about to begin.
  ipcMain.handle('mic:test-end', () => {
    if (!transcriptionBusy(current !== null || sessionStarting, batchController !== null)) releaseWhisper()
  })

  ipcMain.handle('voices:list', () => knownVoices())
  ipcMain.handle('voices:forget', (_e, name: string) => forget(name))
  /** Renames every voice stored under one name — which is also the merge (voices.ts's
   * renameVoices): renaming one person onto a name another already holds makes them one
   * person. Returns how many stored voices moved, so the renderer can say so. */
  ipcMain.handle('voices:rename', (_e, from: string, to: string) => {
    if (typeof from !== 'string' || typeof to !== 'string') throw new Error('voices:rename expects two names')
    return renameVoices(from, to)
  })

  // Voices diarization has clustered but nobody has named yet (spec item 1) — enriched
  // here, not in voices.ts, with what the settings panel actually wants to show: a
  // title/date (shared/meetings.ts's titleOf, no NOTES_ROOT knowledge needed) and the
  // speaker's own lines from that meeting's transcript. voices.ts only knows ids,
  // meeting ids and a speaker key — it has no notion of NOTES_ROOT or path-guarding,
  // same split as everywhere else main resolves a renderer-supplied id into a path.
  ipcMain.handle('voices:pending', async () => {
    const items = await pendingVoices()
    return Promise.all(
      items.map(async (p) => {
        const transcript = await readTranscript(assertMeetingDir(join(NOTES_ROOT, p.meetingId))).catch(() => null)
        // MEDIUM 6: matched by the frozen span times (p.spans), not by `p.speaker`
        // against this meeting's *current* transcript — if it has been re-diarized
        // since this voice was tracked, the raw speaker key can now belong to someone
        // else (same reason diarizeMeeting no longer trusts a stale key for a name —
        // HIGH 3). A legacy pending entry with no spans (tracked before this field
        // existed) falls back to the old, occasionally-wrong key match.
        const text = transcript?.segments
          .filter((s) => (p.spans ? p.spans.some((sp) => sp.t0 === s.t0 && sp.t1 === s.t1) : s.speaker === p.speaker))
          .map((s) => s.text)
          .join(' ')
        const meta = await readMeta(join(NOTES_ROOT, p.meetingId)).catch(() => null)
        return {
          id: p.id,
          meetingId: p.meetingId,
          meetingTitle: displayTitle(meta?.title ?? '', meta?.startedAt ?? transcript?.startedAt ?? ''),
          at: p.at,
          text: text ?? '',
        }
      }),
    )
  })
 ipcMain.handle('voices:discard', (_e, id: string) => {
    if (typeof id !== 'string') throw new Error('voices:discard expects a voice id')
    return discardPending(id)
  })
  ipcMain.handle('voices:name', (_e, id: string, name: string) => nameVoice(id, name))
  // A few seconds of the pending voice's own audio, so the user can hear who it is
  // before typing a name (spec item 2) — resolved from the id, never a renderer-
  // supplied path, and read straight out of a meeting folder assertMeetingDir has
  // already guarded.
  ipcMain.handle('voices:sample', async (_e, id: string) => {
    const pending = (await pendingVoices()).find((p) => p.id === id)
    if (!pending) return null
    const dir = assertMeetingDir(join(NOTES_ROOT, pending.meetingId))
    const transcript = await readTranscript(dir).catch(() => null)
    // MEDIUM 6: `pending.spans`, when present, tells sampleWav exactly which audio to
    // pull regardless of what `pending.speaker` means in the meeting's transcript today.
    return transcript ? sampleWav(dir, transcript, pending.speaker, pending.spans) : null
  })

  // Every recorded meeting plus its transcription status, for the meetings panel (spec
  // item 3/5). `listMeetings` only knows disk state (transcribed or not); "transcribing"
  // and "failed" are this session's own batch-queue state layered on top.
  // A single meeting's full transcript, for the meetings-list detail view (spec item
  // 1). Takes an id, not a directory — the renderer never learns NOTES_ROOT's actual
  // path, and the id is what gets resolved and guarded here (assertMeetingDir), the
  // same idiom transcribeOne already uses to turn a renderer-supplied id into a path.
  ipcMain.handle('meeting:get', async (_e, id: string) => {
    const dir = assertMeetingDir(join(NOTES_ROOT, id))
    const transcript = await readTranscript(dir)
    // Same read-time resolution as diarizeMeeting's own notify send (spec item 3) —
    // an old meeting reopened later shows whatever its recognised voices are called
    // *today*, not what they were called when this transcript was written.
    const speakers = await resolveSpeakerNames(transcript.speakers, transcript.speakerVoices)
    // Which tracks are still on disk: "delete the audio, keep the words" is offered in
    // the meetings list, so a transcript with no recording behind it any more is a
    // normal state the player has to be told about rather than discover by failing.
    const audio = Object.fromEntries(
      await Promise.all(
        TRACKS.map(async (track) => [track, await stat(join(dir, `${track}.wav`)).then((st) => st.size > 44, () => false)]),
      ),
    ) as Record<Track, boolean>
    // The meta as well: the title and the meeting's headcount are not derivable from the
    // id (a uuid) or from the transcript, and the detail page needs both.
    return { dir, audio, meta: await readMeta(dir), transcript: { ...transcript, speakers } }
  })

  ipcMain.handle('meeting:list', async () => {
    const [items, settings] = await Promise.all([listMeetings(), getSettings()])
    return items.map((m) => ({
      id: m.id,
      title: m.title,
      startedAt: m.startedAt,
      durationSec: m.durationSec,
      status: transcribeStatus(m.transcribed, m.id === batchRunningId, batchFailed.has(m.id)),
      // The meeting's own recorded language if it has one, else today's setting — the
      // same resolution transcribeOne applies when it actually runs (spec item 1), so
      // what this shows is what a batch pass would actually decode this meeting as.
      language: resolveLanguage(m.language, settings.meetingLanguage),
    }))
  })

  /**
   * A native modal, worded entirely by the renderer. Deleting a recording is not
   * undoable, so it asks in a window the user cannot click past or lose behind the app
   * — but the strings belong with the rest of the UI copy (main has no message
   * catalogue, and both languages live in the renderer), so this passes them down
   * rather than growing a second one here. Returns the index of the button pressed;
   * closing the sheet returns `cancelId`.
   */
  ipcMain.handle('dialog:ask', async (e, opts: { message: string; detail?: string; buttons: string[] }) => {
    const buttons = Array.isArray(opts?.buttons) ? opts.buttons.filter((b) => typeof b === 'string').slice(0, 4) : []
    if (buttons.length < 2) throw new Error('dialog:ask needs at least two buttons')
    const window = BrowserWindow.fromWebContents(e.sender)
    const cancelId = buttons.length - 1
    const answer = await (window
      ? dialog.showMessageBox(window, { type: 'warning', message: opts.message, detail: opts.detail, buttons, defaultId: cancelId, cancelId })
      : dialog.showMessageBox({ type: 'warning', message: opts.message, detail: opts.detail, buttons, defaultId: cancelId, cancelId }))
    return answer.response
  })

  /**
   * Deletes saved meetings — `keepTranscript` leaves transcript.json/.md behind and
   * drops only the audio (deleteMeeting, store.ts). The renderer is what decides which
   * of those the user is being offered and warns accordingly; the rules main enforces
   * here are the ones the renderer cannot be trusted with: nothing gets deleted out
   * from under a pass that is still reading it.
   */
  ipcMain.handle('meeting:delete', async (_e, ids: string[], keepTranscript: boolean) => {
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
      throw new Error('meeting:delete expects a list of meeting ids')
    }
    if (transcriptionBusy(current !== null || sessionStarting, batchController !== null)) {
      throw new Error('ยังถอดเสียงอยู่ — รอให้เสร็จก่อนแล้วค่อยลบ')
    }
    for (const id of ids) {
      if (keepTranscript === true) {
        // Only the audio goes, and it goes for good: this exists to reclaim the disk,
        // and a 350MB WAV in the Trash has reclaimed nothing.
        await deleteMeeting(id, true)
        continue
      }
      // The whole meeting: to the Trash, not `rm`. Deleting a recording is the one
      // irreversible thing in this app, and macOS already has the place where
      // irreversible things wait to be reconsidered. Falls back to a real delete only
      // if the Trash refuses (a volume without one), because the user asked for it gone.
      await shell.trashItem(meetingPath(id)).catch(() => deleteMeeting(id, false))
    }
  })

  /**
   * Retitles a saved meeting. The title lives in the meeting's own meeting.json now
   * (store.ts's setMeetingTitle), so nothing moves and the id does not change — which
   * is the point of having split them: voices.json's own meeting ids, an MCP client's
   * notes, and the renderer's selection all keep pointing at the same meeting.
   *
   * Still refused mid-pass, same as before: a batch or a recording is reading and
   * rewriting this folder, and a title write racing that would be lost anyway.
   */
  ipcMain.handle('meeting:set-title', async (_e, id: string, title: string) => {
    if (typeof id !== 'string' || typeof title !== 'string') throw new Error('meeting:set-title expects an id and a title')
    if (transcriptionBusy(current !== null || sessionStarting, batchController !== null)) {
      throw new Error('ยังถอดเสียงอยู่ — รอให้เสร็จก่อนแล้วค่อยเปลี่ยนชื่อ')
    }
    await setMeetingTitle(id, title)
  })

  // Transcribes the given meetings one at a time, in order (spec item 4). Returns as
  // soon as the queue starts — batch:progress/batch:item/batch:done report the rest —
  // so a long queue never leaves this invoke() hanging.
  ipcMain.handle('batch:start', (e, ids: string[]) => {
    // Renderer-supplied and only typed by annotation — a non-array would otherwise
    // throw inside runBatch's ids.entries(), rejecting the un-caught `void runBatch(...)`
    // below into an unhandled rejection in the main process (MEDIUM 6).
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) {
      throw new Error('ids must be an array of strings')
    }
    if (current || sessionStarting) throw new Error('a recording is in progress — stop it first')
    if (batchController) throw new Error('a transcription batch is already running')
    const controller = new AbortController()
    batchController = controller
    batchFailed.clear()

    // Meetings that actually got something transcribed (LOW 10 — a meeting with no
    // audio in either track has nothing to diarize either). Diarized in a second pass
    // below, only once the whole queue is transcribed and whisper is released (MEDIUM
    // 4): diarize.ts's own ~1GB peak, plus voices.ts re-reading each speaker's WAV,
    // must never be concurrent with whisper-server's 0.8-3.4GB RSS, or the two
    // together blow the RAM budget the settings UI advertises on a 16GB machine. The
    // cost is that the meetings list can show a meeting "Done" a little before its
    // speaker names are filled in — the same trade the single-recording path at
    // session:stop already makes (diarizeMeeting there is fire-and-forget too).
    const diarizeItems: { id: string; dir: string }[] = []

    void runBatch(
      ids,
      async (id, onProgress, signal) => {
        // HIGH 2: transcribeOne throws (and writes nothing) for a meeting with no
        // audio to find — that surfaces here as a normal per-item failure, same as
        // any other transcribeOne error, so nothing gets added to diarizeItems for it.
        const dir = await transcribeOne(e.sender, id, onProgress, signal)
        diarizeItems.push({ id, dir })
      },
      controller.signal,
      (progress) => {
        batchRunningId = progress.id
        e.sender.send('batch:item', { ...progress, status: 'running' })
      },
      (progress: BatchProgress, fraction) => e.sender.send('batch:progress', { ...progress, fraction }),
      (progress, status, error) => {
        batchRunningId = null
        if (status === 'done') {
          batchFailed.delete(progress.id)
          e.sender.send('batch:item', { ...progress, status: 'done' })
        } else if (controller.signal.aborted) {
          // An abort surfaces as a normal thrown error from transcribeOne — not a real
          // failure, and not worth an error toast the user did not ask for (they
          // clicked stop). Nothing was written to disk for it, so it is simply back
          // to "not transcribed yet".
          e.sender.send('batch:item', { ...progress, status: 'cancelled' })
        } else {
          batchFailed.add(progress.id)
          e.sender.send('batch:item', { ...progress, status: 'failed', error })
        }
      },
    )
      .then(async (result) => {
        // Whole queue's transcription is done — release now, before diarizing, or
        // MEDIUM 4's whole point (never holding whisper and diarize's memory at once)
        // is defeated.
        releaseWhisper()
        for (const [i, { id, dir }] of diarizeItems.entries()) {
          // Checked between meetings only (MEDIUM 5) — diarize() itself blocks the
          // event loop for the length of the call (diarize.ts's own doc comment), so a
          // cancel here cannot interrupt whichever one is already running, only stop
          // the queue from starting the next.
          if (controller.signal.aborted) break
          e.sender.send('batch:diarizing', { id, index: i + 1, total: diarizeItems.length })
          await diarizeMeeting(e.sender, dir, false, controller.signal)
        }
        e.sender.send('batch:done', result)
      })
      // ids.entries() throwing, or any of the callbacks above throwing on a destroyed
      // webContents (e.sender.send), would otherwise reject with nothing to catch it
      // (MEDIUM 6) — runBatch itself already reports a per-meeting failure through
      // onItemDone, so reaching here means the queue's own machinery broke, not a
      // meeting.
      .catch((err: unknown) => console.error('batch:', err))
      .finally(() => {
        batchController = null
        batchRunningId = null
        // Safety net, not the real fix — the actual release already happened above,
        // right after transcription finished. Free to call again if the diarize loop
        // threw before reaching it.
        releaseWhisper()
      })
  })

  ipcMain.handle('batch:cancel', () => batchController?.abort())

  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:set', async (_e, patch: Partial<Settings>) => {
    // noiseFilter is read per-chunk (whisper.ts's pump()), which is exactly the bug
    // (spec item 2): changing it mid-pass would change VAD gating partway through a
    // single meeting's chunks. Unlike meetingLanguage (captured once per meeting —
    // Session.language / Transcript.language) or asrModel/transcribeMode (only ever
    // apply to the *next* pass regardless of when they change), there is no "next
    // pass" for noiseFilter to defer to mid-recording, so the setting itself is
    // refused here rather than threaded through every chunk.
    if ('noiseFilter' in patch && transcriptionBusy(current !== null || sessionStarting, batchController !== null)) {
      throw new Error('เปลี่ยนตัวกรองเสียงระหว่างถอดเสียงไม่ได้ — รอให้เสร็จก่อน')
    }
    const before = await getSettings()
    const next = await setSettings(patch) // now re-validated on the way out — see settings.ts
    // Takes effect on the next transcription() call, not after a restart — but never
    // while a recording is in progress, or the batch queue is mid-meeting: reloading
    // the model out from under either is worse than finishing it on the old one
    // (releaseWhisper's contract).
    if (next.asrModel !== before.asrModel && !transcriptionBusy(current !== null || sessionStarting, batchController !== null)) {
      releaseWhisper()
    }
    return next
  })

  // The always-needed models plus whichever ASR model is currently selected — the
  // other two ASR models are not "missing", they are simply not needed right now.
  const requiredSpecs = async (): Promise<ModelSpec[]> => [...MODELS, ASR_MODELS[(await getSettings()).asrModel]]

  ipcMain.handle('models:status', async () => modelStatus(await requiredSpecs()))
  ipcMain.handle('models:cancel', () => downloads?.abort())

  // Lets the settings panel show all three ASR models' download state at once, so
  // picking one that is not yet downloaded is an informed choice, not a surprise.
  ipcMain.handle('models:asr-status', async () => {
    const entries = Object.entries(ASR_MODELS) as [AsrModel, ModelSpec][]
    const statuses = await modelStatus(entries.map(([, spec]) => spec))
    return Object.fromEntries(entries.map(([key], i) => [key, statuses[i]])) as Record<AsrModel, ModelStatus>
  })

  // Downloads run one at a time so the progress the user sees matches what is
  // actually moving, and a failure names the file that failed.
  ipcMain.handle('models:download', async (e) => {
    if (downloads) throw new Error('a download is already running')
    downloads = new AbortController()
    try {
      const specs = await requiredSpecs()
      for (const spec of specs) {
        if ((await modelStatus(specs)).find((m) => m.file === spec.file)?.present) continue
        try {
          await downloadModel(spec, (p) => e.sender.send('models:progress', p), downloads.signal)
        } catch (err) {
          // Whatever went wrong, the bytes already written are a valid prefix — they
          // stay on disk so the next attempt resumes rather than restarts. Cancelling
          // is a choice, not a failure, so it comes back as a result.
          if (downloads.signal.aborted) return { cancelled: true }
          throw err
        }
      }
      return { cancelled: false }
    } finally {
      downloads = null
    }
  })

  ipcMain.handle('mcp:state', () => mcpState())

  ipcMain.handle('mcp:toggle', async (_e, on: boolean) => {
    await setSettings({ mcp: on })
    await restartMcp()
    return mcpState()
  })

  ipcMain.handle('mcp:port', async (_e, port: number) => {
    // The renderer's range check is only a UX nicety — an IPC caller can send
    // anything, so this is the check that actually protects settings.json.
    if (!validPort(port)) throw new Error('port must be an integer between 1024 and 65535')
    await setSettings({ mcpPort: port })
    await restartMcp()
    return mcpState()
  })

  ipcMain.handle('shell:reveal', (_e, dir: string) => shell.openPath(assertMeetingDir(dir)))

  // ---- in-app update (update.ts) ----------------------------------------
  ipcMain.handle('update:version', () => app.getVersion())
  ipcMain.handle('update:check', () => latestUpdate(app.getVersion()))
  /**
   * Downloads the release, reporting progress, and stops there. Installing is a second,
   * separate call — replacing the app means closing it, and that is the user's decision
   * to make once the waiting is over, not something to spring on them when a progress
   * bar reaches the end.
   */
  ipcMain.handle('update:download', async (e, info: UpdateInfo) => {
    if (updating) throw new Error('an update is already downloading')
    if (!updateBundle()) throw new Error('อัปเดตในแอปได้เฉพาะตัวที่ติดตั้งแล้ว — ตัวที่รันจากซอร์สให้ git pull เอา')
    if (transcriptionBusy(current !== null || sessionStarting, batchController !== null)) {
      throw new Error('ยังถอดเสียงอยู่ — รอให้เสร็จก่อนแล้วค่อยอัปเดต')
    }
    updating = new AbortController()
    try {
      await wipeDownloadedUpdate()
      downloadedUpdate = await downloadUpdate(info, (progress) => e.sender.send('update:progress', progress), updating.signal)
    } finally {
      updating = null
    }
  })

  /**
   * Puts the downloaded release in place — now, or on the way out.
   *
   * 'now' replaces the bundle and restarts immediately. 'quit' waits: the swap happens
   * in before-quit instead, because a running app whose bundle has already been replaced
   * still reads from that bundle for anything it loads later (a new window's HTML, the
   * whisper binary in Resources), and mixing this version's code with the next version's
   * files is a worse outcome than either.
   */
  ipcMain.handle('update:apply', async (_e, when: 'now' | 'quit') => {
    if (!downloadedUpdate) throw new Error('ยังไม่ได้ดาวน์โหลดอะไรไว้')
    const bundle = updateBundle()
    if (!bundle) throw new Error('อัปเดตในแอปได้เฉพาะตัวที่ติดตั้งแล้ว — ตัวที่รันจากซอร์สให้ git pull เอา')
    if (when === 'quit') {
      installOnQuit = true
      return
    }
    const dmg = downloadedUpdate
    downloadedUpdate = null
    installOnQuit = false
    await installUpdate(dmg, bundle)
    // This directory is ours (downloadUpdate made it for this one file), so this is the
    // one place allowed to remove it — installUpdate deliberately leaves the .dmg alone.
    await rm(dirname(dmg), { recursive: true, force: true }).catch(() => {})
    // Re-execs the same path the running app is at, which is exactly the path just
    // replaced, so it comes back as the new version. `quit` is what actually ends this
    // process; without it relaunch only arms the restart.
    app.relaunch()
    app.quit()
  })

  /** Throws away whatever was downloaded and disarms an install that was waiting for
   * quit — "not now" has to mean the app is not quietly replaced next time it closes. */
  ipcMain.handle('update:discard', async () => {
    installOnQuit = false
    await wipeDownloadedUpdate()
  })
  ipcMain.handle('update:cancel', () => updating?.abort())

  /** Where every recording and transcript lives — shown (and opened) by onboarding's
   * files step, so "where did my meeting go?" has an answer before the first one is
   * recorded. Opened without assertMeetingDir: this IS the root that guard is about,
   * and it comes from main, not the renderer. */
  // ---- OpenRouter (openrouter.ts) ---------------------------------------
  /** Whether a key is stored — never the key itself. The renderer has no business
   * holding it, and showing it back would only give it a second place to leak from. */
  ipcMain.handle('openrouter:has-key', async () => (await openrouterKey()).length > 0)
  /**
   * Saves the key and immediately reports what it can be used for: whether it works,
   * what credit is left on it, and every model on OpenRouter that accepts audio, priced.
   * Saved before the check, not after, so a key that works but whose account has some
   * unrelated problem is still the key the user typed and can fix.
   */
  ipcMain.handle('openrouter:connect', async (_e, key: string) => {
    if (typeof key !== 'string') throw new Error('openrouter:connect expects a key')
    await setOpenrouterKey(key)
    return connectOpenrouter(key)
  })
  /** Re-reads the model list with the stored key — the set of models that take audio,
   * and their prices, both change without anyone here doing anything. */
  ipcMain.handle('openrouter:models', async () => {
    const key = await openrouterKey()
    if (!key) throw new Error('ยังไม่ได้ใส่ API key')
    return connectOpenrouter(key)
  })
  ipcMain.handle('openrouter:forget', async () => {
    await setOpenrouterKey('')
    await setSettings({ asrEngine: 'local' })
  })

  /** Where the player streams a meeting's audio from — a per-launch tokened URL on the
   * loopback audio server, started on first ask. */
  ipcMain.handle('audio:url', async (_e, id: string, track: string) => {
    if (typeof id !== 'string' || typeof track !== 'string') throw new Error('audio:url expects an id and a track')
    const { port, token } = await startAudioServer()
    return `http://127.0.0.1:${port}/${token}/${encodeURIComponent(id)}/${encodeURIComponent(track)}`
  })

  /** Reveals the bundled Chrome extension so it can be loaded unpacked. Inside the
   * .app when packaged (electron-builder's extraResources), in the repo when not. */
  ipcMain.handle('extension:open', () => {
    const dir = app.isPackaged ? join(process.resourcesPath, 'extension') : join(app.getAppPath(), 'extension')
    return shell.openPath(dir)
  })

  ipcMain.handle('notes:root', () => NOTES_ROOT)
  ipcMain.handle('notes:open', async () => {
    await mkdir(NOTES_ROOT, { recursive: true })
    return shell.openPath(NOTES_ROOT)
  })
}

/**
 * One tiny HTTP server on loopback, serving meeting WAVs to the detail page's player.
 *
 * Real HTTP, deliberately, after a custom `meeting://` protocol failed three different
 * ways (each watched, not guessed): `net.fetch(file://)` has no Content-Length, so
 * every pause/seek re-read the file from zero; `Readable.toWeb` bodies wedge when
 * Chromium cancels its speculative request; and hand-built 206s — Buffer or stream —
 * are cancelled by Chromium's media loader itself the moment it requests a mid-file
 * range, because on a custom protocol it sizes the resource from the first response
 * and rejects ranged follow-ups (its own request arrived, our 206 went back with the
 * right offsets, and it aborted and raised PIPELINE_ERROR_READ anyway). Over real
 * HTTP the same media stack does exactly what the RFC says.
 *
 * Loopback-bound, one random token for the app's lifetime, id and track validated
 * before any path is built. Started on first use — a session that never opens a
 * meeting never opens a port.
 */
let audioServer: Promise<{ port: number; token: string }> | null = null

function startAudioServer(): Promise<{ port: number; token: string }> {
  audioServer ??= new Promise((resolve, reject) => {
    const token = randomBytes(16).toString('base64url')
    const server = createServer(async (req, res) => {
      const parts = (req.url ?? '/').split('?')[0]!.split('/').filter(Boolean).map(decodeURIComponent)
      const [reqToken, id, track] = parts
      if (parts.length !== 3 || reqToken !== token || !safeId(id!) || !TRACKS.some((t) => `${t}.wav` === track)) {
        res.writeHead(404).end()
        return
      }
      const path = assertMeetingDir(join(NOTES_ROOT, id!, track!))
      const size = await stat(path).then((st) => st.size).catch(() => null)
      if (size === null) {
        res.writeHead(404).end()
        return
      }
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
      // A suffix range (`bytes=-N`, the last N bytes) is how some demuxers read a
      // trailer; RFC 9110's three shapes are all three real here.
      const from = range ? (range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]))) : 0
      const to = range?.[2] && range[1] ? Math.min(Number(range[2]), size - 1) : size - 1
      if (from > to || from >= size) {
        res.writeHead(416, { 'content-range': `bytes */${size}` }).end()
        return
      }
      res.writeHead(range ? 206 : 200, {
        'content-type': 'audio/wav',
        'accept-ranges': 'bytes',
        'content-length': to - from + 1,
        ...(range ? { 'content-range': `bytes ${from}-${to}/${size}` } : {}),
      })
      // pipeline, not .pipe: it destroys the read stream when the client goes away,
      // which the client does constantly — every seek abandons the previous request.
      pipeline(createReadStream(path, { start: from, end: to }), res, () => {})
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address !== 'object' || !address) return reject(new Error('audio server bound but has no address'))
      resolve({ port: address.port, token })
    })
  })
  return audioServer
}

app.whenReady().then(() => {
  installDisplayMediaHandler()
  registerIpc()
  // Meetings recorded before ids became uuids keep their old folder names and get a
  // meeting.json written beside them, so titles come from one place from here on
  // (store.ts's migrateMeetingMeta). Fire-and-forget: it is a handful of small writes
  // over folders nothing is reading yet, and a failure means the meetings list falls
  // back to the folder name for one more launch rather than the window not opening.
  void migrateMeetingMeta().catch((err: unknown) => console.error('meeting meta migration:', err))
  // An attempt that died mid-swap leaves staging directories next to the app, and the
  // next attempt then fails trying to clear them (seen in the wild as ENOTEMPTY on
  // `…app.incoming/Contents/Resources`). Clearing them at launch means one bad run
  // cannot make every future update fail.
  const bundle = updateBundle()
  if (bundle) void clearUpdateLeftovers(bundle)

  const win = new BrowserWindow({
    width: 760,
    height: 660,
    title: 'Meeting Inspector',
    // Liquid Glass is a real material, not a CSS approximation: the window gets the
    // system's own vibrancy layer and the page sits on it with a transparent body.
    // `active` keeps it lit while the window is in the background, so a meeting the
    // user is watching in another app does not go flat.
    vibrancy: 'under-window',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    // Traffic lights inset over the page's own draggable strip.
    titleBarStyle: 'hiddenInset',
    webPreferences: { preload: join(__dirname, '../preload/index.js') },
  })

  void restartMcp().catch((err: unknown) => console.error('mcp:', err))

  // Warm the model now so the first chunk is not stuck behind a 3GB load — only worth
  // it in 'live' mode. 'after' mode never touches whisper until a meeting ends, so
  // warming it here would just be the same 3.4GB-for-nothing bug this mode exists to fix.
  mainWindow = win
  win.on('closed', () => {
    mainWindow = null
  })
  win.webContents.once('did-finish-load', () => {
    void getSettings().then((s) => {
      if (s.transcribeMode === 'live') void transcription(win.webContents).catch(() => {})
    })
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) win.loadURL(devUrl)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
})

/**
 * Puts a downloaded update in place on the way out, if the user chose "when I quit"
 * rather than "now" — the app is already going away, so nothing is left running against
 * a bundle that has just been swapped underneath it. Returns whether it did anything,
 * so the quit path only has to wait when there was something to wait for.
 */
async function installUpdateOnQuit(): Promise<boolean> {
  const bundle = installOnQuit && downloadedUpdate ? updateBundle() : null
  if (!bundle || !downloadedUpdate) return false
  const dmg = downloadedUpdate
  downloadedUpdate = null
  installOnQuit = false
  // A failed swap must not trap the user in an app that will not close; installUpdate
  // puts the old bundle back itself, and the next launch can simply offer again.
  await installUpdate(dmg, bundle).catch((err: unknown) => console.error('update on quit failed —', err))
  await rm(dirname(dmg), { recursive: true, force: true }).catch(() => {})
  return true
}

app.on('before-quit', async (e) => {
  releaseWhisper()
  void mcp?.close()

  if (stopInFlight) {
    // HIGH 1 (prior round): session:stop is already tearing this meeting down — most
    // likely 'after' mode's multi-minute offline pass. The old code bailed here with
    // no preventDefault, so Cmd-Q anywhere in that window quit before writeTranscript
    // ever ran (finishSessionStop's very last step) and the finished ASR work was
    // simply discarded. Abort the pass (stopAbort — so quitting does not have to wait
    // out the whole recording) and then wait for the transcript finishSessionStop
    // still writes either way, partial or not, before actually quitting.
    //
    // LOW 9: gated on `stopInFlight`, not `current && current.stopping` — finishSessionStop
    // sets `current = null` partway through (before its own writeTranscript runs), so
    // the old `current`-based check stopped matching in that exact window and fell
    // through to the `!current` branch below with no preventDefault, quitting out from
    // under the still-running write. `stopInFlight` stays set for the whole call
    // (cleared only in its own `.finally`, after finishSessionStop's promise settles),
    // so it covers that window too — `current` and `current.stopping` were always
    // true together with it anyway (session:stop sets all three synchronously), so
    // this narrows nothing that used to be caught.
    e.preventDefault()
    stopAbort?.abort()
    await stopInFlight
    await installUpdateOnQuit()
    app.quit()
    return
  }

  // A half-written meeting is worth more than none: close the WAVs before quitting.
  // No drain here — the user asked to quit, so we save what already came back rather
  // than making them wait for the tail.
  if (!current) {
    if (installOnQuit && downloadedUpdate) {
      e.preventDefault()
      await installUpdateOnQuit()
      app.quit()
    }
    return
  }
  e.preventDefault()
  const s = current
  s.stopping = true
  current = null
  const closed = await Promise.allSettled([s.writers.loopback.close(), s.writers.mic.close()])
  const durationSec = Math.max(
    ...closed.map((r) => (r.status === 'fulfilled' ? r.value.durationSec : 0)),
  )
  await writeTranscript(s.dir, {
    id: s.id,
    startedAt: localIso(new Date(s.startedAt)),
    durationSec,
    speakers: await defaultSpeakers(),
    language: s.language,
    // Not s.segments: in 'live' mode those are partial (no drain on quit, by design —
    // see above), and meetingDone's legacy rule (store.ts) reads "segments but no
    // transcribedAt" as done, from before that field existed. That would hide this
    // meeting from the batch queue forever. Leaving it empty reads as "not transcribed
    // yet" instead — the WAVs on disk are complete, so a later batch pass recovers the
    // whole thing. 'after'/'manual' already write empty here regardless.
    segments: [],
  }).catch(() => {})
  await installUpdateOnQuit()
  app.quit()
})

app.on('window-all-closed', () => app.quit())
