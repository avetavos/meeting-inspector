import { app, BrowserWindow, desktopCapturer, ipcMain, session, shell, systemPreferences, type WebContents } from 'electron'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { Chunker, type Chunk } from './chunker.ts'
import { assignSpeakers, diarize, speakerNames } from './diarize.ts'
import { MODELS, downloadModel, modelStatus } from './download.ts'
import { getKey, setKey } from './keys.ts'
import { PREFERRED_PORT, startMcp, type McpHandle } from './mcp.ts'
import { getSettings, setSettings } from './settings.ts'
import {
  NOTES_ROOT,
  assertMeetingDir,
  createMeetingDir,
  localIso,
  readTranscript,
  writeTranscript,
  type Transcript,
} from './store.ts'
import { WavWriter } from './wav.ts'
import { DEFAULT_PROMPT, Whisper } from './whisper.ts'

export type Track = 'loopback' | 'mic'

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
}

const TRACKS = ['loopback', 'mic'] as const

/** The mic track is us by construction (spec §4.1); `them` is replaced by diarization. */
const SPEAKER: Record<Track, string> = { mic: 'me', loopback: 'them' }
let current: Session | null = null

// One server for the app's lifetime: the 3GB model loads once, and by the time
// anyone presses record it is already warm. Chunks queue if it is still loading.
let whisper: Promise<Whisper> | null = null

function transcription(wc: WebContents): Promise<Whisper> {
  whisper ??= Whisper.start({
    language: 'th',
    prompt: DEFAULT_PROMPT,
    onSegments: (track, segments) => {
      current?.segments.push(...segments.map((s) => ({ ...s, speaker: SPEAKER[track as Track] })))
      wc.send('transcript:segments', track, segments)
    },
    onDepth: (depth) => wc.send('transcript:queue', depth),
  }).catch((err: unknown) => {
    whisper = null // let the next recording retry rather than wedging for good
    wc.send('transcript:error', String(err))
    throw err
  })
  return whisper
}

/**
 * Runs once a meeting ends (spec §4.2). Kicked off without awaiting: the recording is
 * already safely on disk, so this can take its time on a long file.
 */
async function diarizeMeeting(wc: WebContents, dir: string): Promise<void> {
  wc.send('meeting:diarizing')
  try {
    const turns = await diarize(join(dir, 'loopback.wav'))
    const previous = await readTranscript(dir)
    const segments = assignSpeakers(previous.segments, turns)
    const updated: Transcript = { ...previous, segments, speakers: speakerNames(segments, previous.speakers) }
    await writeTranscript(dir, updated)
    wc.send('meeting:transcript', dir, updated)
  } catch (err) {
    wc.send('meeting:diarize-error', String(err))
  }
}

async function enqueue(wc: WebContents, track: Track, chunk: Chunk, retry = true): Promise<void> {
  try {
    const server = await transcription(wc)
    // A dead whisper-server would swallow this chunk and every one after it without
    // anyone noticing, so start a fresh one and say so.
    if (!server.alive && retry) {
      whisper = null
      wc.send('transcript:error', 'whisper-server หยุดไป กำลังเริ่มใหม่ — ท่อนที่ค้างอยู่อาจหาย')
      return enqueue(wc, track, chunk, false)
    }
    server.enqueue(track, chunk)
  } catch {
    // transcription() already pushed the error to the renderer
  }
}

let downloads: AbortController | null = null

let mcp: McpHandle | null = null

/** Generated once and kept with the API keys — it is the only thing guarding the transcripts. */
async function mcpToken(): Promise<string> {
  const existing = await getKey('mcp')
  if (existing) return existing
  const token = randomBytes(24).toString('base64url')
  await setKey('mcp', token)
  return token
}

async function restartMcp(): Promise<void> {
  await mcp?.close()
  mcp = null
  if (!(await getSettings()).mcp) return
  mcp = await startMcp({ token: await mcpToken(), root: NOTES_ROOT })
}

