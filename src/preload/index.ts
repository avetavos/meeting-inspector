import { contextBridge, ipcRenderer } from 'electron'

export type { Transcript } from '../main/store.ts'
export type { Cost, Provider, ProviderInfo } from '../main/summarize.ts'
export type { Settings } from '../main/settings.ts'
export type McpState = {
  enabled: boolean
  url: string | null
  token: string | null
  tunnelOn: boolean
  tunnelUrl: string | null
}
import type { Transcript } from '../main/store.ts'
import type { Settings } from '../main/settings.ts'
import type { Cost, Provider, ProviderInfo } from '../main/summarize.ts'

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

  setKey: (provider: string, key: string): Promise<void> => ipcRenderer.invoke('keys:set', provider, key),
  hasKey: (provider: string): Promise<boolean> => ipcRenderer.invoke('keys:has', provider),
  mcpState: (): Promise<McpState> => ipcRenderer.invoke('mcp:state'),
  toggleMcp: (on: boolean): Promise<McpState> => ipcRenderer.invoke('mcp:toggle', on),
  toggleTunnel: (on: boolean): Promise<McpState> => ipcRenderer.invoke('mcp:tunnel', on),
  providers: (): Promise<Record<Provider, ProviderInfo>> => ipcRenderer.invoke('summary:providers'),
  getSettings: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: Partial<Settings>): Promise<Settings> => ipcRenderer.invoke('settings:set', patch),
  estimateSummary: (dir: string): Promise<Cost | null> => ipcRenderer.invoke('summary:estimate', dir),
  runSummary: (dir: string): Promise<Cost> => ipcRenderer.invoke('summary:run', dir),
  onSummaryDelta: (fn: (text: string) => void) =>
    ipcRenderer.on('summary:delta', (_e, text: string) => fn(text)),

  renameSpeakers: (dir: string, speakers: Record<string, string>): Promise<Transcript> =>
    ipcRenderer.invoke('meeting:rename', dir, speakers),
  onDiarizing: (fn: () => void) => ipcRenderer.on('meeting:diarizing', () => fn()),
  onDiarized: (fn: (dir: string, transcript: Transcript) => void) =>
    ipcRenderer.on('meeting:transcript', (_e, dir: string, t: Transcript) => fn(dir, t)),
  onDiarizeError: (fn: (message: string) => void) =>
    ipcRenderer.on('meeting:diarize-error', (_e, message: string) => fn(message)),
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
