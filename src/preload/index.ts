import { contextBridge, ipcRenderer } from 'electron'
import type { ModelStatus, Progress } from '../main/download.ts'
import type { AsrEngine, AsrModel, Language, MeetingLanguage, NoiseFilter, Settings, SpeakerSplit, TranscribeMode } from '../main/settings.ts'
import type { UpdateInfo, UpdateProgress } from '../main/update.ts'
import type { Connection } from '../main/openrouter.ts'
import type { TranscribeStatus } from '../main/store.ts'
import type { Transcript } from '../shared/meetings.ts'

export type { Transcript } from '../shared/meetings.ts'
export type { ModelStatus, Progress } from '../main/download.ts'
export type { AsrEngine, AsrModel, Language, MeetingLanguage, NoiseFilter, Settings, SpeakerSplit, TranscribeMode } from '../main/settings.ts'
export type { TranscribeStatus } from '../main/store.ts'
export type { UpdateInfo, UpdateProgress } from '../main/update.ts'
export type { Connection, RemoteModel } from '../main/openrouter.ts'

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
/** One row of Settings › Speakers: a person, and how many stored embeddings are filed
 * under that name (voices.ts's KnownVoice) — several is normal for someone named across
 * more than one meeting, and is why the list needed collapsing. */
export type KnownVoice = { name: string; samples: number }
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

  /** Reports that a speaker in this meeting was matched to the wrong stored voice, and
   * breaks that link. The voice itself is left alone — it is only wrong here. */
  unlinkSpeaker: (dir: string, speaker: string): Promise<Transcript> =>
    ipcRenderer.invoke('meeting:unlink-speaker', dir, speaker),
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
  /** How eagerly diarization merges what it hears into one speaker. Takes effect the
   * next time a meeting is diarized, not retroactively. */
  setSpeakerSplit: (speakerSplit: SpeakerSplit): Promise<Settings> =>
    ipcRenderer.invoke('settings:set', { speakerSplit }),
  /** Whether to drop mic lines that are the room's own speakers echoing back. Applies
   * to the next transcript written, not to the ones already on disk. */
  setEchoFilter: (echoFilter: boolean): Promise<Settings> => ipcRenderer.invoke('settings:set', { echoFilter }),
  /** Which engine a RECORDED pass runs through — 'openrouter' sends the audio off this
   * machine. Live transcription is always local. */
  setAsrEngine: (asrEngine: AsrEngine): Promise<Settings> => ipcRenderer.invoke('settings:set', { asrEngine }),
  setRemoteModel: (remoteModel: string): Promise<Settings> => ipcRenderer.invoke('settings:set', { remoteModel }),

  /** Whether an OpenRouter key is stored. The key itself never comes back here. */
  hasOpenrouterKey: (): Promise<boolean> => ipcRenderer.invoke('openrouter:has-key'),
  /** Saves the key and reports what it works for: credit left, and every model that
   * takes audio, priced, cheapest first. */
  connectOpenrouter: (key: string): Promise<Connection> => ipcRenderer.invoke('openrouter:connect', key),
  /** The same list again, with the key already stored. */
  openrouterModels: (): Promise<Connection> => ipcRenderer.invoke('openrouter:models'),
  /** Deletes the stored key and puts transcription back on this machine. */
  forgetOpenrouter: (): Promise<void> => ipcRenderer.invoke('openrouter:forget'),
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

  knownVoices: (): Promise<KnownVoice[]> => ipcRenderer.invoke('voices:list'),
  /** Throws away a voice that is still waiting for a name — room noise or a
   * hallucinated line the diarizer clustered as a person. Only ever an unnamed one;
   * `forgetVoice` is the named case. */
  discardVoice: (id: string): Promise<boolean> => ipcRenderer.invoke('voices:discard', id),
  /** Renames every stored voice under `from`, and resolves to how many that was.
   * Renaming onto a name that already exists is how two people get merged into one. */
  renameVoice: (from: string, to: string): Promise<number> => ipcRenderer.invoke('voices:rename', from, to),
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
  /** `audio` says which of the two tracks are still on disk — the meetings list can
   * delete a meeting's audio and keep its words, and the detail page's player has to
   * know that rather than find out by failing to load. */
  getTranscript: (id: string): Promise<{ dir: string; audio: Record<string, boolean>; transcript: Transcript }> =>
    ipcRenderer.invoke('meeting:get', id),
  /** The folder every recording and transcript is saved into, and a way to open it —
   * onboarding's files step shows both. */
  notesRoot: (): Promise<string> => ipcRenderer.invoke('notes:root'),

  /** This build's own version, as shown in Settings › General. */
  appVersion: (): Promise<string> => ipcRenderer.invoke('update:version'),
  /** The latest release if it is newer than this build, else null. */
  checkForUpdate: (): Promise<UpdateInfo | null> => ipcRenderer.invoke('update:check'),
  /** Downloads that release and stops there. Installing means closing the app, so it
   * is a separate, deliberate step (applyUpdate). */
  downloadUpdate: (info: UpdateInfo): Promise<void> => ipcRenderer.invoke('update:download', info),
  /** Puts the downloaded release in place. 'now' replaces the app and restarts it —
   * so this resolving is not the normal outcome, the app quitting is. 'quit' leaves it
   * to happen the next time the app is closed. */
  applyUpdate: (when: 'now' | 'quit'): Promise<void> => ipcRenderer.invoke('update:apply', when),
  /** Throws the download away and disarms an install that was waiting for quit. */
  discardUpdate: (): Promise<void> => ipcRenderer.invoke('update:discard'),
  cancelUpdate: (): Promise<void> => ipcRenderer.invoke('update:cancel'),
  onUpdateProgress: (fn: (progress: UpdateProgress) => void) =>
    ipcRenderer.on('update:progress', (_e, progress: UpdateProgress) => fn(progress)),
  openNotesFolder: (): Promise<string> => ipcRenderer.invoke('notes:open'),
  /** Deletes saved meetings. `keepTranscript` drops only the two WAVs and leaves
   * transcript.json/.md in place — offered only for meetings that HAVE been
   * transcribed, since for the rest it would leave a folder with nothing in it. */
  deleteMeetings: (ids: string[], keepTranscript: boolean): Promise<void> =>
    ipcRenderer.invoke('meeting:delete', ids, keepTranscript),
  /** Renames a saved meeting, and resolves to the id it now has — the title lives in
   * the folder name, so a rename moves the folder and the id changes with it. */
  setMeetingTitle: (id: string, title: string): Promise<string> =>
    ipcRenderer.invoke('meeting:set-title', id, title),
  /** A native modal worded from the renderer's own message catalogue. Resolves to the
   * index of the button pressed; the last button is the cancel/escape one. */
  ask: (message: string, detail: string, buttons: string[]): Promise<number> =>
    ipcRenderer.invoke('dialog:ask', { message, detail, buttons }),
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
