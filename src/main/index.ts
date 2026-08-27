import { app, BrowserWindow, desktopCapturer, ipcMain, session, shell, systemPreferences, type WebContents } from 'electron'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { runBatch, type BatchProgress } from './batch.ts'
import { Chunker, SAMPLE_RATE, type Chunk } from './chunker.ts'
import { assignSpeakers, diarize, speakerNames, type SpeakerLabels } from './diarize.ts'
import { ASR_MODELS, MODELS, downloadModel, modelStatus, type ModelSpec, type ModelStatus } from './download.ts'
import { PREFERRED_PORT, startMcp, type McpHandle } from './mcp.ts'
import { model } from './models.ts'
import { startedAtFromId, type MeetingLanguage } from '../shared/meetings.ts'
import { TRACKS, transcribeRecorded, type Track } from './replay.ts'
import { mcpToken } from './token.ts'
import { getSettings, setSettings, validPort, type AsrModel, type Language, type Settings } from './settings.ts'
import { hasSpeech } from './vad.ts'
import { forget, identify, knownVoices, remember } from './voices.ts'
import {
  NOTES_ROOT,
  assertMeetingDir,
  createMeetingDir,
  listMeetings,
  localIso,
  micTestLocked,
  readTranscript,
  resolveLanguage,
  transcribeStatus,
  transcriptionBusy,
  writeTranscript,
  type Transcript,
} from './store.ts'
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
async function diarizeMeeting(wc: WebContents, dir: string, notify = true, signal?: AbortSignal): Promise<void> {
  if (notify) wc.send('meeting:diarizing')
  try {
    const turns = await diarize(join(dir, 'loopback.wav'), signal)
    const previous = await readTranscript(dir)
    const segments = assignSpeakers(previous.segments, turns)
    const named = speakerNames(segments, previous.speakers, await speakerLabels())

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
      }
    }

    const updated: Transcript = { ...withTranscript, speakers: named, speakerVoices: recognizedVoices }
    await writeTranscript(dir, updated)
    if (notify) wc.send('meeting:transcript', dir, updated)
  } catch (err) {
    // A deliberate cancel is not a failure worth logging — same treatment as
    // whisper.ts's pump() gives an aborted chunk.
    if (!signal?.aborted) console.error(`diarize: ${dir}`, err)
    if (notify) wc.send('meeting:diarize-error', String(err))
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
    startedAt: startedAtFromId(id) ?? localIso(new Date()),
    durationSec: Math.max(...sizes) / 2 / SAMPLE_RATE,
    speakers: await defaultSpeakers(),
    segments: [],
  }
}

/**
 * One meeting from the batch queue (spec item 4): transcribes it exactly the way
 * 'after' mode does at session:stop. Only writes transcript.json — with `transcribedAt`
 * set — once the pass finds something to transcribe, so an aborted or failed attempt,
 * or a meeting with no audio in either track (LOW 10 — a WAV missing or emptied out,
 * not silence whisper actually ran over), leaves the meeting reading exactly as "not
 * transcribed yet" instead of falsely "done".
 *
 * Deliberately does NOT diarize (unlike the single-recording path at session:stop) —
 * the caller (batch:start) collects `dir` from the returned `hasAudio` flag and
 * diarizes every such meeting itself, in a second pass, only after the whole queue's
 * transcription is done and whisper-server has been released (MEDIUM 4): diarize.ts's
 * ~1GB peak plus voices.ts re-reading each speaker's WAV must never be concurrent with
 * whisper's own 0.8-3.4GB RSS, or the two together blow the RAM budget the settings UI
 * advertises on a 16GB machine.
 */
async function transcribeOne(
  wc: WebContents,
  id: string,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
): Promise<{ dir: string; hasAudio: boolean }> {
  const dir = assertMeetingDir(join(NOTES_ROOT, id))
  const previous = await readTranscript(dir).catch(() => fallbackTranscript(id, dir))
  // The meeting's own recorded language wins; only a meeting that predates this field
  // (previous.language is undefined) falls back to today's setting — spec item 1.
  const language = resolveLanguage(previous.language, (await getSettings()).meetingLanguage)
  const collected: Transcript['segments'] = []
  batchSink = collected
  let total: number
  try {
    const server = await transcription(wc)
    total = await transcribeRecorded(server, dir, language, onProgress, signal)
  } finally {
    batchSink = null
  }
  const updated: Transcript = {
    ...previous,
    // writeTranscript (store.ts) sorts by t0 before persisting — no need to do it twice.
    segments: collected,
    // Heals a legacy meeting: once resolved (even via the fallback above), the
    // language is persisted, so a second retroactive pass over the same meeting no
    // longer needs the fallback at all.
    language,
    ...(total > 0 ? { transcribedAt: localIso(new Date()) } : {}),
  }
  await writeTranscript(dir, updated)
  return { dir, hasAudio: total > 0 }
}