async function mcpState() {
  const { mcp: enabled } = await getSettings()
  return {
    enabled,
    url: mcp?.url ?? null,
    token: mcp ? await mcpToken() : null,
    // Anything else means the saved client configs are pointing at the wrong place.
    portMoved: mcp !== null && mcp.port !== PREFERRED_PORT,
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
    if (current) throw new Error('already recording')
    const { id, dir } = await createMeetingDir(title)
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
    }
    return { id, dir }
  })

  ipcMain.handle('session:pcm', (e, track: Track, pcm: ArrayBuffer) => {
    if (!current || current.stopping) return
    const chunk = current.chunkers[track].push(new Int16Array(pcm))
    if (chunk) void enqueue(e.sender, track, chunk)
    return current.writers[track].write(Buffer.from(pcm))
  })

  ipcMain.handle('session:stop', async (e) => {
    if (!current || current.stopping) return null
    const s = current
    s.stopping = true
    for (const track of TRACKS) {
      const tail = s.chunkers[track].flush()
      if (tail) void enqueue(e.sender, track, tail)
    }
    const durations = { loopback: await s.writers.loopback.close(), mic: await s.writers.mic.close() }

    // Those tail chunks are still queued for ASR. Writing the transcript now would
    // silently drop the last minute of the meeting, so wait them out.
    await whisper?.then((w) => w.drain()).catch(() => {})
    current = null

    const transcript: Transcript = {
      id: s.id,
      startedAt: localIso(new Date(s.startedAt)),
      durationSec: Math.max(durations.loopback.durationSec, durations.mic.durationSec),
      speakers: { me: 'คุณ', them: 'คนอื่น' },
      segments: s.segments,
    }
    await writeTranscript(s.dir, transcript)
    void diarizeMeeting(e.sender, s.dir)
    return { id: s.id, dir: s.dir, durationSec: transcript.durationSec, segments: s.segments.length }
  })

  // Typing one name for two speakers is how you merge them (spec §8) — the summary
  // sees one person, and nothing has to reshuffle the segments.
  ipcMain.handle('meeting:rename', async (_e, dir: string, speakers: Record<string, string>) => {
    const previous = await readTranscript(assertMeetingDir(dir))
    const updated: Transcript = { ...previous, speakers: { ...previous.speakers, ...speakers } }
    await writeTranscript(assertMeetingDir(dir), updated)
    return updated
  })

  ipcMain.handle('models:status', () => modelStatus())
  ipcMain.handle('models:cancel', () => downloads?.abort())

  // Downloads run one at a time so the progress the user sees matches what is
  // actually moving, and a failure names the file that failed.
  ipcMain.handle('models:download', async (e) => {
    if (downloads) throw new Error('กำลังโหลดอยู่แล้ว')
    downloads = new AbortController()
    try {
      for (const spec of MODELS) {
        if ((await modelStatus()).find((m) => m.file === spec.file)?.present) continue
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

  ipcMain.handle('shell:reveal', (_e, dir: string) => shell.openPath(assertMeetingDir(dir)))
}

app.whenReady().then(() => {
  installDisplayMediaHandler()
  registerIpc()

  const win = new BrowserWindow({
    width: 720,
    height: 540,
    title: 'Meeting Inspector',
    webPreferences: { preload: join(__dirname, '../preload/index.js') },
  })

  void restartMcp().catch((err: unknown) => console.error('mcp:', err))

  // Warm the model now so the first chunk is not stuck behind a 3GB load.
  win.webContents.once('did-finish-load', () => void transcription(win.webContents).catch(() => {}))

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) win.loadURL(devUrl)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
})

// A half-written meeting is worth more than none: close the WAVs before quitting.
// A half-written meeting is worth more than none. No drain here — the user asked to
// quit, so we save what already came back rather than making them wait for the tail.
app.on('before-quit', async (e) => {
  void whisper?.then((w) => w.stop()).catch(() => {})
  void mcp?.close()
  if (!current || current.stopping) return
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
    speakers: { me: 'คุณ', them: 'คนอื่น' },
    segments: s.segments,
  }).catch(() => {})
  app.quit()
})

app.on('window-all-closed', () => app.quit())
