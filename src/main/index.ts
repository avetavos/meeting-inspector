import { app, BrowserWindow, desktopCapturer, ipcMain, session, shell, systemPreferences, type WebContents } from 'electron'
import { join } from 'node:path'
import { Chunker, type Chunk } from './chunker.js'
import { createMeetingDir } from './store.js'
import { WavWriter } from './wav.js'
import { Whisper } from './whisper.js'

export type Track = 'loopback' | 'mic'

/** Decision 4.1: two tracks, never mixed — the mic track is "me" without any diarization. */
type Session = {
  id: string
  dir: string
  startedAt: number
  writers: Record<Track, WavWriter>
  chunkers: Record<Track, Chunker>
}
let current: Session | null = null

// One server for the app's lifetime: the 3GB model loads once, and by the time
// anyone presses record it is already warm. Chunks queue if it is still loading.
let whisper: Promise<Whisper> | null = null

function transcription(wc: WebContents): Promise<Whisper> {
  whisper ??= Whisper.start(
    'th',
    (track, segments) => wc.send('transcript:segments', track, segments),
    (depth) => wc.send('transcript:queue', depth),
  ).catch((err: unknown) => {
    whisper = null // let the next recording retry rather than wedging for good
    wc.send('transcript:error', String(err))
    throw err
  })
  return whisper
}

async function enqueue(wc: WebContents, track: Track, chunk: Chunk): Promise<void> {
  try {
    ;(await transcription(wc)).enqueue(track, chunk)
  } catch {
    // transcription() already pushed the error to the renderer
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
    }
    return { id, dir }
  })

  ipcMain.handle('session:pcm', (e, track: Track, pcm: ArrayBuffer) => {
    if (!current) return
    const chunk = current.chunkers[track].push(new Int16Array(pcm))
    if (chunk) void enqueue(e.sender, track, chunk)
    return current.writers[track].write(Buffer.from(pcm))
  })

  ipcMain.handle('session:stop', async (e) => {
    if (!current) return null
    const session = current
    current = null
    for (const track of ['loopback', 'mic'] as const) {
      const tail = session.chunkers[track].flush()
      if (tail) void enqueue(e.sender, track, tail)
    }
    const loopback = await session.writers.loopback.close()
    const mic = await session.writers.mic.close()
    return { id: session.id, dir: session.dir, loopback, mic }
  })

  ipcMain.handle('shell:reveal', (_e, dir: string) => shell.openPath(dir))
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

  // Warm the model now so the first chunk is not stuck behind a 3GB load.
  win.webContents.once('did-finish-load', () => void transcription(win.webContents).catch(() => {}))

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) win.loadURL(devUrl)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
})

// A half-written meeting is worth more than none: close the WAVs before quitting.
app.on('before-quit', async (e) => {
  void whisper?.then((w) => w.stop()).catch(() => {})
  if (!current) return
  e.preventDefault()
  const session = current
  current = null
  await Promise.allSettled([session.writers.loopback.close(), session.writers.mic.close()])
  app.quit()
})

app.on('window-all-closed', () => app.quit())
