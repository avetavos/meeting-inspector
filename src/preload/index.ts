import { contextBridge, ipcRenderer } from 'electron'

export type Track = 'loopback' | 'mic'
export type Segment = { t0: number; t1: number; text: string }

/** API keys stay in main (spec §5) — the renderer only ever gets these calls. */
const api = {
  permissions: () => ipcRenderer.invoke('perm:check'),
  requestPermissions: () => ipcRenderer.invoke('perm:request'),
  openPrivacySettings: (which: 'screen' | 'microphone') => ipcRenderer.invoke('perm:open', which),
  start: (title: string) => ipcRenderer.invoke('session:start', title),
  pcm: (track: Track, pcm: ArrayBuffer) => ipcRenderer.invoke('session:pcm', track, pcm),
  stop: () => ipcRenderer.invoke('session:stop'),
  reveal: (dir: string) => ipcRenderer.invoke('shell:reveal', dir),

  onSegments: (fn: (track: Track, segments: Segment[]) => void) =>
    ipcRenderer.on('transcript:segments', (_e, track: Track, segments: Segment[]) => fn(track, segments)),
  /** Chunks waiting on ASR. Spec §7: nothing is dropped, the UI just warns past 3. */
  onQueue: (fn: (depth: number) => void) =>
    ipcRenderer.on('transcript:queue', (_e, depth: number) => fn(depth)),
  onTranscriptError: (fn: (message: string) => void) =>
    ipcRenderer.on('transcript:error', (_e, message: string) => fn(message)),
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
