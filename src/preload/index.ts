import { contextBridge, ipcRenderer } from 'electron'
import type { ModelStatus, Progress } from '../main/download.ts'
import type { AsrModel, Language, MeetingLanguage, NoiseFilter, Settings, TranscribeMode } from '../main/settings.ts'
import type { TranscribeStatus } from '../main/store.ts'
import type { Transcript } from '../shared/meetings.ts'

export type { Transcript } from '../shared/meetings.ts'
export type { ModelStatus, Progress } from '../main/download.ts'
export type { AsrModel, Language, MeetingLanguage, NoiseFilter, Settings, TranscribeMode } from '../main/settings.ts'
export type { TranscribeStatus } from '../main/store.ts'

export type Track = 'loopback' | 'mic'
export type Segment = { t0: number; t1: number; text: string }
export type McpState = {
  enabled: boolean
  url: string | null
  token: string | null
  requestedPort: number
  port: number | null
  defaultPort: number
  portMoved: boolean
}

export type MeetingItem = {
  id: string
  title: string
  startedAt: string
  durationSec: number
  status: TranscribeStatus
  /** The meeting's own recorded language, or the current setting for a meeting that
   * predates that field (main's meeting:list handler already resolved it — see
   * store.ts's resolveLanguage) — so the meetings list can show which language a
   * meeting will be (or was) decoded in before the user queues it up. */
  language: MeetingLanguage
}
/** A voice diarization has clustered but nobody has named yet (spec item 1) — enough
 * to show the user who it might be (spec item 2) before they type a name: the
 * meeting it was first heard in, when, and what it said there. The audio sample
 * itself is a separate call (voiceSample) since it's heavier and only wanted on
 * demand, not prefetched for every pending voice up front. */
export type PendingVoiceItem = { id: string; meetingId: string; meetingTitle: string; at: string; text: string }
export type BatchTick = { id: string; index: number; total: number; fraction: number }
export type BatchItem = {
  id: string
  index: number
  total: number
  status: 'running' | 'done' | 'failed' | 'cancelled'
  error?: string
}
/** The batch queue's second pass (MEDIUM 4/5) — every transcribed meeting, diarized one
 * at a time only once the whole queue is transcribed and whisper is released. No
 * fraction: diarize() is one call per meeting with no fine-grained progress of its own. */
export type BatchDiarizing = { id: string; index: number; total: number }

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
  /** 'after' mode's one-pass replay at session:stop — a fraction of bytes processed
   * across both tracks, since a meeting has no fixed chunk count up front. */
  onTranscribing: (fn: (fraction: number) => void) =>
    ipcRenderer.on('meeting:transcribing', (_e, fraction: number) => fn(fraction)),

  modelStatus: (): Promise<ModelStatus[]> => ipcRenderer.invoke('models:status'),
  /** All three ASR models' download state, for the settings picker (not just the one
   * currently required, which is all `modelStatus` above reports). */
  asrModelStatus: (): Promise<Record<AsrModel, ModelStatus>> => ipcRenderer.invoke('models:asr-status'),
  downloadModels: (): Promise<{ cancelled: boolean }> => ipcRenderer.invoke('models:download'),
  cancelModels: (): Promise<void> => ipcRenderer.invoke('models:cancel'),
  onModelProgress: (fn: (progress: Progress) => void) =>
    ipcRenderer.on('models:progress', (_e, p: Progress) => fn(p)),

  getSettings: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
  setLanguage: (language: Language): Promise<Settings> =>
    ipcRenderer.invoke('settings:set', { language }),
  setNoiseFilter: (noiseFilter: NoiseFilter): Promise<Settings> =>
    ipcRenderer.invoke('settings:set', { noiseFilter }),
  setMeetingLanguage: (meetingLanguage: MeetingLanguage): Promise<Settings> =>
    ipcRenderer.invoke('settings:set', { meetingLanguage }),
  setTranscribeMode: (transcribeMode: TranscribeMode): Promise<Settings> =>
    ipcRenderer.invoke('settings:set', { transcribeMode }),
  setAsrModel: (asrModel: AsrModel): Promise<Settings> => ipcRenderer.invoke('settings:set', { asrModel }),
  /** Marks (or, from Settings' "Run setup again", implicitly re-marks once the flow is
   * completed again) the first-run onboarding flow as done. */
  setOnboarded: (onboarded: boolean): Promise<Settings> => ipcRenderer.invoke('settings:set', { onboarded }),

  probeMic: (pcm: ArrayBuffer): Promise<boolean> => ipcRenderer.invoke('mic:probe', pcm),
  transcribeMic: (pcm: ArrayBuffer): Promise<string> => ipcRenderer.invoke('mic:transcribe', pcm),
  /** Releases whisper-server once the mic test is done with it (spec item 4). */
  endMicTest: (): Promise<void> => ipcRenderer.invoke('mic:test-end'),

  knownVoices: (): Promise<string[]> => ipcRenderer.invoke('voices:list'),
  forgetVoice: (name: string): Promise<void> => ipcRenderer.invoke('voices:forget', name),

  /** Voices waiting to be named (spec item 1), oldest first-heard first. */
  pendingVoices: (): Promise<PendingVoiceItem[]> => ipcRenderer.invoke('voices:pending'),
  nameVoice: (id: string, name: string): Promise<void> => ipcRenderer.invoke('voices:name', id, name),
  /** A short WAV preview of a pending voice's own audio (spec item 2), or null if the
   * meeting it was heard in is gone. Play it from a Blob URL — CSP's media-src allows
   * `blob:` already, nothing to widen. */
  voiceSample: (id: string): Promise<Uint8Array | null> => ipcRenderer.invoke('voices:sample', id),

  /** Every recorded meeting, newest first, with its transcription status (spec item 3). */
  listMeetings: (): Promise<MeetingItem[]> => ipcRenderer.invoke('meeting:list'),
  /** A single meeting's full transcript, for the meetings-list detail view (spec item
   * 1) — takes an id, not a directory: main resolves and guards the path itself
   * (assertMeetingDir), the same way transcribeOne already does. */
  getTranscript: (id: string): Promise<{ dir: string; transcript: Transcript }> =>
    ipcRenderer.invoke('meeting:get', id),
  /** Transcribes the given meetings one at a time, in order (spec item 4). Resolves
   * once the queue has started, not once it has finished — onBatchItem/onBatchDone
   * report the rest. */
  transcribeMeetings: (ids: string[]): Promise<void> => ipcRenderer.invoke('batch:start', ids),
  cancelTranscribeMeetings: (): Promise<void> => ipcRenderer.invoke('batch:cancel'),
  onBatchProgress: (fn: (tick: BatchTick) => void) =>
    ipcRenderer.on('batch:progress', (_e, tick: BatchTick) => fn(tick)),
  onBatchItem: (fn: (item: BatchItem) => void) => ipcRenderer.on('batch:item', (_e, item: BatchItem) => fn(item)),
  onBatchDiarizing: (fn: (tick: BatchDiarizing) => void) =>
    ipcRenderer.on('batch:diarizing', (_e, tick: BatchDiarizing) => fn(tick)),
  onBatchDone: (fn: (result: { cancelled: boolean }) => void) =>
    ipcRenderer.on('batch:done', (_e, result: { cancelled: boolean }) => fn(result)),

  mcpState: (): Promise<McpState> => ipcRenderer.invoke('mcp:state'),
  toggleMcp: (on: boolean): Promise<McpState> => ipcRenderer.invoke('mcp:toggle', on),
  setMcpPort: (port: number): Promise<McpState> => ipcRenderer.invoke('mcp:port', port),
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
