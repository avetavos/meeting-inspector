import { contextBridge, ipcRenderer } from 'electron'
import type { ModelStatus, Progress } from '../main/download.ts'
import type { Language, Settings } from '../main/settings.ts'
import type { Transcript } from '../shared/meetings.ts'

export type { Transcript } from '../shared/meetings.ts'
export type { ModelStatus, Progress } from '../main/download.ts'
export type { Language, Settings } from '../main/settings.ts'

export type Track = 'loopback' | 'mic'
export type Segment = { t0: number; t1: number; text: string }
export type McpState = {
  enabled: boolean
  url: string | null
  token: string | null
  portMoved: boolean
}

/** Everything here stays on this machine — the app makes no outbound calls of its own. */
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
  onQueue: (fn: (depth: number) => void) => ipcRenderer.on('transcript:queue', (_e, depth: number) => fn(depth)),
  onTranscriptError: (fn: (message: string) => void) =>
    ipcRenderer.on('transcript:error', (_e, message: string) => fn(message)),

  renameSpeakers: (dir: string, speakers: Record<string, string>): Promise<Transcript> =>
    ipcRenderer.invoke('meeting:rename', dir, speakers),
  onDiarizing: (fn: () => void) => ipcRenderer.on('meeting:diarizing', () => fn()),
  onDiarized: (fn: (dir: string, transcript: Transcript) => void) =>
    ipcRenderer.on('meeting:transcript', (_e, dir: string, t: Transcript) => fn(dir, t)),
  onDiarizeError: (fn: (message: string) => void) =>
    ipcRenderer.on('meeting:diarize-error', (_e, message: string) => fn(message)),

  modelStatus: (): Promise<ModelStatus[]> => ipcRenderer.invoke('models:status'),
  downloadModels: (): Promise<{ cancelled: boolean }> => ipcRenderer.invoke('models:download'),
  cancelModels: (): Promise<void> => ipcRenderer.invoke('models:cancel'),
  onModelProgress: (fn: (progress: Progress) => void) =>
    ipcRenderer.on('models:progress', (_e, p: Progress) => fn(p)),

  getSettings: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
  setLanguage: (language: Language): Promise<Settings> =>
    ipcRenderer.invoke('settings:set', { language }),

  knownVoices: (): Promise<string[]> => ipcRenderer.invoke('voices:list'),
  forgetVoice: (name: string): Promise<void> => ipcRenderer.invoke('voices:forget', name),

  mcpState: (): Promise<McpState> => ipcRenderer.invoke('mcp:state'),
  toggleMcp: (on: boolean): Promise<McpState> => ipcRenderer.invoke('mcp:toggle', on),
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