let downloads: AbortController | null = null

// The meetings-list batch queue (spec item 4). `batchFailed` is runtime-only — a
// restart forgets it, which is fine: the meeting really is still untranscribed, so it
// reads that way again rather than lying "done" or staying stuck "failed" forever.
let batchController: AbortController | null = null
let batchRunningId: string | null = null
const batchFailed = new Set<string>()

let mcp: McpHandle | null = null

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
  const handle = await startMcp({ token: await mcpToken(), root: NOTES_ROOT, port: (await getSettings()).mcpPort })
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
    transcribeOk = await transcription(wc)
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

  const transcript: Transcript = {
    id: s.id,
    startedAt: localIso(new Date(s.startedAt)),
    durationSec: Math.max(durations.loopback.durationSec, durations.mic.durationSec),
    speakers: await defaultSpeakers(),
    // writeTranscript (store.ts) sorts by t0 before persisting — no need to do it
    // twice, even though 'after' mode transcribing the two tracks one after another
    // means these arrive with every mic segment after every loopback segment.
    segments: s.segments,
    // Written unconditionally, in every mode — 'manual' mode writes no segments here
    // at all, so this is the ONLY chance to record what language this meeting was
    // spoken in; the batch queue reads it back via resolveLanguage whenever the user
    // eventually transcribes it (spec item 1).
    language: s.language,
    // Only set once an ASR pass has actually run over this meeting AND gotten
    // through every chunk (spec item 2) — 'manual' mode leaves it unset on purpose,
    // and a failed 'live'/'after' pass now leaves it unset too, both reading as
    // "not transcribed yet" for the meetings list.
    ...(s.mode !== 'manual' && transcribeOk ? { transcribedAt: localIso(new Date()) } : {}),
  }
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
  ipcMain.handle('meeting:rename', async (_e, dir: string, speakers: Record<string, string>) => {
    const previous = await readTranscript(assertMeetingDir(dir))
    const updated: Transcript = { ...previous, speakers: { ...previous.speakers, ...speakers } }
    await writeTranscript(assertMeetingDir(dir), updated)

    // Typing a name is the only moment we know whose voice this is. Learn it here so
    // the next meeting can fill it in on its own.
    for (const [speaker, name] of Object.entries(speakers)) {
      if (speaker === 'me' || speaker === name || !name.trim()) continue
      await remember(assertMeetingDir(dir), updated, speaker, name.trim()).catch(() => {})
    }
    return updated
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
    if (micTestLocked(current?.mode ?? null, batchController !== null)) {
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

  // Every recorded meeting plus its transcription status, for the meetings panel (spec
  // item 3/5). `listMeetings` only knows disk state (transcribed or not); "transcribing"
  // and "failed" are this session's own batch-queue state layered on top.
  // A single meeting's full transcript, for the meetings-list detail view (spec item
  // 1). Takes an id, not a directory — the renderer never learns NOTES_ROOT's actual
  // path, and the id is what gets resolved and guarded here (assertMeetingDir), the
  // same idiom transcribeOne already uses to turn a renderer-supplied id into a path.
  ipcMain.handle('meeting:get', async (_e, id: string) => {
    const dir = assertMeetingDir(join(NOTES_ROOT, id))
    return { dir, transcript: await readTranscript(dir) }
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
        const { dir, hasAudio } = await transcribeOne(e.sender, id, onProgress, signal)
        if (hasAudio) diarizeItems.push({ id, dir })
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
}

app.whenReady().then(() => {
  installDisplayMediaHandler()
  registerIpc()

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
  win.webContents.once('did-finish-load', () => {
    void getSettings().then((s) => {
      if (s.transcribeMode === 'live') void transcription(win.webContents).catch(() => {})
    })
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) win.loadURL(devUrl)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
})

app.on('before-quit', async (e) => {
  releaseWhisper()
  void mcp?.close()

  if (current && current.stopping) {
    // HIGH 1: session:stop is already tearing this meeting down — most likely 'after'
    // mode's multi-minute offline pass. The old code bailed here with no
    // preventDefault, so Cmd-Q anywhere in that window quit before writeTranscript
    // ever ran (finishSessionStop's very last step) and the finished ASR work was
    // simply discarded. Abort the pass (stopAbort — so quitting does not have to wait
    // out the whole recording) and then wait for the transcript finishSessionStop
    // still writes either way, partial or not, before actually quitting.
    e.preventDefault()
    stopAbort?.abort()
    await stopInFlight
    app.quit()
    return
  }

  // A half-written meeting is worth more than none: close the WAVs before quitting.
  // No drain here — the user asked to quit, so we save what already came back rather
  // than making them wait for the tail.
  if (!current) return
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
  app.quit()
})

app.on('window-all-closed', () => app.quit())
