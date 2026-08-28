import type {
  AsrModel,
  BatchDiarizing,
  BatchItem,
  BatchTick,
  Language,
  McpState,
  MeetingItem,
  MeetingLanguage,
  ModelStatus,
  PendingVoiceItem,
  AsrEngine,
  RemoteModel,
  SpeakerSplit,
  Transcript,
  UpdateInfo,
  TranscribeMode,
  TranscribeStatus,
} from '../preload/index.ts'
import { titleOf, untitledTitle } from '../shared/meetings.ts'
import { Recorder, openMicTap, type Track } from './recorder.ts'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

/** Every user-visible string in the renderer. English is the default voice; Thai is kept as-is. */
const en = {
  start: 'Start recording',
  stop: 'End meeting',
  pause: 'Pause',
  resume: 'Resume',
  micMute: 'Mute mic',
  micUnmute: 'Unmute mic',
  micMutedNote: 'Microphone off — your voice is not going into the recording. Everyone else still is.',
  pausedNote: 'Paused — nothing from now until you resume goes into the recording.',
  miniOpen: 'Back to the recording',
  meterOthers: 'Others',
  meterUs: 'You',
  settingsSummary: 'Settings',
  settingsBack: 'Back',
  catGeneral: 'General',
  catRecording: 'Recording',
  catTranscription: 'Transcription',
  catSpeakers: 'Speakers',
  catConnections: 'Connections',
  langRowLabel: 'Interface language',
  languageSaveFailed: (msg: string) => `Could not switch language: ${msg}`,
  mcpRowLabel: 'MCP server',
  micTestRowLabel: 'Microphone test',
  voicesHeading: (n: number) => `Voices I recognise (${n})`,
  voicesEmpty: 'No voices yet — name a speaker after a meeting and I will know them next time',
  voicesForget: 'Forget',
  voicesSamples: (n: number) => `${n} recordings`,
  voicesRenameHint: 'Rename, or type a name already in the list to merge the two into one person.',
  voicesMergeTitle: (from: string, to: string) => `Merge "${from}" into "${to}"?`,
  voicesMergeDetail:
    'They become one person: one row here, one name everywhere it has already been used, and both recordings of the voice kept as ways to recognise them. Splitting them again means renaming one back.',
  voicesMergeConfirm: 'Merge',
  pendingHeading: (n: number) => `New voices waiting to be named (${n})`,
  pendingEmpty: 'No new voices waiting to be named',
  pendingHeard: (title: string, when: string) => `First heard in ${title} · ${when}`,
  pendingSaidLabel: 'Said: ',
  pendingNamePlaceholder: 'Name this voice',
  pendingSave: 'Save',
  pendingDiscard: 'Not a person',
  pendingDiscardHint: 'Throw this voice away — room noise, or a line invented out of silence, rather than someone to name.',
  pendingPlay: 'Play sample',
  pendingPlaying: 'Playing…',
  pendingNoSample: 'No audio sample available',
  micTest: 'Test my microphone',
  micTestStop: 'Stop',
  micTestPrompt: 'Read this out loud',
  micTestExpected: 'You read',
  micTestGot: 'It heard',
  micTestTerms: (found: string[], missed: string[]) =>
    missed.length === 0
      ? `Both technical terms came through: ${found.join(', ')}`
      : `Missed: ${missed.join(', ')}${found.length > 0 ? ` · kept: ${found.join(', ')}` : ''}`,
  micTestSpeech: 'hearing speech',
  micTestDropped: 'ignoring this',
  micTestNothing: 'Nothing survived the filter.',
  micTestFailed: (msg: string) => `Couldn't test the microphone: ${msg}`,
  // Batch running is stable enough to disable the button outright, with a reason —
  // unlike a non-live recording, which the renderer only finds out via the rejection
  // this same button's own transcribeMic call gets back (main is the source of truth
  // there, see toggleMicTest).
  micTestLockedReason: 'Unavailable while meetings are being transcribed in the background.',
  micVerdictQuiet: 'The microphone barely picked anything up. This is not the filter — check the input device, or speak closer.',
  micLevelNow: (pct: number) => `input level ${pct}%`,
  micTooQuiet: 'Barely any input — check the input device in System Settings › Sound, or move closer to the mic.',
  micListening: 'listening…',
  micVerdictTooStrict: (pct: number) =>
    `Your voice registered only ${pct}% of the time and nothing reached the transcript. This level is too strict for this room.`,
  micVerdictPatchy: (pct: number) =>
    `Your voice registered ${pct}% of the time — it is dropping in and out, so parts of a meeting would go missing.`,
  micVerdictGood: (pct: number) =>
    `Your voice registered ${pct}% of the time and came through to the transcript. This level suits this room.`,
  micVerdictTryStricter: 'If the room still produces lines when nobody talks, move up one and test again.',
  micLower: 'Lower it one step',
  micRaise: 'Raise it one step',
  portLabel: 'MCP port',
  portSave: 'Apply',
  portInvalid: 'Pick a port between 1024 and 65535.',
  portTakenUsingDefault: (wanted: number, actual: number) =>
    `Port ${wanted} is already in use by something else, so the server is on ${actual}. Pick a free port, or point your clients at ${actual}.`,
  portTakenUsingAny: (wanted: number, actual: number) =>
    `Port ${wanted} is in use, and so is the default, so the server took ${actual}. Pick a free port — this one changes every launch.`,
  // The requested port IS the default here, so there was only one failed attempt,
  // not two — portTakenUsingAny's "and so is the default" would be redundant and
  // misleading.
  portTakenUsingAnyIsDefault: (wanted: number, actual: number) =>
    `Port ${wanted} is already in use, so the server took ${actual}. Pick a free port — this one changes every launch.`,
  transcribeModeLabel: 'Transcribe',
  transcribeModeAfter: 'After the meeting',
  transcribeModeLive: 'Live, as it happens',
  transcribeModeManual: "I'll pick which meetings, myself",
  transcribeModeHint: {
    after: 'The default. Nothing is transcribed while you record — the whole recording turns into a transcript in one pass once the meeting ends. Keeps memory use low while recording.',
    live: 'The transcript fills in while people talk, but a 3 GB model stays loaded for the whole meeting.',
    manual: "Nothing is transcribed automatically, ever — not during the meeting, not after it ends. Pick the meetings you want transcribed from the list below, whenever you want, one at a time or several at once.",
  } as Record<string, string>,
  transcribeAfterPlaceholder: 'The transcript appears once the meeting ends.',
  transcribeManualPlaceholder: "This won't be transcribed automatically — pick it from the meetings list below when you're ready.",
  transcribing: (pct: number) => `Transcribing… ${pct}%`,
  asrModelLabel: 'Transcription model',
  asrModelName: { turbo: 'Turbo (light)', medium: 'Medium', large: 'Large (accurate)' } as Record<AsrModel, string>,
  asrModelDetail: {
    turbo:
      'Lightest and fastest by far: 0.78 GB while transcribing, about 2 minutes for 30 minutes of audio. Weakest of the three on technical jargon — 22 of 27 terms right in our test.',
    medium:
      'Sits between the other two on memory (1.96 GB), but is the slowest of the three — about 8 minutes for 30 minutes of audio. Catches more jargon than Turbo (25 of 27 terms) without needing as much RAM as Large. Worth it only if that trade matters to you.',
    large:
      'Most accurate: 26 of 27 terms right in our test, lowest transcription error rate. Also the most RAM — 3.43 GB while transcribing — and about 6 minutes for 30 minutes of audio.',
  } as Record<AsrModel, string>,
  asrModelDownloaded: 'On this machine',
  asrModelPartial: (progress: string) => `Partially downloaded (${progress}) — will resume from there`,
  asrModelNeedsDownload: (size: string) => `Not downloaded yet — ${size}`,
  asrModelTimingNote: 'Times are approximate, measured on an Apple Silicon Mac — yours may differ.',
  meetingLangLabel: 'Meeting language',
  meetingLangName: { th: 'Thai', en: 'English' } as Record<MeetingLanguage, string>,
  echoLabel: 'Remove the speakers from the mic',
  echoHint:
    'On speakers rather than headphones, the microphone hears the meeting as well, so the far end gets transcribed twice — once under their name and once, a moment later, under You. This drops that second copy. Turn it off on headphones: there is no echo to remove, and all it can do there is take away a line someone genuinely repeated.',
  remoteLabel: 'Transcribe with a model elsewhere (OpenRouter)',
  remoteLead:
    'For machines that cannot spare the 0.8–3.4GB Whisper needs, plus about a gigabyte while it works out who was speaking. Turning this on sends your meeting audio off this machine — read what that means before you do.',
  remoteOnHint: 'Applies to recorded meetings only. Transcribing live always runs here.',
  // Said in full, in the panel, whenever this engine is selected — not once in a dialog
  // and then never again.
  remoteWarning:
    'Your meeting audio leaves this machine. Both tracks — what the other side said and what your microphone heard — are sent in ~30-second pieces to openrouter.ai, which passes them to whichever model you pick and to that model\'s provider. What they keep, and for how long, is their policy and not this app\'s. You are billed on your own key. Nothing else about the meeting is sent: no transcript, no names, no file. Recording, storage, speaker recognition and MCP all stay on this machine either way.',
  remoteKeyPlaceholder: 'OpenRouter API key (sk-or-…)',
  remoteConnect: 'Connect',
  remoteConnecting: 'Checking the key…',
  remoteForget: 'Remove key and go back to local',
  remoteNoKey: 'A key of your own is needed. Create one at openrouter.ai/keys.',
  remoteConnected: (models: number) => `Key works — ${models} models here accept audio.`,
  remoteCredit: (usd: number) => ` ${usd.toFixed(2)} USD left on it.`,
  remoteFreeTier: ' This is a free-tier key, so expect rate limits on a long meeting.',
  remoteFailed: (msg: string) => `Could not use that key: ${msg}`,
  remoteModelLabel: 'Model',
  // Measured on this app's own Thai/English test clip, and worth saying: the cheapest
  // model here is also the one that writes Thai properly, which is not the ordering
  // anyone expects.
  remoteModelAdvice:
    'Gemini 2.5 Flash Lite is the default and, on Thai, the most accurate of the cheap ones — some larger models put a space between every Thai syllable. Try a short meeting on a new model before trusting it with a long one.',
  remoteModelPrice: (usdPerHour: number, usdPerMillion: number) =>
    `About $${usdPerHour.toFixed(2)} per hour of meeting ($${usdPerMillion.toFixed(2)} per million audio tokens, estimated at 32 tokens a second). Silence is never sent, so a quiet meeting costs less than its length.`,
  remoteModelFree: 'Free at the moment. Free models are rate-limited and can be withdrawn without notice.',
  remoteModelUnpriced: 'This model does not price audio separately, so the cost per hour cannot be estimated here — check it on openrouter.ai before transcribing anything long.',
  remoteConfirmTitle: 'Send meeting audio to OpenRouter?',
  remoteConfirmDetail:
    'From now on, recorded meetings are transcribed by sending their audio off this machine to openrouter.ai and on to the model you pick. Live transcription, storage, speaker recognition and MCP all stay here. You can switch back at any time.',
  remoteConfirmYes: 'Send it',
  speakerSplitLabel: 'Splitting speakers apart',
  speakerSplitName: {
    fine: 'Fine — every difference is a new person',
    balanced: 'Balanced',
    coarse: 'Coarse — same person more often',
  } as Record<SpeakerSplit, string>,
  speakerSplitHint: {
    fine: 'Two people with similar voices stay two people, but one person recorded at changing volume — through a conference app, or moving away from the mic — can come back as several.',
    balanced: 'The default. Handles most meetings recorded through a call.',
    coarse: 'Use when a transcript comes back with far more speakers than were in the room. Two genuinely similar voices may be filed as the same person.',
  } as Record<SpeakerSplit, string>,
  speakerSplitApplies: 'Applies the next time a meeting is diarized — re-transcribe an existing one to redo it with this setting.',
  meetingLangHint:
    'The language people speak in the meeting — not the interface language above. Picking wrong is costly: in our tests, an English meeting decoded as Thai came out with 9.0% of characters wrong and missed a technical term (17/18); decoded as English, 0.6% wrong and every term right (18/18). A Thai meeting decoded as English came out 34.0% wrong (21/27 terms); decoded as Thai, 15.7% wrong (22/27 terms).',
  noiseLabel: 'Ignore noise',
  noiseLow: 'Keep everything',
  noiseMedium: 'Balanced',
  noiseHigh: 'Speech only',
  noiseHint: {
    low: 'Room tone is still ignored. Faint talking in a noisy room is kept — with it, the odd line the room made rather than a person.',
    medium: 'The default. Room tone ignored, quiet and distant speech still transcribed.',
    high: 'Also drops very faint speech in a noisy room. Use this if lines appear when nobody is talking.',
  } as Record<string, string>,
  // Not threaded per meeting the way meetingLanguage is (spec item 2's noiseFilter
  // decision) — locked instead, for as long as a recording or batch pass is using it,
  // so this is what explains the greyed-out control rather than leaving it mysteriously
  // inert.
  noiseLockedHint: 'Locked while a transcription is running — this setting affects chunks still in flight. Try again once it finishes.',
  mcpLabel: 'Turn on the MCP server so a local AI assistant can pull the transcript to summarize it',
  mcpUrlLabel: 'URL',
  mcpTokenLabel: 'Bearer token',
  mcpTokenReveal: 'Show',
  mcpTokenHide: 'Hide',
  mcpConnectTitle: 'Connect an app',
  mcpConnectOff: 'Turn on the server above to get connection details for your app.',
  mcpConnectAppLabel: 'Pick your app, then copy what it needs.',
  mcpConnectStepsCode: 'Run this in a terminal:',
  mcpConnectStepsDesktop: "Add this to the app's MCP config:",
  permWhy: {
    screen: 'Needed to record system audio — everyone else in the meeting',
    microphone: 'Needed to record your microphone',
  },
  // Names of the macOS System Settings privacy panes, as Apple's own Thai
  // localization renders them — kept in sync with what a Thai-system user
  // actually sees on screen, not a literal translation of the English pane name.
  permName: { screen: 'Screen Recording', microphone: 'Microphone' } as Record<'screen' | 'microphone', string>,
  permNeverAsked: (name: string, why: string) => `Never asked for ${name} access — ${why}`,
  permDenied: (name: string, why: string) => `${name} access is off — ${why}`,
  permGrant: (name: string) => `Allow ${name}`,
  permOpenSettings: 'Open System Settings',
  trackLost: (track: string) => `${track} track stopped unexpectedly — stop and start again`,
  startFailed: (msg: string) => `Couldn't start recording: ${msg}`,
  transcribingRest: "Transcribing what's left…",
  saved: (dur: string, segments: number) => `Saved ${dur} · ${segments} segment${segments === 1 ? '' : 's'} — `,
  queueBacklog: (depth: number) => `Falling behind on transcription — ${depth} chunk${depth === 1 ? '' : 's'} queued`,
  whisperError: (msg: string) => `whisper-server didn't start: ${msg}`,
  diarizing: "Working out who's speaking…",
  diarizeError: (msg: string) => `Couldn't split speakers: ${msg} (the transcript is still there)`,
  modelsMissing: (count: number, size: string) =>
    `Missing ${count} model file${count === 1 ? '' : 's'} (${size}) — you can record, but can't transcribe yet`,
  modelsResumable: (size: string) => ` · ${size} already downloaded, will pick up where it left off`,
  downloadModels: 'Download models',
  cancel: 'Cancel',
  downloading: 'Downloading…',
  downloadCancelled: 'Cancelled — will resume next time',
  downloadComplete: 'Download complete',
  speakerSave: 'Save names',
  speakerSaved: 'Saved',
  speakerMergeHint: 'If someone got split into two speakers, give them the same name to merge them.',
  speakerScopeHint: 'A 🔊 speaker is a voice this app already recognises — renaming them updates every meeting. Anyone else is renamed only in this meeting.',
  voiceRecognisedTag: 'recognised',
  speakerParts: (n: number) => `${n} parts`,
  speakerHear: 'Hear',
  speakerHearHint: 'Plays their longest line, so you can tell who this is before naming them.',
  speakerWrongVoice: 'Not them',
  speakerWrongVoiceHint: 'This speaker was matched to a stored voice — say so if it is the wrong person.',
  speakerWrongTitle: (name: string) => `This is not ${name}?`,
  speakerWrongDetail:
    'The link between this speaker and the stored voice is dropped, and this meeting alone forgets the name. The voice itself is kept — it is presumably right in the meetings where it was matched correctly, and deleting it would take those with it. Then type who this actually is: an existing name puts them with that person, a new one starts a new voice.',
  speakerWrongYes: 'Wrong person — unlink',
  speakerJump: 'Find this speaker above',
  copy: 'Copy',
  copied: 'Copied',
  speakerDefaults: { me: 'You', them: 'Others' },
  // Same wording as main/index.ts's own SPEAKER_LABELS.speaker(n) — the renderer's own
  // number (by first appearance among lines still unattributed) can't promise to match
  // main's actual cluster numbering, but the *words* should read as the same convention.
  unnamedSpeaker: (n: number) => `Speaker ${n}`,
  meetingsHeading: 'Meetings',
  meetingsEmpty: 'No meetings recorded yet.',
  meetingsStatus: {
    'not-transcribed': 'Not transcribed',
    transcribing: 'Transcribing…',
    done: 'Done',
    failed: 'Failed — try again',
  } as Record<TranscribeStatus, string>,
  meetingsSelectAll: 'Select all',
  meetingsSelectNone: 'Clear selection',
  meetingsTranscribe: (n: number) => (n === 0 ? 'Transcribe' : `Transcribe ${n} meeting${n === 1 ? '' : 's'}`),
  meetingsStop: 'Stop',
  meetingsDelete: (n: number) => (n === 0 ? 'Delete' : `Delete ${n}`),
  // Two different questions, because two different things are at stake. A meeting that
  // was never transcribed has nothing but its audio, so deleting it deletes everything
  // there ever was of it — asked twice, deliberately. A transcribed one keeps its words
  // either way, so the only real question is whether those go too.
  deleteUndoneTitle: (n: number) => `Delete ${n} recording${n === 1 ? '' : 's'} that ${n === 1 ? 'was' : 'were'} never transcribed?`,
  deleteUndoneDetail: 'The audio is all there is of these — nothing has been transcribed from them yet, so this cannot be undone and there will be nothing left to transcribe later.',
  deleteUndoneConfirmTitle: 'Really delete? The audio has not been transcribed.',
  deleteUndoneConfirmDetail: 'Last chance: these recordings will be gone for good, and there is no transcript anywhere else.',
  deleteDoneTitle: (n: number) => `${n} of these ${n === 1 ? 'has' : 'have'} already been transcribed — the transcript will stay.`,
  deleteDoneDetail: 'Deleting the audio frees most of the disk space and leaves the transcript readable. Delete the transcript as well?',
  deleteAudioOnly: 'Delete audio only',
  deleteEverything: 'Delete everything',
  deleteConfirm: 'Delete',
  deleteCancel: 'Cancel',
  deleteFailed: (msg: string) => `Could not delete: ${msg}`,
  renameFailed: (msg: string) => `Could not rename: ${msg}`,
  meetingRenameHint: 'Double-click a meeting title to rename it.',
  meetingsProgress: (title: string, index: number, total: number, pct: number) =>
    `Transcribing ${title} (${index}/${total}) — ${pct}%`,
  // The main page only ever shows the 5 most recent (spec item a) — this is the way
  // to everything else, and doubles as a hint that there is more.
  viewAllMeetings: (n: number) => `View all ${n} meeting${n === 1 ? '' : 's'}`,
  allMeetingsTitle: 'All meetings',
  // A done meeting is deliberately excluded from "Select all" (spec item c) — checking
  // it yourself is the only way in, so this is the one place that cost gets said out
  // loud before the Transcribe button is pressed. What actually survives is decided by
  // voices.ts's cross-meeting voice recognition, not by anything this meeting's own
  // transcript.json remembers — SPEAKER_00 this run has no guaranteed relation to
  // SPEAKER_00 last run (diarize.ts's clustering starts over from nothing each time).
  meetingsRetranscribeWarning: (n: number) =>
    n === 1
      ? "Re-transcribing this already-done meeting replaces its transcript. A speaker you renamed comes back automatically only if this app already recognises that voice (Settings › Speakers) — otherwise you'll need to rename them again."
      : `Re-transcribing ${n} already-done meetings replaces their transcripts. A speaker you renamed comes back automatically only if this app already recognises that voice (Settings › Speakers) — otherwise you'll need to rename them again.`,
  // Second pass of the batch queue (MEDIUM 4), once every meeting is transcribed and
  // whisper-server has been let go — this is what puts speaker names on the transcript.
  meetingsDiarizing: (title: string, index: number, total: number) =>
    `Identifying speakers in ${title} (${index}/${total})…`,
  // Shown the instant Stop is clicked (MEDIUM 5) — diarizing a meeting cannot be
  // interrupted mid-pass, so this is the honest "we heard you, finishing this one
  // first" state instead of the button reading as hung until batch:done arrives.
  meetingsStopping: 'Stopping…',
  meetingsCancelled: 'Stopped — meetings still in the queue were left untouched.',
  modelNames: {
    'ggml-large-v3-turbo-q5_0.bin': 'Whisper large-v3-turbo (q5) — transcribes speech',
    'ggml-medium.bin': 'Whisper medium — transcribes speech',
    'ggml-large-v3.bin': 'Whisper large-v3 — transcribes speech',
    'ggml-silero-v5.1.2.bin': 'Silero VAD — keeps silence from sounding like speech',
    'pyannote-segmentation-3-0.onnx': 'pyannote — splits the audio by who is talking',
    'campplus-sv-zh_en.onnx': 'CAM++ — tells speakers apart',
  } as Record<string, string>,
  // The models banner used to live on the main page for exactly this reason — a first
  // run with no models yet — but onboarding now covers that, so a failure caused by a
  // still-missing model needs its own path back to where it can be fixed instead.
  modelMissingWarning: "Couldn't run — the selected model isn't downloaded yet.",
  modelsGoToSettings: 'Manage models in Settings',
  onbWelcomeTitle: 'Welcome to Meeting Inspector',
  onbWelcomeBody:
    'Everything this app does happens on this machine. Your audio never leaves it, and the app makes no outbound calls of its own — the only thing that reaches the internet is downloading a transcription model, once, when you choose to. A few quick questions and you will be ready to record.',
  onbLanguageTitle: 'Interface language',
  onbMeetingLangTitle: 'Meeting language',
  onbModelTitle: 'Transcription model',
  onbModelSkipHint: "You can download this later from Settings › Transcription — recording works without it, but nothing can be transcribed until it's downloaded.",
  onbPermissionsTitle: 'Permissions',
  onbPermissionsSkipHint: "You can grant these later — until you do, recording system audio or your microphone will fail, and this app's own warnings on the main screen will tell you which one and send you back to System Settings.",
  onbPermissionsGranted: 'Both permissions are already granted.',
  onbTranscribeModeTitle: 'When should meetings be transcribed?',
  onbFilesTitle: 'Where your meetings are kept',
  onbFilesBody:
    'Every recording and its transcript is written to a folder on this machine — one folder per meeting, holding the audio and the transcript as both JSON and Markdown. Nothing is stored anywhere else.',
  onbFilesOpen: 'Open folder',
  onbFilesManage:
    'Audio is by far the largest part of a meeting. Once one has been transcribed you can delete its audio from the meetings list and keep the transcript, or delete it outright — select the meetings, then Delete.',
  onbFinishTitle: "You're set up",
  onbFinishBody: 'Start a recording any time from the main screen. Everything here can be changed later from Settings.',
  onbBack: 'Back',
  onbNext: 'Continue',
  onbSkip: 'Skip for now',
  onbGetStarted: 'Get started',
  onbStepOf: (i: number, n: number) => `Step ${i} of ${n}`,
  updateLabel: (version: string) => `Version ${version}`,
  updateCheck: 'Check for updates',
  updateChecking: 'Checking…',
  updateUpToDate: 'This is the latest version.',
  updateAvailable: (version: string, mb: number) => `Version ${version} is available (${mb} MB).`,
  updateInstall: 'Download and install',
  updateDownloading: (pct: number) => `Downloading… ${pct}%`,
  updateInstalling: 'Installing — the app will restart on its own.',
  updateReadyTitle: (version: string) => `Version ${version} is downloaded.`,
  updateReadyDetail:
    'Installing it means replacing this app, so it has to close. Do it now and it reopens on the new version; leave it for later and it happens the next time you quit.',
  updateNow: 'Close and update now',
  updateOnQuit: 'Update when I quit',
  updateArmed: 'Ready — it will be installed the next time you quit the app.',
  updateCancel: 'Cancel',
  updateFailed: (msg: string) => `Could not update: ${msg}`,
  updateBusyHint: 'Recording or transcribing has to finish first — the update replaces the running app.',
  onboardingRerunLabel: 'First-run setup',
  onboardingRerun: 'Run setup again',
  // MEDIUM 2: onboarding has no way to stop a recording (Start/Stop, the meetings
  // batch queue, the elapsed timer, and the meters all live in #main-view, which
  // onboarding hides) — so the button that opens it is locked instead, the same way
  // the microphone test already locks during a batch.
  onboardingRerunLockedReason: 'Unavailable while a recording or meetings are in progress.',
  // LOW 7: shown if saving that onboarding finished fails (e.g. a read-only userData
  // volume) — without this, onboarding used to fail silently and reopen on every
  // launch forever with nothing explaining why.
  onboardingSaveFailed: (msg: string) => `Could not save that setup is done: ${msg} — you may see this screen again next launch.`,
  detailReveal: 'Show in Finder',
  playerPlay: 'Play the recording',
  playerPause: 'Pause',
  playLineHint: 'Click to hear this line',
  playerNoAudio: 'The recording for this meeting has been deleted — the transcript is all that is left.',
}

const th: typeof en = {
  start: 'เริ่มอัด',
  stop: 'จบประชุม',
  pause: 'หยุดพัก',
  resume: 'อัดต่อ',
  micMute: 'ปิดไมค์',
  micUnmute: 'เปิดไมค์',
  micMutedNote: 'ไมค์ปิดอยู่ — เสียงของคุณไม่ถูกบันทึก ส่วนเสียงคนอื่นยังบันทึกอยู่',
  pausedNote: 'พักอยู่ — ตั้งแต่ตอนนี้จนกดอัดต่อ จะไม่ถูกบันทึกลงไฟล์',
  miniOpen: 'กลับไปหน้าที่กำลังอัด',
  meterOthers: 'คนอื่น',
  meterUs: 'เรา',
  settingsSummary: 'ตั้งค่า',
  settingsBack: 'กลับ',
  catGeneral: 'ทั่วไป',
  catRecording: 'การอัดเสียง',
  catTranscription: 'การถอดเสียง',
  catSpeakers: 'ผู้พูด',
  catConnections: 'การเชื่อมต่อ',
  langRowLabel: 'ภาษาที่ใช้ในแอป',
  languageSaveFailed: (msg: string) => `เปลี่ยนภาษาไม่สำเร็จ: ${msg}`,
  mcpRowLabel: 'เซิร์ฟเวอร์ MCP',
  micTestRowLabel: 'ทดสอบไมโครโฟน',
  voicesHeading: (n: number) => `เสียงที่จำได้ (${n} คน)`,
  voicesEmpty: 'ยังไม่จำเสียงใคร — ตั้งชื่อคนพูดหลังประชุมสักครั้ง ครั้งหน้าจะเติมชื่อให้เอง',
  voicesForget: 'ลืมเสียงนี้',
  voicesSamples: (n) => `${n} ตัวอย่างเสียง`,
  voicesRenameHint: 'แก้ชื่อได้เลย หรือพิมพ์ชื่อที่มีอยู่แล้วในลิสต์เพื่อรวมเป็นคนเดียวกัน',
  voicesMergeTitle: (from, to) => `รวม "${from}" เข้ากับ "${to}"?`,
  voicesMergeDetail:
    'จะกลายเป็นคนเดียวกัน — เหลือแถวเดียวในลิสต์ ใช้ชื่อเดียวกันทุกที่ที่เคยใช้ไปแล้ว และเก็บตัวอย่างเสียงทั้งสองไว้ช่วยให้จำได้แม่นขึ้น ถ้าจะแยกกลับต้องเปลี่ยนชื่อคืนเอง',
  voicesMergeConfirm: 'รวม',
  pendingHeading: (n: number) => `เสียงใหม่รอตั้งชื่อ (${n} คน)`,
  pendingEmpty: 'ยังไม่มีเสียงใหม่รอตั้งชื่อ',
  pendingHeard: (title: string, when: string) => `ได้ยินครั้งแรกในการประชุม ${title} · ${when}`,
  pendingSaidLabel: 'พูดว่า: ',
  pendingNamePlaceholder: 'ตั้งชื่อเสียงนี้',
  pendingSave: 'บันทึก',
  pendingDiscard: 'ไม่ใช่คนพูด',
  pendingDiscardHint: 'ทิ้งลายเสียงนี้ทิ้ง — เป็นเสียงสภาพแวดล้อมหรือเสียงที่โมเดลคิดขึ้นมาเอง ไม่ใช่คนที่ต้องตั้งชื่อ',
  pendingPlay: 'ฟังตัวอย่างเสียง',
  pendingPlaying: 'กำลังเล่น…',
  pendingNoSample: 'ไม่มีตัวอย่างเสียง',
  micTest: 'ทดสอบไมค์',
  micTestStop: 'หยุด',
  micTestPrompt: 'อ่านประโยคนี้ออกเสียง',
  micTestExpected: 'ประโยคที่ให้อ่าน',
  micTestGot: 'ถอดได้ว่า',
  micTestTerms: (found: string[], missed: string[]) =>
    missed.length === 0
      ? `ศัพท์เทคนิคมาครบ: ${found.join(', ')}`
      : `หายไป: ${missed.join(', ')}${found.length > 0 ? ` · ได้: ${found.join(', ')}` : ''}`,
  micTestSpeech: 'ได้ยินเป็นเสียงพูด',
  micTestDropped: 'กำลังทิ้งเสียงนี้',
  micTestNothing: 'ไม่มีอะไรรอดผ่านตัวกรอง',
  micTestFailed: (msg) => `ทดสอบไมค์ไม่ได้: ${msg}`,
  micTestLockedReason: 'ใช้ไม่ได้ตอนนี้ — กำลังถอดเสียงการประชุมอยู่เบื้องหลัง',
  micVerdictQuiet: 'ไมค์แทบไม่ได้ยินอะไรเลย อันนี้ไม่ใช่เรื่องระดับกรอง ลองเช็คว่าเลือกไมค์ถูกตัวไหม หรือพูดใกล้ขึ้น',
  micLevelNow: (pct: number) => `ระดับเสียงเข้า ${pct}%`,
  micTooQuiet: 'เสียงเข้าเบามาก — เช็คว่าเลือกไมค์ถูกตัวไหมใน System Settings › Sound หรือขยับเข้าใกล้ไมค์',
  micListening: 'กำลังฟัง…',
  micVerdictTooStrict: (pct: number) =>
    `เสียงคุณถูกนับเป็นเสียงพูดแค่ ${pct}% ของเวลา และไม่มีอะไรถึง transcript เลย ระดับนี้เข้มเกินไปสำหรับห้องนี้`,
  micVerdictPatchy: (pct: number) =>
    `เสียงคุณถูกนับเป็นเสียงพูด ${pct}% ของเวลา ติดๆ หลุดๆ แบบนี้ประชุมจริงจะขาดหายเป็นช่วงๆ`,
  micVerdictGood: (pct: number) =>
    `เสียงคุณถูกนับเป็นเสียงพูด ${pct}% ของเวลา และถอดออกมาได้ ระดับนี้เหมาะกับห้องนี้`,
  micVerdictTryStricter: 'ถ้ายังมีบรรทัดโผล่ตอนไม่มีใครพูด ลองเพิ่มอีกขั้นแล้วทดสอบใหม่',
  micLower: 'ลดลงหนึ่งขั้น',
  micRaise: 'เพิ่มขึ้นหนึ่งขั้น',
  portLabel: 'MCP port',
  portSave: 'ใช้ค่านี้',
  portInvalid: 'เลือก port ระหว่าง 1024 ถึง 65535',
  portTakenUsingDefault: (wanted: number, actual: number) =>
    `port ${wanted} มีแอปอื่นใช้อยู่ ระบบจึงเปิดที่ ${actual} แทน — เลือก port ที่ว่าง หรือชี้ client มาที่ ${actual}`,
  portTakenUsingAny: (wanted: number, actual: number) =>
    `port ${wanted} ไม่ว่าง และ port เริ่มต้นก็ไม่ว่าง ระบบจึงใช้ ${actual} — ควรเลือก port ที่ว่าง เพราะเลขนี้จะเปลี่ยนทุกครั้งที่เปิดแอป`,
  portTakenUsingAnyIsDefault: (wanted: number, actual: number) =>
    `port ${wanted} มีแอปอื่นใช้อยู่ ระบบจึงใช้ ${actual} แทน — ควรเลือก port ที่ว่าง เพราะเลขนี้จะเปลี่ยนทุกครั้งที่เปิดแอป`,
  transcribeModeLabel: 'ถอดเสียง',
  transcribeModeAfter: 'หลังจบประชุม',
  transcribeModeLive: 'สด ระหว่างประชุม',
  transcribeModeManual: 'เลือกเองว่าประชุมไหนจะถอด',
  transcribeModeHint: {
    after: 'ค่าเริ่มต้น ระหว่างอัดจะยังไม่ถอดเสียงอะไรเลย พอจบประชุมค่อยถอดทั้งหมดในรอบเดียว ทำให้ใช้แรมน้อยระหว่างอัด',
    live: 'ข้อความจะขึ้นระหว่างที่คนพูด แต่โมเดล 3GB จะค้างอยู่ในแรมตลอดการประชุม',
    manual: 'จะไม่ถอดเสียงให้อัตโนมัติเลย ทั้งระหว่างอัดและหลังจบ — เลือกเองจากรายการประชุมด้านล่างว่าจะถอดตัวไหน เมื่อไหร่ก็ได้ ทีละตัวหรือหลายตัวพร้อมกัน',
  } as Record<string, string>,
  transcribeAfterPlaceholder: 'transcript จะขึ้นตอนจบประชุม',
  transcribeManualPlaceholder: 'ประชุมนี้จะไม่ถอดเสียงให้อัตโนมัติ — เลือกจากรายการประชุมด้านล่างเมื่อพร้อม',
  transcribing: (pct) => `กำลังถอดเสียง… ${pct}%`,
  asrModelLabel: 'โมเดลถอดเสียง',
  asrModelName: { turbo: 'Turbo (เบา)', medium: 'Medium', large: 'Large (แม่นยำ)' } as Record<AsrModel, string>,
  asrModelDetail: {
    turbo:
      'เบาที่สุด เร็วที่สุด ใช้แรมระหว่างถอดเสียง 0.78GB ถอดเสียง 30 นาทีใช้เวลาประมาณ 2 นาที จับศัพท์เทคนิคได้น้อยสุดในสามตัว (ทดสอบได้ 22 จาก 27 คำ)',
    medium:
      'ใช้แรม 1.96GB อยู่กลางๆ ระหว่างอีกสองตัว แต่ช้าที่สุดในสามตัว — ถอดเสียง 30 นาทีใช้เวลาประมาณ 8 นาที จับศัพท์เทคนิคได้ดีกว่า Turbo (25 จาก 27 คำ) โดยไม่ต้องใช้แรมเท่า Large คุ้มก็ต่อเมื่ออยากได้ความแม่นยำศัพท์เทคนิคที่ดีกว่าจริงๆ',
    large:
      'แม่นยำที่สุด จับศัพท์เทคนิคได้ดีที่สุด (26 จาก 27 คำ) error rate ต่ำสุด แต่ก็ใช้แรมมากที่สุด — 3.43GB ระหว่างถอดเสียง ถอดเสียง 30 นาทีใช้เวลาประมาณ 6 นาที',
  } as Record<AsrModel, string>,
  asrModelDownloaded: 'มีอยู่ในเครื่องแล้ว',
  asrModelPartial: (progress) => `โหลดค้างไว้ (${progress}) — จะโหลดต่อจากเดิม`,
  asrModelNeedsDownload: (size) => `ยังไม่ได้โหลด — ${size}`,
  asrModelTimingNote: 'เวลาที่บอกเป็นค่าประมาณ วัดจาก Mac Apple Silicon เครื่องจริงอาจต่างไปบ้าง',
  meetingLangLabel: 'ภาษาที่ใช้ในที่ประชุม',
  meetingLangName: { th: 'ไทย', en: 'อังกฤษ' } as Record<MeetingLanguage, string>,
  echoLabel: 'ตัดเสียงลำโพงที่เข้าไมค์',
  echoHint:
    'ถ้าเปิดลำโพงแทนหูฟัง ไมค์จะได้ยินเสียงประชุมไปด้วย ทำให้ประโยคของอีกฝั่งถูกถอดสองครั้ง — ครั้งหนึ่งในชื่อเขา อีกครั้งช้ากว่านิดหน่อยในชื่อ "เรา" ตัวนี้จะตัดอันหลังทิ้ง ถ้าใช้หูฟังให้ปิดไว้ เพราะไม่มีเสียงสะท้อนให้ตัด มีแต่จะเผลอตัดประโยคที่คนพูดซ้ำจริงๆ',
  remoteLabel: 'ถอดเสียงด้วยโมเดลภายนอก (OpenRouter)',
  remoteLead:
    'สำหรับเครื่องที่แรมไม่พอจะรัน Whisper (0.8–3.4GB) บวกอีกราว 1GB ตอนแยกว่าใครพูด เปิดแล้วเสียงประชุมจะถูกส่งออกนอกเครื่อง — อ่านรายละเอียดก่อนเปิด',
  remoteOnHint: 'ใช้กับไฟล์ที่อัดไว้แล้วเท่านั้น การถอดสดยังรันในเครื่องเสมอ',
  remoteWarning:
    'เสียงประชุมของคุณจะออกจากเครื่องนี้ ทั้งสองแทร็ก — ทั้งเสียงอีกฝั่งและเสียงจากไมค์ของคุณ — จะถูกส่งเป็นท่อนละ ~30 วินาทีไปที่ openrouter.ai แล้วส่งต่อไปยังโมเดลที่คุณเลือกและผู้ให้บริการของโมเดลนั้น เขาจะเก็บอะไรไว้นานแค่ไหนเป็นนโยบายของเขา ไม่ใช่ของแอปนี้ และค่าใช้จ่ายคิดจากคีย์ของคุณเอง นอกจากเสียงแล้วไม่มีอะไรถูกส่งไป ไม่มี transcript ไม่มีชื่อคน ไม่มีไฟล์ ส่วนการอัด การเก็บไฟล์ การจำเสียงคนพูด และ MCP ยังอยู่ในเครื่องนี้ทั้งหมดไม่ว่าจะเลือกแบบไหน',
  remoteKeyPlaceholder: 'OpenRouter API key (sk-or-…)',
  remoteConnect: 'เชื่อมต่อ',
  remoteConnecting: 'กำลังตรวจสอบคีย์…',
  remoteForget: 'ลบคีย์และกลับไปถอดในเครื่อง',
  remoteNoKey: 'ต้องใช้คีย์ของคุณเอง สร้างได้ที่ openrouter.ai/keys',
  remoteConnected: (models) => `คีย์ใช้ได้ — มี ${models} โมเดลที่รับเสียงเข้า`,
  remoteCredit: (usd) => ` เหลือเครดิต ${usd.toFixed(2)} USD`,
  remoteFreeTier: ' เป็นคีย์แบบฟรี ประชุมยาวๆ อาจติดลิมิตระหว่างทาง',
  remoteFailed: (msg) => `ใช้คีย์นี้ไม่ได้: ${msg}`,
  remoteModelLabel: 'โมเดล',
  remoteModelAdvice:
    'ค่าเริ่มต้นคือ Gemini 2.5 Flash Lite ซึ่งจากที่ทดสอบเขียนภาษาไทยได้ถูกที่สุดในกลุ่มที่ราคาถูก — บางโมเดลที่ใหญ่กว่าใส่เว้นวรรคระหว่างทุกพยางค์ไทย ถ้าจะเปลี่ยนโมเดล ลองกับประชุมสั้นๆ ก่อนใช้กับไฟล์ยาว',
  remoteModelPrice: (usdPerHour, usdPerMillion) =>
    `ประมาณ $${usdPerHour.toFixed(2)} ต่อการประชุม 1 ชั่วโมง ($${usdPerMillion.toFixed(2)} ต่อ 1 ล้าน audio token คิดที่ 32 token/วินาที) ช่วงเงียบไม่ถูกส่งไป ประชุมที่เงียบมากจะถูกกว่าความยาวจริง`,
  remoteModelFree: 'ตอนนี้ฟรี — โมเดลฟรีมีลิมิตการเรียกและถูกถอดออกเมื่อไหร่ก็ได้',
  remoteModelUnpriced: 'โมเดลนี้ไม่ได้คิดราคาเสียงแยก เลยประมาณราคาต่อชั่วโมงให้ไม่ได้ — เช็คที่ openrouter.ai ก่อนถ้าจะถอดไฟล์ยาวๆ',
  remoteConfirmTitle: 'ส่งเสียงประชุมไปที่ OpenRouter?',
  remoteConfirmDetail:
    'ต่อจากนี้ การถอดไฟล์ที่อัดไว้จะส่งเสียงออกจากเครื่องนี้ไปที่ openrouter.ai แล้วต่อไปยังโมเดลที่คุณเลือก ส่วนการถอดสด การเก็บไฟล์ การจำเสียงคนพูด และ MCP ยังอยู่ในเครื่องนี้ สลับกลับเมื่อไหร่ก็ได้',
  remoteConfirmYes: 'ส่งเลย',
  speakerSplitLabel: 'การแยกคนพูด',
  speakerSplitName: {
    fine: 'ละเอียด — ต่างกันนิดเดียวก็นับเป็นคนใหม่',
    balanced: 'สมดุล',
    coarse: 'หยาบ — นับเป็นคนเดียวกันบ่อยขึ้น',
  } as Record<SpeakerSplit, string>,
  speakerSplitHint: {
    fine: 'คนสองคนที่เสียงคล้ายกันจะยังถูกแยกไว้ แต่คนคนเดียวที่ดังไม่เท่ากันตลอด — ผ่านแอปประชุม หรือขยับห่างไมค์ — อาจกลายเป็นหลายคน',
    balanced: 'ค่าเริ่มต้น ใช้ได้กับการประชุมผ่านสายส่วนใหญ่',
    coarse: 'ใช้เมื่อ transcript ออกมามีคนพูดเยอะกว่าคนในห้องจริงมาก แลกกับว่าคนที่เสียงคล้ายกันจริงๆ อาจถูกนับเป็นคนเดียวกัน',
  } as Record<SpeakerSplit, string>,
  speakerSplitApplies: 'มีผลกับการแยกคนพูดครั้งถัดไป — ถอดเสียงการประชุมเดิมซ้ำเพื่อให้ใช้ค่านี้',
  meetingLangHint:
    'ภาษาที่คนพูดในที่ประชุม — ไม่ใช่ภาษาของหน้าจอด้านบน เลือกผิดมีต้นทุนจริง: จากการทดสอบ ประชุมภาษาอังกฤษที่ถอดเป็นไทยผิดพลาด 9.0% ของตัวอักษร และจับศัพท์เทคนิคพลาดไปหนึ่งคำ (ได้ 17/18) แต่ถอดเป็นอังกฤษผิดพลาดแค่ 0.6% จับศัพท์ได้ครบ (18/18) ส่วนประชุมภาษาไทยที่ถอดเป็นอังกฤษผิดพลาด 34.0% (จับศัพท์ได้ 21/27) แต่ถอดเป็นไทยผิดพลาด 15.7% (จับศัพท์ได้ 22/27)',
  noiseLabel: 'กรองเสียงรบกวน',
  noiseLow: 'เก็บทุกอย่าง',
  noiseMedium: 'สมดุล',
  noiseHigh: 'เอาแต่เสียงพูด',
  noiseHint: {
    low: 'เสียงห้องเปล่ายังถูกกรองอยู่ แต่คนคุยแผ่วๆ ในห้องที่มีเสียงรบกวนจะถูกเก็บไว้ — แลกกับบางบรรทัดที่ห้องสร้างขึ้นเอง ไม่ใช่คนพูด',
    medium: 'ค่าเริ่มต้น กรองเสียงห้องออก แต่ยังถอดเสียงคนที่พูดเบาหรืออยู่ไกลไมค์',
    high: 'ตัดเสียงพูดที่แผ่วมากในห้องที่มีเสียงรบกวนออกด้วย ใช้เมื่อมีบรรทัดโผล่ทั้งที่ไม่มีใครพูด',
  } as Record<string, string>,
  noiseLockedHint: 'ล็อกไว้ระหว่างกำลังถอดเสียงอยู่ — ตัวกรองนี้มีผลกับท่อนที่กำลังประมวลผลอยู่ รอให้เสร็จก่อนแล้วค่อยเปลี่ยน',
  mcpLabel: 'เปิด MCP server ให้ AI ในเครื่องดึง transcript ไปสรุป',
  mcpUrlLabel: 'URL',
  mcpTokenLabel: 'Bearer token',
  mcpTokenReveal: 'แสดง',
  mcpTokenHide: 'ซ่อน',
  mcpConnectTitle: 'เชื่อมต่อแอป',
  mcpConnectOff: 'เปิดเซิร์ฟเวอร์ด้านบนก่อน เพื่อดูรายละเอียดการเชื่อมต่อสำหรับแอปของคุณ',
  mcpConnectAppLabel: 'เลือกแอปของคุณ แล้วคัดลอกสิ่งที่ต้องใช้',
  mcpConnectStepsCode: 'รันคำสั่งนี้ในเทอร์มินัล:',
  mcpConnectStepsDesktop: 'เพิ่มข้อความนี้ในไฟล์ตั้งค่า MCP ของแอป:',
  permWhy: {
    screen: 'ต้องมีเพื่ออัดเสียงระบบ (เสียงคนอื่นในที่ประชุม)',
    microphone: 'ต้องมีเพื่ออัดเสียงเรา',
  },
  permName: { screen: 'การบันทึกหน้าจอ', microphone: 'ไมโครโฟน' } as Record<'screen' | 'microphone', string>,
  permNeverAsked: (name, why) => `ยังไม่เคยขอสิทธิ์ ${name} — ${why}`,
  permDenied: (name, why) => `ไม่ได้สิทธิ์ ${name} — ${why}`,
  permGrant: (name) => `ขอสิทธิ์ ${name}`,
  permOpenSettings: 'เปิด System Settings',
  trackLost: (track) => `${track} track หยุดกลางคัน — กดหยุดแล้วเริ่มใหม่`,
  startFailed: (msg) => `เริ่มอัดไม่ได้: ${msg}`,
  transcribingRest: 'กำลังถอดเสียงส่วนที่เหลือ…',
  saved: (dur, segments) => `บันทึกแล้ว ${dur} · ${segments} ท่อน — `,
  queueBacklog: (depth) => `ถอดเสียงตามไม่ทัน — ค้างอยู่ ${depth} ท่อน`,
  whisperError: (msg) => `whisper-server ไม่ขึ้น: ${msg}`,
  diarizing: 'กำลังแยกว่าใครพูด…',
  diarizeError: (msg) => `แยกคนพูดไม่สำเร็จ: ${msg} (transcript ยังอยู่ครบ)`,
  modelsMissing: (count, size) => `ยังไม่มีโมเดล ${count} ไฟล์ (${size}) — อัดเสียงได้ แต่ยังถอดเสียงไม่ได้`,
  modelsResumable: (size) => ` · โหลดค้างไว้ ${size} จะโหลดต่อจากเดิม`,
  downloadModels: 'โหลดโมเดล',
  cancel: 'ยกเลิก',
  downloading: 'กำลังโหลด…',
  downloadCancelled: 'ยกเลิกแล้ว — ครั้งหน้าจะโหลดต่อจากเดิม',
  downloadComplete: 'โหลดครบแล้ว',
  speakerSave: 'บันทึกชื่อ',
  speakerSaved: 'บันทึกแล้ว',
  speakerMergeHint: 'ถ้าแยกคนพูดผิด ตั้งชื่อเดียวกันให้สองคน = รวมเป็นคนเดียว',
  speakerScopeHint: 'ผู้พูดที่มี 🔊 คือเสียงที่แอปนี้จำได้แล้ว — เปลี่ยนชื่อจะอัปเดตทุกการประชุม ส่วนคนอื่นจะเปลี่ยนแค่ในการประชุมนี้',
  voiceRecognisedTag: 'จำได้แล้ว',
  speakerParts: (n) => `${n} ช่วง`,
  speakerHear: 'ฟังเสียง',
  speakerHearHint: 'เล่นประโยคที่ยาวที่สุดของคนนี้ จะได้รู้ว่าเป็นใครก่อนตั้งชื่อ',
  speakerWrongVoice: 'ไม่ใช่คนนี้',
  speakerWrongVoiceHint: 'คนพูดคนนี้ถูกจับคู่กับเสียงที่แอปจำไว้ — ถ้าจับคู่ผิดคน กดตรงนี้',
  speakerWrongTitle: (name) => `นี่ไม่ใช่${name}ใช่ไหม?`,
  speakerWrongDetail:
    'จะตัดการเชื่อมระหว่างคนพูดคนนี้กับเสียงที่จำไว้ และลืมชื่อเฉพาะในการประชุมนี้ ตัวเสียงยังอยู่ เพราะในประชุมอื่นที่จับคู่ถูกก็ยังถูกอยู่ ลบทิ้งจะพังตามไปด้วย จากนั้นพิมพ์ว่าจริงๆ แล้วเป็นใคร — ถ้าใช้ชื่อที่มีอยู่แล้วจะรวมเป็นคนเดียวกัน ถ้าเป็นชื่อใหม่ก็เริ่มเป็นเสียงใหม่',
  speakerWrongYes: 'จับคู่ผิด — ตัดการเชื่อม',
  speakerJump: 'ไปที่คนพูดคนนี้ด้านบน',
  copy: 'คัดลอก',
  copied: 'คัดลอกแล้ว',
  speakerDefaults: { me: 'คุณ', them: 'คนอื่น' },
  unnamedSpeaker: (n) => `ผู้พูด ${n}`,
  meetingsHeading: 'การประชุม',
  meetingsEmpty: 'ยังไม่มีการประชุมที่บันทึกไว้',
  meetingsStatus: {
    'not-transcribed': 'ยังไม่ถอดเสียง',
    transcribing: 'กำลังถอดเสียง…',
    done: 'ถอดเสร็จแล้ว',
    failed: 'ถอดไม่สำเร็จ — ลองใหม่',
  } as Record<TranscribeStatus, string>,
  meetingsSelectAll: 'เลือกทั้งหมด',
  meetingsSelectNone: 'ล้างที่เลือก',
  meetingsTranscribe: (n) => (n === 0 ? 'ถอดเสียง' : `ถอดเสียง ${n} การประชุม`),
  meetingsStop: 'หยุด',
  meetingsDelete: (n) => (n === 0 ? 'ลบ' : `ลบ ${n} รายการ`),
  deleteUndoneTitle: (n) => `ลบเสียงของ ${n} การประชุมที่ยังไม่ได้ถอด?`,
  deleteUndoneDetail: 'การประชุมพวกนี้มีแค่ไฟล์เสียง ยังไม่ได้ถอดเป็นข้อความเลย ลบแล้วกู้คืนไม่ได้ และจะไม่เหลืออะไรให้ถอดทีหลัง',
  deleteUndoneConfirmTitle: 'ลบจริงๆ ใช่ไหม? เสียงนี้ยังไม่ได้ถอด',
  deleteUndoneConfirmDetail: 'ยืนยันครั้งสุดท้าย — ไฟล์เสียงจะหายถาวร และไม่มี transcript เก็บไว้ที่ไหนอีก',
  deleteDoneTitle: (n) => `${n} การประชุมถอดเสียงไปแล้ว — ไฟล์ถอดเสียงยังอยู่นะ`,
  deleteDoneDetail: 'ลบเฉพาะเสียงจะคืนพื้นที่ได้เกือบทั้งหมด และยังอ่าน transcript ได้อยู่ จะลบ transcript ด้วยไหม?',
  deleteAudioOnly: 'ลบเฉพาะเสียง',
  deleteEverything: 'ลบทั้งหมด',
  deleteConfirm: 'ลบ',
  deleteCancel: 'ยกเลิก',
  deleteFailed: (msg) => `ลบไม่สำเร็จ: ${msg}`,
  renameFailed: (msg) => `เปลี่ยนชื่อไม่สำเร็จ: ${msg}`,
  meetingRenameHint: 'ดับเบิลคลิกที่ชื่อการประชุมเพื่อเปลี่ยนชื่อ',
  meetingsProgress: (title, index, total, pct) => `กำลังถอดเสียง ${title} (${index}/${total}) — ${pct}%`,
  viewAllMeetings: (n) => `ดูทั้งหมด ${n} การประชุม`,
  allMeetingsTitle: 'การประชุมทั้งหมด',
  meetingsRetranscribeWarning: (n) =>
    `ถอดเสียงซ้ำ ${n} การประชุมที่ถอดเสร็จแล้วจะแทนที่ transcript เดิม ชื่อผู้พูดที่เคยตั้งไว้จะกลับมาเองก็ต่อเมื่อแอปจำเสียงคนนั้นได้แล้ว (ตั้งค่า › ผู้พูด) — ถ้าไม่ ต้องตั้งชื่อใหม่อีกครั้ง`,
  meetingsDiarizing: (title, index, total) => `กำลังแยกว่าใครพูดใน ${title} (${index}/${total})…`,
  meetingsStopping: 'กำลังหยุด…',
  meetingsCancelled: 'หยุดแล้ว — ประชุมที่ยังค้างในคิวจะยังไม่ถูกแตะต้อง',
  modelNames: {
    'ggml-large-v3-turbo-q5_0.bin': 'Whisper large-v3-turbo (q5) — ถอดเสียง',
    'ggml-medium.bin': 'Whisper medium — ถอดเสียง',
    'ggml-large-v3.bin': 'Whisper large-v3 — ถอดเสียง',
    'ggml-silero-v5.1.2.bin': 'Silero VAD — กันหลอนตอนเงียบ',
    'pyannote-segmentation-3-0.onnx': 'pyannote — แบ่งช่วงคนพูด',
    'campplus-sv-zh_en.onnx': 'CAM++ — จำแนกว่าใครเป็นใคร',
  } as Record<string, string>,
  modelMissingWarning: 'ทำไม่ได้ — ยังไม่ได้โหลดโมเดลที่เลือกไว้',
  modelsGoToSettings: 'จัดการโมเดลในหน้าตั้งค่า',
  onbWelcomeTitle: 'ยินดีต้อนรับสู่ Meeting Inspector',
  onbWelcomeBody:
    'ทุกอย่างที่แอปนี้ทำเกิดขึ้นบนเครื่องนี้เครื่องเดียว เสียงของคุณไม่ถูกส่งออกไปไหน และแอปไม่มีการเชื่อมต่อออกอินเทอร์เน็ตเองเลย ยกเว้นตอนโหลดโมเดลถอดเสียง ซึ่งจะเกิดขึ้นแค่ตอนที่คุณเลือกโหลดเท่านั้น ตอบคำถามสั้นๆ ไม่กี่ข้อ แล้วก็เริ่มอัดเสียงได้เลย',
  onbLanguageTitle: 'ภาษาที่ใช้ในแอป',
  onbMeetingLangTitle: 'ภาษาที่ใช้ในที่ประชุม',
  onbModelTitle: 'โมเดลถอดเสียง',
  onbModelSkipHint: 'โหลดทีหลังได้จากหน้าตั้งค่า › การถอดเสียง — อัดเสียงได้ตามปกติแม้ยังไม่โหลด แต่จะถอดเสียงไม่ได้จนกว่าจะโหลดเสร็จ',
  onbPermissionsTitle: 'สิทธิ์การเข้าถึง',
  onbPermissionsSkipHint: 'ขอสิทธิ์ทีหลังได้ — แต่ถ้ายังไม่ได้ให้ การอัดเสียงระบบหรือไมโครโฟนจะไม่สำเร็จ และแอปจะแจ้งเตือนที่หน้าแรกพร้อมพาไปที่ System Settings ให้เอง',
  onbPermissionsGranted: 'ได้สิทธิ์ทั้งสองอย่างแล้ว',
  onbTranscribeModeTitle: 'ให้ถอดเสียงตอนไหน',
  onbFilesTitle: 'ไฟล์การประชุมเก็บอยู่ที่ไหน',
  onbFilesBody:
    'ทุกการอัดเสียงและ transcript ถูกเขียนลงโฟลเดอร์บนเครื่องนี้ — หนึ่งโฟลเดอร์ต่อหนึ่งการประชุม ข้างในมีไฟล์เสียงและ transcript ทั้งแบบ JSON และ Markdown ไม่มีอะไรถูกเก็บไว้ที่อื่น',
  onbFilesOpen: 'เปิดโฟลเดอร์',
  onbFilesManage:
    'ไฟล์เสียงกินพื้นที่มากที่สุดในหนึ่งการประชุม พอถอดเสียงเสร็จแล้ว ลบเฉพาะเสียงและเก็บ transcript ไว้ก็ได้ หรือจะลบทั้งหมดก็ได้ — เลือกการประชุมในลิสต์แล้วกดลบ',
  onbFinishTitle: 'ตั้งค่าเสร็จแล้ว',
  onbFinishBody: 'เริ่มอัดเสียงได้ทุกเมื่อจากหน้าแรก ทุกอย่างที่ตั้งไว้ตรงนี้เปลี่ยนทีหลังได้จากหน้าตั้งค่า',
  onbBack: 'กลับ',
  onbNext: 'ถัดไป',
  onbSkip: 'ข้ามไปก่อน',
  onbGetStarted: 'เริ่มใช้งาน',
  onbStepOf: (i, n) => `ขั้นตอน ${i} จาก ${n}`,
  updateLabel: (version) => `เวอร์ชัน ${version}`,
  updateCheck: 'เช็คอัปเดต',
  updateChecking: 'กำลังเช็ค…',
  updateUpToDate: 'เป็นเวอร์ชันล่าสุดแล้ว',
  updateAvailable: (version, mb) => `มีเวอร์ชัน ${version} ให้อัปเดต (${mb} MB)`,
  updateInstall: 'ดาวน์โหลดและติดตั้ง',
  updateDownloading: (pct) => `กำลังดาวน์โหลด… ${pct}%`,
  updateInstalling: 'กำลังติดตั้ง — แอปจะรีสตาร์ทเอง',
  updateReadyTitle: (version) => `ดาวน์โหลดเวอร์ชัน ${version} เสร็จแล้ว`,
  updateReadyDetail:
    'การติดตั้งคือการแทนที่ตัวแอปนี้ จึงต้องปิดแอปก่อน ถ้าทำตอนนี้แอปจะเปิดกลับมาเป็นเวอร์ชันใหม่ให้เอง หรือจะพักไว้ก็ได้ แล้วค่อยติดตั้งตอนปิดแอปครั้งถัดไป',
  updateNow: 'ปิดและอัปเดตตอนนี้',
  updateOnQuit: 'อัปเดตตอนปิดแอป',
  updateArmed: 'พร้อมแล้ว — จะติดตั้งให้ตอนปิดแอปครั้งถัดไป',
  updateCancel: 'ยกเลิก',
  updateFailed: (msg) => `อัปเดตไม่สำเร็จ: ${msg}`,
  updateBusyHint: 'ต้องให้การอัดหรือถอดเสียงเสร็จก่อน เพราะการอัปเดตจะแทนที่ตัวแอปที่กำลังรันอยู่',
  onboardingRerunLabel: 'ตั้งค่าเริ่มต้นใช้งาน',
  onboardingRerun: 'ทำใหม่อีกครั้ง',
  onboardingRerunLockedReason: 'ใช้ไม่ได้ตอนนี้ — กำลังอัดเสียงหรือถอดเสียงการประชุมอยู่',
  onboardingSaveFailed: (msg) => `บันทึกสถานะตั้งค่าเสร็จไม่สำเร็จ: ${msg} — ครั้งหน้าอาจเจอหน้านี้อีก`,
  detailReveal: 'แสดงใน Finder',
  playerPlay: 'เล่นบันทึกการประชุม',
  playerPause: 'หยุดชั่วคราว',
  playLineHint: 'คลิกเพื่อฟังประโยคนี้',
  playerNoAudio: 'ไฟล์เสียงของการประชุมนี้ถูกลบไปแล้ว เหลือแต่ transcript',
}

const STR: Record<Language, typeof en> = { en, th }

let lang: Language = 'en'
const t = () => STR[lang]

/** Electron prefixes every rejected invoke with its own plumbing; users do not need it. */
const reason = (err: unknown) =>
  (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': \w*Error: /, '')

const title = $<HTMLInputElement>('title')
const toggle = $<HTMLButtonElement>('toggle')
const elapsed = $('elapsed')
const warnings = $('warnings')
const done = $('done')
const queue = $('queue')
const speakerPanel = $('speakers')
const transcript = $('transcript')
const modelsEl = $('models')
const mcpToggle = $<HTMLInputElement>('mcp')
const mcpStateEl = $('mcpstate')
const mcpConnectTitleEl = $('mcp-connect-title')
const mcpConnectOffEl = $('mcp-connect-off')
const mcpConnectEl = $('mcpconnect')
const meters: Record<Track, HTMLElement> = { loopback: $('m-loopback'), mic: $('m-mic') }
const meterLabels: Record<Track, HTMLElement> = { loopback: $('meter-others-label'), mic: $('meter-us-label') }
const voicesEl = $('voices')
const pendingVoicesEl = $('pending-voices')
const portInput = $<HTMLInputElement>('port')
const portSave = $<HTMLButtonElement>('port-save')
const portLabel = $('port-label')
const noiseSelect = $<HTMLSelectElement>('noise')
const noiseLabel = $('noise-label')
const noiseHint = $('noisehint')
const transcribeModeRadios: Record<TranscribeMode, HTMLInputElement> = {
  after: $<HTMLInputElement>('transcribe-mode-after'),
  live: $<HTMLInputElement>('transcribe-mode-live'),
  manual: $<HTMLInputElement>('transcribe-mode-manual'),
}
const transcribeModeNames: Record<TranscribeMode, HTMLElement> = {
  after: $('transcribe-mode-after-name'),
  live: $('transcribe-mode-live-name'),
  manual: $('transcribe-mode-manual-name'),
}
const transcribeModeLabelEl = $('transcribe-mode-label')
const transcribeModeHint = $('transcribe-mode-hint')

/** A three-way choice, not a toggle: selectable rows with a checkmark, same
 * pattern as the ASR model picker below. These three helpers stand in for the
 * `.value`/`.disabled`/`.options` a `<select>` used to give for free. */
const getTranscribeMode = (): TranscribeMode =>
  (Object.entries(transcribeModeRadios).find(([, r]) => r.checked)?.[0] as TranscribeMode | undefined) ?? 'after'
const setTranscribeModeValue = (v: TranscribeMode): void => {
  for (const [key, r] of Object.entries(transcribeModeRadios)) r.checked = key === v
}
const setTranscribeModeDisabled = (disabled: boolean): void => {
  for (const r of Object.values(transcribeModeRadios)) r.disabled = disabled
}
const asrModelLabelEl = $('asr-model-label')
const asrModelEl = $('asr-model')
const asrModelNoteEl = $('asr-model-note')
const meetingLangSelect = $<HTMLSelectElement>('meeting-lang')
const meetingLangLabelEl = $('meeting-lang-label')
const meetingLangHintEl = $('meeting-lang-hint')
const echoLabelEl = $('echo-label')
const echoToggle = $<HTMLInputElement>('echo-filter')
const echoHintEl = $('echo-hint')
const remoteLabelEl = $('remote-label')
const remoteToggle = $<HTMLInputElement>('remote-toggle')
const remoteLeadEl = $('remote-lead')
const remoteOpenEl = $('remote-open')
const remoteConnectedEl = $('remote-connected')
const remoteWarningEl = $('remote-warning')
const remoteKeyInput = $<HTMLInputElement>('remote-key')
const remoteConnectBtn = $<HTMLButtonElement>('remote-connect')
const remoteForgetBtn = $<HTMLButtonElement>('remote-forget')
const remoteStateEl = $('remote-state')
const remoteModelLabelEl = $('remote-model-label')
const remoteModelSelect = $<HTMLSelectElement>('remote-model')
const remotePriceEl = $('remote-price')

const speakerSplitLabelEl = $('speaker-split-label')
const speakerSplitSelect = $<HTMLSelectElement>('speaker-split')
const speakerSplitHintEl = $('speaker-split-hint')
const micToggle = $<HTMLButtonElement>('mictest-toggle')
const micTestLockHint = $('mictest-lock-hint')
const micTestRowLabel = $('mictest-row-label')
const micLevel = $('mictest-level')
const micVerdictEl = $('mictest-verdict')
const micLine = $('mictest-line')
const micHeard = $('mictest-heard')
const mcpLabel = $('mcp-label')
const mcpRowLabel = $('mcp-row-label')
const langRowLabel = $('lang-row-label')
const meetingsHeadingEl = $('meetings-heading')
const meetingsListEl = $('meetings-list')
const meetingsSelectAllBtn = $<HTMLButtonElement>('meetings-select-all')
const meetingsSelectNoneBtn = $<HTMLButtonElement>('meetings-select-none')
const meetingsTranscribeBtn = $<HTMLButtonElement>('meetings-transcribe')
const meetingsDeleteBtn = $<HTMLButtonElement>('meetings-delete')
const meetingsStopBtn = $<HTMLButtonElement>('meetings-stop')
const meetingsProgressEl = $('meetings-progress')
const meetingsRetranscribeHintEl = $('meetings-retranscribe-hint')
const meetingsViewAllBtn = $<HTMLButtonElement>('meetings-view-all')

/** A whole separate top-level page (spec item b) for every recording, not just the main
 * page's 5-most-recent preview — see `showPage`. */
const allMeetingsPage = $('all-meetings-page')
const allMeetingsBackBtn = $<HTMLButtonElement>('all-meetings-back')
const allMeetingsBackLabel = $('all-meetings-back-label')
const allMeetingsTitleEl = $('all-meetings-title')
const allMeetingsListEl = $('all-meetings-list')
const allMeetingsSelectAllBtn = $<HTMLButtonElement>('all-meetings-select-all')
const allMeetingsSelectNoneBtn = $<HTMLButtonElement>('all-meetings-select-none')
const allMeetingsTranscribeBtn = $<HTMLButtonElement>('all-meetings-transcribe')
const allMeetingsDeleteBtn = $<HTMLButtonElement>('all-meetings-delete')
const allMeetingsStopBtn = $<HTMLButtonElement>('all-meetings-stop')
const allMeetingsProgressEl = $('all-meetings-progress')
const allMeetingsRetranscribeHintEl = $('all-meetings-retranscribe-hint')

/** A single past meeting's transcript (spec item 1) — its own page so opening one
 * never disturbs a recording that may still be running in the background (see
 * `showPage`'s doc comment; Settings already works the same way). */
const detailPage = $('meeting-detail-page')
const detailBackBtn = $<HTMLButtonElement>('detail-back')
const detailBackLabel = $('detail-back-label')
const detailTitleEl = $('detail-title')
const detailMetaEl = $('detail-meta')
const detailRevealBtn = $<HTMLButtonElement>('detail-reveal')
const detailSpeakersEl = $('detail-speakers')
const detailTranscriptEl = $('detail-transcript')
const langRadios: Record<Language, HTMLInputElement> = {
  en: $<HTMLInputElement>('lang-en'),
  th: $<HTMLInputElement>('lang-th'),
}

/** Settings became its own page (iPadOS-style sidebar of categories + grouped
 * cards) rather than the old single `<details>` disclosure — see the report
 * for why. Everything below wires that page open/closed and switches which
 * category's cards are visible. */
type SettingsCategory = 'general' | 'recording' | 'transcription' | 'speakers' | 'connections'
const SETTINGS_CATEGORIES: SettingsCategory[] = ['general', 'recording', 'transcription', 'speakers', 'connections']

const mainView = $('main-view')
const settingsPage = $('settings-page')

/**
 * Every top-level page this app can show, in one place — main view, Settings,
 * onboarding, a single meeting's transcript, and the full meetings list. Only one is
 * ever visible; `showPage` is the one function allowed to touch any of their `hidden`
 * flags, so a page opened from within another page (e.g. Settings from the meetings
 * panel's "missing model" warning) can never leave two pages visible at once. Forward
 * references to `onboardingPage`/`detailPage`/`allMeetingsPage` (declared further down,
 * next to the controls each page owns) are fine here — this function's body only runs
 * once a user interacts with something, long after every const below has initialized.
 */
/** Which page is on screen. The floating controls exist because leaving this one hides
 * every control the recording has. */
let currentPage: HTMLElement = mainView

function showPage(page: HTMLElement): void {
  currentPage = page
  for (const p of [mainView, settingsPage, onboardingPage, detailPage, allMeetingsPage]) p.hidden = p !== page
  renderRecordingControls()
}

const micMuteBtn = $<HTMLButtonElement>('mic-mute')
const micNoteEl = $('mic-note')
const pauseBtn = $<HTMLButtonElement>('pause')
const pausedNoteEl = $('paused-note')
const miniEl = $('mini')
const miniTimeEl = $('mini-time')
const miniTitleEl = $('mini-title')
const miniMicBtn = $<HTMLButtonElement>('mini-mic')
const miniPauseBtn = $<HTMLButtonElement>('mini-pause')
const miniStopBtn = $<HTMLButtonElement>('mini-stop')
const miniOpenBtn = $<HTMLButtonElement>('mini-open')

/**
 * How much audio has actually been recorded, in milliseconds — not how long ago Start
 * was pressed. Paused time is not in the file, so counting it would make the clock
 * disagree with the recording it is timing, and with every timestamp in the transcript.
 * `since` is when the current unpaused run began; null while paused.
 */
let recordedMs = 0
let recordingSince: number | null = null
const recordedSec = (): number => (recordedMs + (recordingSince === null ? 0 : Date.now() - recordingSince)) / 1000

/**
 * Everything that has to agree about the recording: the capsule's two buttons, the
 * paused notice, and the floating bar that carries the same two buttons onto every
 * other page. One function so they cannot drift apart, called from the page switch, the
 * clock, and each control's own handler.
 */
function renderRecordingControls(): void {
  const on = recorder !== null
  const paused = recorder?.isPaused === true

  const muted = recorder?.isMicMuted === true

  toggle.textContent = on ? t().stop : t().start
  pauseBtn.hidden = !on
  pauseBtn.textContent = paused ? t().resume : t().pause
  pausedNoteEl.hidden = !paused
  pausedNoteEl.textContent = t().pausedNote
  micMuteBtn.hidden = !on
  micMuteBtn.textContent = muted ? t().micUnmute : t().micMute
  micMuteBtn.className = muted ? 'muted' : ''
  // Not shown while paused: nothing at all is being recorded then, and two notices
  // saying overlapping things is how neither gets read.
  micNoteEl.hidden = !muted || paused
  micNoteEl.textContent = t().micMutedNote

  // Only where the capsule is not: on the main page every one of these controls is
  // already on screen, and a second copy of them is just somewhere else to click.
  miniEl.hidden = !on || currentPage === mainView
  miniEl.className = `mini ${paused ? 'paused' : 'rec'}`
  miniMicBtn.textContent = muted ? t().micUnmute : t().micMute
  miniMicBtn.className = muted ? 'mini-mic muted' : 'mini-mic'
  miniPauseBtn.textContent = paused ? t().resume : t().pause
  miniStopBtn.textContent = t().stop
  miniOpenBtn.title = t().miniOpen
  miniTitleEl.textContent = title.value.trim() || title.placeholder
  miniTimeEl.textContent = fmt(recordedSec())
}

function setPaused(paused: boolean): void {
  if (!recorder) return
  recorder.setPaused(paused)
  if (paused) {
    recordedMs += recordingSince === null ? 0 : Date.now() - recordingSince
    recordingSince = null
    for (const track of ['loopback', 'mic'] as const) setLevel(track, 0)
  } else {
    recordingSince = Date.now()
  }
  renderRecordingControls()
}

/** Mutes or unmutes the microphone mid-meeting. The loopback track is untouched: the
 * other side is still talking and still worth recording. */
function setMicMuted(muted: boolean): void {
  if (!recorder) return
  recorder.setMicMuted(muted)
  if (muted) setLevel('mic', 0)
  renderRecordingControls()
}

micMuteBtn.onclick = () => setMicMuted(recorder?.isMicMuted !== true)
miniMicBtn.onclick = () => setMicMuted(recorder?.isMicMuted !== true)
pauseBtn.onclick = () => setPaused(recorder?.isPaused !== true)
miniPauseBtn.onclick = () => setPaused(recorder?.isPaused !== true)
miniStopBtn.onclick = () => void stop()
miniOpenBtn.onclick = () => showPage(mainView)

const settingsOpenBtn = $<HTMLButtonElement>('settings-open')
const settingsOpenLabel = $('settings-open-label')
const settingsBackBtn = $<HTMLButtonElement>('settings-back')
const settingsBackLabel = $('settings-back-label')
const settingsTitleEl = $('settings-title')
const settingsCatButtons: Record<SettingsCategory, HTMLButtonElement> = {
  general: $<HTMLButtonElement>('cat-general'),
  recording: $<HTMLButtonElement>('cat-recording'),
  transcription: $<HTMLButtonElement>('cat-transcription'),
  speakers: $<HTMLButtonElement>('cat-speakers'),
  connections: $<HTMLButtonElement>('cat-connections'),
}
const settingsPanels: Record<SettingsCategory, HTMLElement> = {
  general: $('panel-general'),
  recording: $('panel-recording'),
  transcription: $('panel-transcription'),
  speakers: $('panel-speakers'),
  connections: $('panel-connections'),
}
const settingsPanelTitles: Record<SettingsCategory, HTMLElement> = {
  general: $('panel-general-title'),
  recording: $('panel-recording-title'),
  transcription: $('panel-transcription-title'),
  speakers: $('panel-speakers-title'),
  connections: $('panel-connections-title'),
}
const catLabel: Record<SettingsCategory, () => string> = {
  general: () => t().catGeneral,
  recording: () => t().catRecording,
  transcription: () => t().catTranscription,
  speakers: () => t().catSpeakers,
  connections: () => t().catConnections,
}

let activeSettingsCategory: SettingsCategory = 'general'

function showSettingsCategory(cat: SettingsCategory): void {
  // The mic test opens the mic and polls it every 0.5-4s with nothing else in the app
  // showing it is still open — leaving the Recording category (where its controls
  // live) has to stop it, or it just keeps capturing unseen.
  if (cat !== 'recording') stopMicTest()
  // Same idea for a playing voice sample (LOW 8) — leaving Speakers without stopping
  // it left audio playing with no visible player anywhere in the app.
  if (cat !== 'speakers') stopPendingAudio()
  activeSettingsCategory = cat
  for (const key of SETTINGS_CATEGORIES) {
    settingsPanels[key].hidden = key !== cat
    if (key === cat) settingsCatButtons[key].setAttribute('aria-current', 'true')
    else settingsCatButtons[key].removeAttribute('aria-current')
  }
}

function openSettings(): void {
  showSettingsCategory(activeSettingsCategory)
  // A batch started from the main view can still be running once Settings opens —
  // reflect that immediately rather than waiting for the next onBatchItem tick.
  updateTranscriptionLocks()
  showPage(settingsPage)
}

function closeSettings(): void {
  stopMicTest()
  stopPendingAudio()
  // The secret should not still be on screen next time Settings opens — same as it
  // not surviving a relaunch, closing the panel closes the reveal too (LOW 6). The
  // Connections panel is only hidden, not torn down, so flipping the flag alone would
  // leave the already-revealed DOM sitting there until some unrelated event re-rendered
  // it — force that re-render now, same call applyLanguage already uses for this.
  mcpTokenRevealed = false
  void window.api.mcpState().then(showMcpState)
  showPage(mainView)
}

settingsOpenBtn.onclick = () => openSettings()
settingsBackBtn.onclick = () => closeSettings()
for (const key of SETTINGS_CATEGORIES) settingsCatButtons[key].onclick = () => showSettingsCategory(key)
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return
  // Don't steal Escape from a form control the user is actively editing — e.g. typing
  // a port number should let Escape do its native "cancel this edit" thing, not also
  // close whichever secondary page is open and discard it.
  const el = document.activeElement
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return
  // Onboarding is deliberately excluded — it has no Escape-to-cancel of its own (see
  // its own doc comment below), only Back/Next/Skip.
  if (!settingsPage.hidden) closeSettings()
  else if (!detailPage.hidden) closeMeetingDetail()
  else if (!allMeetingsPage.hidden) closeAllMeetings()
})

/**
 * First-run onboarding (spec item: no settings on the main page, but a first run has
 * to get to a working state somehow) — a fourth top-level page alongside main-view and
 * settings-page, one step at a time. Reuses Settings' own building blocks wherever a
 * step needs the same thing Settings already offers (the ASR model picker + download
 * panel, the permission boxes) rather than building second copies of either.
 */
type OnboardingStep =
  | 'language'
  | 'welcome'
  | 'meetingLanguage'
  | 'model'
  | 'permissions'
  | 'transcribeMode'
  | 'files'
  | 'finish'
// Language comes first, before the welcome it is about to be read in: every other step
// asks a question, and asking any of them in a language the user did not choose is the
// one thing this wizard cannot recover from on its own.
const ONBOARDING_STEPS: OnboardingStep[] = [
  'language',
  'welcome',
  'meetingLanguage',
  'model',
  'permissions',
  'transcribeMode',
  'files',
  'finish',
]
// Only these two can genuinely fail to complete right now (a download the user wants
// to defer, a permission they want to grant later) — every other step always has a
// sensible current value (a language, a mode), so "Next" alone already covers it.
const ONBOARDING_SKIPPABLE = new Set<OnboardingStep>(['model', 'permissions'])
const ONBOARDING_SKIP_HINT: Partial<Record<OnboardingStep, () => string>> = {
  model: () => t().onbModelSkipHint,
  permissions: () => t().onbPermissionsSkipHint,
}

const onboardingPage = $('onboarding-page')
const onbStepsEl = $('onboarding-steps')
const onbBackBtn = $<HTMLButtonElement>('onb-back')
const onbNextBtn = $<HTMLButtonElement>('onb-next')
const onbSkipBtn = $<HTMLButtonElement>('onb-skip')
const onbSkipHintEl = $('onb-skip-hint')

const onbStepSections: Record<OnboardingStep, HTMLElement> = {
  files: $('onb-files'),
  welcome: $('onb-welcome'),
  language: $('onb-language'),
  meetingLanguage: $('onb-meeting-lang'),
  model: $('onb-model'),
  permissions: $('onb-permissions'),
  transcribeMode: $('onb-transcribe-mode'),
  finish: $('onb-finish'),
}

const onbWelcomeTitleEl = $('onb-welcome-title')
const onbWelcomeBodyEl = $('onb-welcome-body')

const onbFilesTitleEl = $('onb-files-title')
const onbFilesBodyEl = $('onb-files-body')
const onbFilesPathEl = $('onb-files-path')
const onbFilesOpenBtn = $<HTMLButtonElement>('onb-files-open')
const onbFilesManageEl = $('onb-files-manage')
// Asked for once, not on every render of the step — it is a constant for the life of
// the app (main's NOTES_ROOT), and the step is re-rendered on every language switch.
let notesRoot: string | null = null
onbFilesOpenBtn.onclick = () => void window.api.openNotesFolder()

const onbLanguageTitleEl = $('onb-language-title')
const onbLangRadios: Record<Language, HTMLInputElement> = {
  en: $<HTMLInputElement>('onb-lang-en'),
  th: $<HTMLInputElement>('onb-lang-th'),
}

const onbMeetingLangTitleEl = $('onb-meeting-lang-title')
const onbMeetingLangSelect = $<HTMLSelectElement>('onb-meeting-lang-select')
const onbMeetingLangHintEl = $('onb-meeting-lang-hint')

const onbModelTitleEl = $('onb-model-title')
const onbAsrModelEl = $('onb-asr-model')
const onbAsrModelNoteEl = $('onb-asr-model-note')
const onbModelsEl = $('onb-models')

const onbPermissionsTitleEl = $('onb-permissions-title')
const onbPermsEl = $('onb-perms')

const onbTranscribeModeTitleEl = $('onb-transcribe-mode-title')
const onbTranscribeModeRadios: Record<TranscribeMode, HTMLInputElement> = {
  after: $<HTMLInputElement>('onb-mode-after'),
  live: $<HTMLInputElement>('onb-mode-live'),
  manual: $<HTMLInputElement>('onb-mode-manual'),
}
const onbTranscribeModeNames: Record<TranscribeMode, HTMLElement> = {
  after: $('onb-mode-after-name'),
  live: $('onb-mode-live-name'),
  manual: $('onb-mode-manual-name'),
}
const onbTranscribeModeHintEl = $('onb-transcribe-mode-hint')
const getOnbTranscribeMode = (): TranscribeMode =>
  (Object.entries(onbTranscribeModeRadios).find(([, r]) => r.checked)?.[0] as TranscribeMode | undefined) ?? 'after'
const setOnbTranscribeModeValue = (v: TranscribeMode): void => {
  for (const [key, r] of Object.entries(onbTranscribeModeRadios)) r.checked = key === v
}

const onbFinishTitleEl = $('onb-finish-title')
const onbFinishBodyEl = $('onb-finish-body')

const updateLabelEl = $('update-label')
const updateCheckBtn = $<HTMLButtonElement>('update-check')
const updateStateEl = $('update-state')
const updateBarEl = $('update-bar')
const updateBarFill = updateBarEl.querySelector('i') as HTMLElement

/**
 * The update card walks one line at a time: idle → checking → up to date, or → an
 * offer, → downloading, → installing (after which the app relaunches and this state is
 * gone with it). Held as data rather than as rendered text, the same reason every other
 * message in this file is: a language switch has to be able to re-derive it.
 */
type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'current' }
  | { kind: 'available'; info: UpdateInfo }
  | { kind: 'downloading'; info: UpdateInfo; received: number; total: number }
  | { kind: 'installing' }
  | { kind: 'armed' }
  | { kind: 'failed'; message: string }
let updateState: UpdateState = { kind: 'idle' }
let appVersion = ''

const megabytes = (bytes: number): number => Math.round(bytes / 1_000_000)

function renderUpdate(): void {
  updateLabelEl.textContent = t().updateLabel(appVersion)
  const busy = updateState.kind === 'downloading' || updateState.kind === 'installing'
  updateBarEl.hidden = updateState.kind !== 'downloading'

  if (updateState.kind === 'downloading') {
    const pct = updateState.total > 0 ? Math.round((updateState.received / updateState.total) * 100) : 0
    updateBarFill.style.width = `${pct}%`
    updateStateEl.textContent = t().updateDownloading(pct)
  } else if (updateState.kind === 'checking') updateStateEl.textContent = t().updateChecking
  else if (updateState.kind === 'current') updateStateEl.textContent = t().updateUpToDate
  else if (updateState.kind === 'available') {
    updateStateEl.textContent = t().updateAvailable(updateState.info.version, megabytes(updateState.info.bytes))
  } else if (updateState.kind === 'installing') updateStateEl.textContent = t().updateInstalling
  else if (updateState.kind === 'armed') updateStateEl.textContent = t().updateArmed
  else if (updateState.kind === 'failed') updateStateEl.textContent = t().updateFailed(updateState.message)
  else updateStateEl.textContent = ''

  // The one button changes job rather than three buttons taking turns being hidden:
  // there is exactly one thing worth doing at each step.
  updateCheckBtn.textContent =
    updateState.kind === 'available'
      ? t().updateInstall
      : updateState.kind === 'downloading'
        ? t().updateCancel
        : t().updateCheck
  updateCheckBtn.disabled =
    updateState.kind === 'checking' || updateState.kind === 'installing' || updateState.kind === 'armed'
  // Main refuses an update mid-pass (it is replacing the app that is doing the work),
  // so say that before the click rather than after it.
  if (!busy && transcriptionBusy()) updateStateEl.textContent = t().updateBusyHint
}

updateCheckBtn.onclick = async () => {
  if (updateState.kind === 'downloading') {
    await window.api.cancelUpdate()
    updateState = { kind: 'idle' }
    return renderUpdate()
  }
  if (updateState.kind === 'available') {
    const info = updateState.info
    updateState = { kind: 'downloading', info, received: 0, total: info.bytes }
    renderUpdate()
    try {
      await window.api.downloadUpdate(info)
    } catch (err) {
      updateState = { kind: 'failed', message: reason(err) }
      return renderUpdate()
    }
    // Asked only once the waiting is over, and asked at all because installing means
    // this app closing — which used to just happen, with no warning, the moment the
    // progress bar filled.
    const answer = await window.api.ask(t().updateReadyTitle(info.version), t().updateReadyDetail, [
      t().updateNow,
      t().updateOnQuit,
      t().deleteCancel,
    ])
    try {
      if (answer === 2) {
        await window.api.discardUpdate()
        updateState = { kind: 'idle' }
      } else if (answer === 1) {
        await window.api.applyUpdate('quit')
        updateState = { kind: 'armed' }
      } else {
        // Resolving is not the expected outcome — main relaunches the app on success —
        // so anything that comes back here means it stopped short of restarting.
        await window.api.applyUpdate('now')
        updateState = { kind: 'installing' }
      }
    } catch (err) {
      updateState = { kind: 'failed', message: reason(err) }
    }
    return renderUpdate()
  }
  updateState = { kind: 'checking' }
  renderUpdate()
  try {
    const info = await window.api.checkForUpdate()
    updateState = info ? { kind: 'available', info } : { kind: 'current' }
  } catch (err) {
    updateState = { kind: 'failed', message: reason(err) }
  }
  renderUpdate()
}

window.api.onUpdateProgress((progress) => {
  if (updateState.kind !== 'downloading') return
  updateState = { ...updateState, received: progress.received, total: progress.total }
  renderUpdate()
})

void window.api.appVersion().then((version) => {
  appVersion = version
  renderUpdate()
})

const onboardingRerunLabelEl = $('onboarding-rerun-label')
const onboardingRerunBtn = $<HTMLButtonElement>('onboarding-rerun')
const onboardingRerunLockHint = $('onboarding-rerun-lock-hint')

let onbIndex = 0

/** Delegates to the exact same picker + download panel Settings > Transcription uses
 * (renderAsrModel/renderModels, generalized above to take a container) rather than a
 * second copy of either. */
async function renderOnboardingModelStep(): Promise<void> {
  onbAsrModelNoteEl.textContent = t().asrModelTimingNote
  await Promise.all([renderAsrModel(onbAsrModelEl, onbModelsEl), renderModels('', onbModelsEl)])
}

/** Same permission boxes the main page shows once a capture actually fails (spec item
 * 1) — here shown proactively, before either has been asked for, since a first run has
 * no meeting yet to fail. */
async function renderOnboardingPermissions(): Promise<void> {
  onbPermsEl.replaceChildren()
  await appendPermissionWarnings(true, onbPermsEl, renderOnboardingPermissions)
  if (!onbPermsEl.hasChildNodes()) {
    const ok = document.createElement('div')
    ok.className = 'hint'
    ok.textContent = t().onbPermissionsGranted
    onbPermsEl.append(ok)
  }
}

function renderOnboardingStep(): void {
  const step = ONBOARDING_STEPS[onbIndex]!
  for (const key of ONBOARDING_STEPS) onbStepSections[key].hidden = key !== step

  onbStepsEl.replaceChildren(
    ...ONBOARDING_STEPS.map((_, i) => {
      const dot = document.createElement('span')
      dot.className = `onb-dot${i === onbIndex ? ' active' : i < onbIndex ? ' done' : ''}`
      return dot
    }),
  )
  onbStepsEl.setAttribute('aria-label', t().onbStepOf(onbIndex + 1, ONBOARDING_STEPS.length))

  onbBackBtn.hidden = onbIndex === 0
  onbBackBtn.textContent = t().onbBack
  onbNextBtn.textContent = onbIndex === ONBOARDING_STEPS.length - 1 ? t().onbGetStarted : t().onbNext
  onbSkipBtn.hidden = !ONBOARDING_SKIPPABLE.has(step)
  onbSkipBtn.textContent = t().onbSkip
  onbSkipHintEl.textContent = ONBOARDING_SKIP_HINT[step]?.() ?? ''

  onbWelcomeTitleEl.textContent = t().onbWelcomeTitle
  onbWelcomeBodyEl.textContent = t().onbWelcomeBody

  onbLanguageTitleEl.textContent = t().onbLanguageTitle
  onbLangRadios.en.checked = lang === 'en'
  onbLangRadios.th.checked = lang === 'th'

  onbMeetingLangTitleEl.textContent = t().onbMeetingLangTitle
  const onbMeetingLangOptions = onbMeetingLangSelect.options
  onbMeetingLangOptions[0]!.textContent = t().meetingLangName.th
  onbMeetingLangOptions[1]!.textContent = t().meetingLangName.en
  // The exact same hint Settings > Transcription shows — it already carries every
  // measured number the spec wants here, for both directions of getting this wrong.
  onbMeetingLangHintEl.textContent = t().meetingLangHint

  onbModelTitleEl.textContent = t().onbModelTitle
  onbPermissionsTitleEl.textContent = t().onbPermissionsTitle
  onbTranscribeModeTitleEl.textContent = t().onbTranscribeModeTitle
  onbTranscribeModeNames.after.textContent = t().transcribeModeAfter
  onbTranscribeModeNames.live.textContent = t().transcribeModeLive
  onbTranscribeModeNames.manual.textContent = t().transcribeModeManual
  onbTranscribeModeHintEl.textContent = t().transcribeModeHint[getOnbTranscribeMode()] ?? ''

  onbFilesTitleEl.textContent = t().onbFilesTitle
  onbFilesBodyEl.textContent = t().onbFilesBody
  onbFilesOpenBtn.textContent = t().onbFilesOpen
  onbFilesManageEl.textContent = t().onbFilesManage
  onbFilesPathEl.textContent = notesRoot ?? ''
  if (notesRoot === null) {
    void window.api.notesRoot().then((root) => {
      notesRoot = root
      onbFilesPathEl.textContent = root
    })
  }

  onbFinishTitleEl.textContent = t().onbFinishTitle
  onbFinishBodyEl.textContent = t().onbFinishBody

  if (step === 'model') void renderOnboardingModelStep()
  if (step === 'permissions') void renderOnboardingPermissions()
}

async function showOnboarding(): Promise<void> {
  // Hidden before the await below, not after — otherwise "Run setup again" (which
  // closes Settings, itself synchronous, right before calling this) would flash the
  // main page for a frame while the settings round-trip is in flight.
  showPage(onboardingPage)
  // Seeded from disk rather than assumed — "Run setup again" from Settings can open
  // this long after the defaults were last touched.
  const settings = await window.api.getSettings()
  onbMeetingLangSelect.value = settings.meetingLanguage
  setOnbTranscribeModeValue(settings.transcribeMode)
  onbIndex = 0
  renderOnboardingStep()
}

function hideOnboarding(): void {
  showPage(mainView)
}

for (const [code, radio] of Object.entries(onbLangRadios) as [Language, HTMLInputElement][]) {
  radio.onchange = async () => {
    if (!radio.checked) return
    try {
      applyLanguage((await window.api.setLanguage(code)).language)
    } catch (err) {
      // The radio's own checked state already flipped natively on click — put it back
      // in sync with the language that's actually still active before reporting why.
      onbLangRadios.en.checked = lang === 'en'
      onbLangRadios.th.checked = lang === 'th'
      setWarning({ text: () => t().languageSaveFailed(reason(err)) })
    }
  }
}

onbMeetingLangSelect.onchange = async () => {
  onbMeetingLangSelect.disabled = true
  try {
    await window.api.setMeetingLanguage(onbMeetingLangSelect.value as MeetingLanguage)
  } finally {
    onbMeetingLangSelect.disabled = false
  }
}

const onOnbTranscribeModeChange = async (): Promise<void> => {
  for (const r of Object.values(onbTranscribeModeRadios)) r.disabled = true
  try {
    await window.api.setTranscribeMode(getOnbTranscribeMode())
    onbTranscribeModeHintEl.textContent = t().transcribeModeHint[getOnbTranscribeMode()] ?? ''
  } finally {
    for (const r of Object.values(onbTranscribeModeRadios)) r.disabled = false
  }
}
for (const r of Object.values(onbTranscribeModeRadios)) r.onchange = onOnbTranscribeModeChange

onbBackBtn.onclick = () => {
  if (onbIndex === 0) return
  onbIndex -= 1
  renderOnboardingStep()
}
onbNextBtn.onclick = () => {
  if (onbIndex === ONBOARDING_STEPS.length - 1) {
    void finishOnboarding()
    return
  }
  onbIndex += 1
  renderOnboardingStep()
}

/** LOW 7: the old version fired setOnboarded un-awaited and un-caught — on a
 * read-only userData volume it fails silently and the user is dropped back into
 * onboarding on every launch forever, with nothing ever telling them why. Hides the
 * page either way (the user did finish the flow; a write failure is this app's
 * problem, not something worth trapping them behind), but now at least says so. */
async function finishOnboarding(): Promise<void> {
  try {
    await window.api.setOnboarded(true)
  } catch (err) {
    setWarning({ text: () => t().onboardingSaveFailed(reason(err)) })
  }
  hideOnboarding()
}
onbSkipBtn.onclick = () => {
  onbIndex = Math.min(onbIndex + 1, ONBOARDING_STEPS.length - 1)
  renderOnboardingStep()
}

// Settings > General's own way back in, for someone who wants to revisit a choice made
// during onboarding (or never went through it, having upgraded from before it existed).
onboardingRerunBtn.onclick = () => {
  closeSettings()
  void showOnboarding()
}

let recorder: Recorder | null = null
let ticker: number | undefined

/**
 * During the meeting a segment is only ever "us" or "them" (spec §4.2); diarization
 * replaces the `them` half with real speakers once the recording is complete.
 */
let segments: Transcript['segments'] = []
let speakers: Record<string, string> = { ...en.speakerDefaults }
/** Which of `speakers` are voices the app already recognises, and by which id — set
 * alongside `speakers` whenever a diarize pass lands (onDiarized below), read by
 * renderSpeakerPanel to show the user which renames propagate everywhere and which
 * stay local to this meeting (spec item 3). */
let speakerVoices: Transcript['speakerVoices'] = undefined
let meetingDir: string | null = null

/** Remembered so a language switch re-renders the panel with the same screen/mic scope. */
let permissionsIncludeScreen = false

/**
 * `warnings` shows two independent things at once: the permission boxes below, and
 * (at most) one ad-hoc message — track-lost, whisper-server failing to start, or a
 * diarize failure. Both used to be written with `.textContent =`/`.replaceChildren()`
 * straight onto the same element, so whichever ran last wiped the other, and a
 * language switch (which always re-derives the permission boxes) silently discarded
 * a live ad-hoc message. Fixing this for `warnings` only would leave `done`, `queue`
 * and the mic-test verdict with the identical bug, so the shape is the same
 * everywhere: keep the message as a thunk that re-reads `t()`, not as rendered text,
 * and give each panel one render function that is the only thing allowed to touch
 * its DOM. `AdHocWarning`/`adHocWarning` itself are declared further down, next to
 * the render function that is their only reader.
 */

/**
 * macOS has no not-determined state for Screen Recording — never-granted reads back
 * as "denied". So at launch we only speak up about the mic, which does distinguish
 * the two; the screen box appears once a capture attempt has actually failed.
 */
/** `container`/`onChange` default to the main page's own warnings box; onboarding's
 * permissions step passes its own element and its own re-render function, so granting
 * (or being sent to System Settings for) a permission there refreshes the right panel. */
async function appendPermissionWarnings(
  includeScreen: boolean,
  container: HTMLElement = warnings,
  onChange: () => void | Promise<void> = () => renderWarnings(),
): Promise<void> {
  const status = await window.api.permissions()
  for (const which of includeScreen ? (['screen', 'microphone'] as const) : (['microphone'] as const)) {
    if (status[which] === 'granted') continue
    const name = t().permName[which]
    const why = t().permWhy[which]

    // not-determined means macOS has never asked. Sending someone to System Settings
    // then is a dead end — an app only appears in that list once it has asked at
    // least once. So ask, and let the OS add us to the list.
    const canAsk = which === 'microphone' && status[which] === 'not-determined'
    const box = document.createElement('div')
    box.className = 'warn'
    box.textContent = canAsk ? t().permNeverAsked(name, why) : t().permDenied(name, why)

    const action = document.createElement('button')
    action.textContent = canAsk ? t().permGrant(name) : t().permOpenSettings
    action.onclick = async () => {
      action.disabled = true
      if (canAsk) await window.api.requestPermissions()
      else await window.api.openPrivacySettings(which)
      await onChange()
    }
    box.append(document.createElement('br'), action)
    container.append(box)
  }
}

/** Every whisper/diarize error that traces back to a missing model file carries this
 * exact hint (whisper.ts, diarize.ts's requireFiles calls) — the one reliable marker
 * for "send them to Settings" instead of showing the raw backend text. */
const MODEL_MISSING_MARKER = 'use the download button in the app'
const isModelMissing = (message: string): boolean => message.includes(MODEL_MISSING_MARKER)

/** The ad-hoc warning is a thunk (so a language switch can re-derive it) plus an
 * optional action button — used by the one case (a missing-model failure) that needs
 * more than text: somewhere to send the user, not just something to tell them. */
type AdHocWarning = { text: () => string; action?: () => void; actionLabel?: () => string }
let adHocWarning: AdHocWarning | null = null

async function renderWarnings(includeScreen = permissionsIncludeScreen): Promise<void> {
  permissionsIncludeScreen = includeScreen
  warnings.replaceChildren()
  if (adHocWarning) {
    const { text, action, actionLabel } = adHocWarning
    const box = document.createElement('div')
    box.textContent = text()
    if (action) {
      const button = document.createElement('button')
      button.textContent = actionLabel ? actionLabel() : t().modelsGoToSettings
      button.onclick = action
      box.append(document.createElement('br'), button)
    }
    warnings.append(box)
  }
  await appendPermissionWarnings(includeScreen)
}

/** Sets (or clears, with `null`) the ad-hoc warning and re-renders. */
function setWarning(msg: AdHocWarning | null): void {
  adHocWarning = msg
  void renderWarnings()
}

/** Wired to every ad-hoc warning that can be caused by a missing model (whisperError,
 * diarizeError) — jumps straight to the one place that can actually fix it. */
function modelMissingAction(): void {
  activeSettingsCategory = 'transcription'
  openSettings()
}

/** `queue` holds at most one of: backlog depth, transcribing %, or "diarizing…" — same
 * thunk-not-string treatment as `adHocWarning`, so applyLanguage() can re-derive it. */
let queueMsg: (() => string) | null = null
function renderQueue(): void {
  queue.textContent = queueMsg ? queueMsg() : ''
}
function setQueueMsg(msg: (() => string) | null): void {
  queueMsg = msg
  renderQueue()
}

/** `done` goes through the same "hold the data, not the rendered text" treatment —
 * either mid-stop ("Transcribing what's left…") or the finished "Saved … · N segments"
 * line with its reveal link. */
type DoneState = { kind: 'pending' } | { kind: 'saved'; durationSec: number; segments: number; dir: string; id: string }
let doneState: DoneState | null = null
function renderDone(): void {
  done.replaceChildren()
  const state = doneState
  if (!state) return
  if (state.kind === 'pending') {
    done.textContent = t().transcribingRest
    return
  }
  done.textContent = t().saved(fmt(state.durationSec), state.segments)
  const open = document.createElement('a')
  open.href = '#'
  open.textContent = titleOf(state.id)
  open.onclick = () => void window.api.reveal(state.dir)
  done.append(open)
}

function fmt(sec: number): string {
  const p = (n: number) => String(Math.floor(n)).padStart(2, '0')
  return `${p(sec / 60)}:${p(sec % 60)}`
}

const size = (bytes: number) =>
  bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`

/** Falls back to the raw filename so an unrecognized model never crashes the panel. */
const modelName = (file: string) => t().modelNames[file] ?? file

/**
 * Three gigabytes of models are fetched on first run rather than shipped in the
 * installer (spec §12). The app records fine without them; only transcription and
 * diarization wait, so this panel informs rather than blocks.
 *
 * One bar covers every missing file rather than one per file — the large-v3 weights
 * alone are 3.0 of the 3.1 GB total, so four bars would mostly sit empty. `received`
 * is a running per-file byte count (seeded from each file's resumeFrom) that
 * `onModelProgress` updates as events arrive; the bar shows their sum over the total
 * across all missing files.
 */
let overallTotal = 0
const received = new Map<string, number>()
/**
 * LOW 8: keyed by container, not three bare module-level refs — Settings and
 * onboarding each pass their own container (renderModels' own doc comment), but a
 * single shared `overallFill`/`overallName`/`overallSize` meant whichever container
 * rendered *last* silently stole them from whichever rendered first: start a download
 * at onboarding's model step, switch language (applyLanguage always re-renders
 * Settings' copy too), and `onModelProgress` below kept writing into Settings' now-
 * live refs while onboarding's own bar sat frozen, still showing the last container
 * that actually held the refs. Each container's own entry is independent, so a
 * re-render of one can never blank out the other's.
 */
const bars = new Map<HTMLElement, { fill: HTMLElement; name: HTMLElement; size: HTMLElement }>()

/**
 * Whether a download is in flight — same pattern as `batchRunning`/`selectedMeetings`
 * for the meetings queue: state that lives at module level, independent of the DOM, so
 * it survives `renderModels()` being called again mid-download (a language switch, or
 * the ASR-model radio's onchange re-rendering this panel). Without this, every
 * re-render rebuilt the panel from scratch assuming idle, snapping "Downloading… /
 * Cancel" back to "Download models" while the download kept running underneath —
 * and a second click then hit main's "a download is already running" with no way
 * back to the progress bar or the cancel button.
 */
let downloadRunning = false

/** Updates every container currently tracking a bar — there is only ever one download
 * in flight (`received`/`overallTotal` are legitimately global, unlike the DOM refs
 * above), so every live bar should move together. */
function updateOverallBar(): void {
  const sum = [...received.values()].reduce((a, b) => a + b, 0)
  for (const { fill, size: sizeEl } of bars.values()) {
    fill.style.width = `${overallTotal ? (sum / overallTotal) * 100 : 0}%`
    sizeEl.textContent = `${size(sum)} / ${size(overallTotal)}`
  }
}

/** `container` defaults to the Settings > Transcription copy of this panel; onboarding's
 * model step passes its own element so the two never fight over the same DOM node. */
async function renderModels(note = '', container: HTMLElement = modelsEl): Promise<void> {
  const missing = (await window.api.modelStatus()).filter((m) => !m.present)
  container.replaceChildren()
  // This container's own bar refs are always rebuilt from here on (or dropped, if
  // nothing is missing) — never another container's.
  bars.delete(container)
  if (missing.length === 0) {
    downloadRunning = false
    if (note) container.textContent = note
    return
  }

  const box = document.createElement('div')
  box.className = 'warn'
  overallTotal = missing.reduce((sum, m) => sum + m.bytes, 0)
  const resumable = missing.filter((m) => m.resumeFrom > 0)
  box.textContent =
    t().modelsMissing(missing.length, size(overallTotal)) +
    (resumable.length > 0 ? t().modelsResumable(size(resumable.reduce((s, m) => s + m.resumeFrom, 0))) : '')

  // Seed newly-missing files from their resumeFrom, but keep whatever a running
  // download has already accumulated for files still in progress — an unconditional
  // received.clear() here is what snapped the bar back to resumeFrom (e.g. 122 MB)
  // on every re-render instead of showing the bytes that had arrived since (140 MB).
  for (const file of [...received.keys()]) {
    if (!missing.some((m) => m.file === file)) received.delete(file)
  }
  for (const spec of missing) if (!received.has(spec.file)) received.set(spec.file, spec.resumeFrom)

  const barRow = document.createElement('div')
  barRow.className = 'file'
  const nameEl = document.createElement('span')
  const sizeEl = document.createElement('span')
  sizeEl.className = 'size'
  const bar = document.createElement('span')
  bar.className = 'bar'
  const fillEl = document.createElement('i')
  bar.append(fillEl)
  barRow.append(nameEl, sizeEl, bar)
  box.append(barRow)
  bars.set(container, { fill: fillEl, name: nameEl, size: sizeEl })
  updateOverallBar()

  const button = document.createElement('button')
  button.textContent = t().downloadModels
  const cancel = document.createElement('button')
  cancel.textContent = t().cancel
  const status = document.createElement('div')
  status.className = 'hint'
  button.hidden = downloadRunning
  cancel.hidden = !downloadRunning
  status.textContent = downloadRunning ? t().downloading : note

  button.onclick = async () => {
    downloadRunning = true
    button.hidden = true
    cancel.hidden = false
    status.textContent = t().downloading
    let outcome: string
    try {
      outcome = (await window.api.downloadModels()).cancelled ? t().downloadCancelled : t().downloadComplete
    } catch (err) {
      outcome = reason(err)
    } finally {
      downloadRunning = false
    }
    // Re-rendering replaces this panel, so the outcome has to be handed forward
    // rather than written into an element that is about to be thrown away.
    await renderModels(outcome, container)
    // A download can complete a model the picker was showing as "not downloaded" —
    // refresh whichever ASR-model picker (Settings, or onboarding's own copy) is
    // currently live, so it never lags behind a download that just finished.
    void renderAsrModel(container === modelsEl ? asrModelEl : onbAsrModelEl, container)
  }
  cancel.onclick = () => void window.api.cancelModels()

  const row = document.createElement('div')
  row.className = 'row'
  row.append(button, cancel, status)
  box.append(row)
  container.append(box)
}

const ASR_MODEL_KEYS: AsrModel[] = ['turbo', 'medium', 'large']

/**
 * The three ASR models, each showing what it costs (RAM/speed/accuracy — asrModelDetail)
 * and whether it needs downloading, so switching is an informed choice made right here
 * rather than a surprise the next time a meeting tries to transcribe.
 */
/** `container`/`modelsContainer` default to the Settings > Transcription copy of this
 * picker; onboarding's model step passes its own pair so picking a model there updates
 * onboarding's own radio list and download panel, not the (hidden) Settings ones. */
async function renderAsrModel(
  container: HTMLElement = asrModelEl,
  modelsContainer: HTMLElement = modelsEl,
): Promise<void> {
  const [settings, statuses] = await Promise.all([window.api.getSettings(), window.api.asrModelStatus()])
  // LOW 8: only Settings' own label/note elements — onboarding's model step has its
  // own copies (onbAsrModelNoteEl, set in renderOnboardingModelStep) and never reads
  // these two, so writing them unconditionally for every call was wasted work with the
  // same smell as the shared download-bar refs above, even though nothing was visibly
  // wrong from it.
  if (container === asrModelEl) {
    asrModelLabelEl.textContent = t().asrModelLabel
    asrModelNoteEl.textContent = t().asrModelTimingNote
  }
  container.replaceChildren()

  for (const key of ASR_MODEL_KEYS) {
    const st: ModelStatus | undefined = statuses[key]
    // A selectable full row (not a control collapsed into one line): each model
    // carries RAM / time-per-30-min / accuracy / download-state the user needs
    // while choosing, so it stays visible for every row, not just the checked one.
    const label = document.createElement('label')
    label.className = 'option-row'

    const radio = document.createElement('input')
    radio.type = 'radio'
    radio.name = 'asr-model'
    radio.value = key
    radio.checked = settings.asrModel === key
    radio.onchange = async () => {
      for (const input of container.querySelectorAll('input')) (input as HTMLInputElement).disabled = true
      try {
        await window.api.setAsrModel(key)
      } finally {
        // The models panel is what actually offers the download — re-rendering it here
        // means picking an undownloaded model surfaces that immediately, instead of
        // only failing once a meeting tries to use it.
        await Promise.all([renderAsrModel(container, modelsContainer), renderModels('', modelsContainer)])
      }
    }

    const head = document.createElement('span')
    head.className = 'option-row-head'
    const name = document.createElement('span')
    name.textContent = t().asrModelName[key]
    const check = document.createElement('span')
    check.className = 'option-row-check'
    check.setAttribute('aria-hidden', 'true')
    check.textContent = '✓'
    head.append(name, check)

    const state = document.createElement('span')
    state.className = 'asr-state'
    state.textContent = st?.present
      ? t().asrModelDownloaded
      : st && st.resumeFrom > 0
        ? t().asrModelPartial(`${size(st.resumeFrom)} / ${size(st.bytes)}`)
        : t().asrModelNeedsDownload(size(st?.bytes ?? 0))

    const detail = document.createElement('div')
    detail.className = 'hint'
    detail.textContent = t().asrModelDetail[key]

    label.append(radio, head, state, detail)
    container.append(label)
  }
}

const content = $('content')

/**
 * The transcript is not its own scroller — the whole content column is, with the
 * capsule sticky on top of it — so scrolling `#transcript` did nothing at all.
 *
 * Only follows when the reader is already at the bottom. Yanking the view back down
 * while someone is reading an earlier line is worse than not following.
 */
function followTranscript(): void {
  const distanceFromBottom = content.scrollHeight - content.scrollTop - content.clientHeight
  if (distanceFromBottom > 120) return
  content.scrollTo({ top: content.scrollHeight, behavior: 'smooth' })
}

/**
 * diarize.ts's UNKNOWN sentinel — the bucket a segment keeps when diarization could not
 * attribute it to any turn, or never ran (diarize() threw, or hasn't reached this
 * meeting yet). `speakerDisplayName` below treats it specially: still carrying the
 * bare default word ('Others'/'คนอื่น') means genuinely nobody has been distinguished
 * here yet, so a renamable number reads more honestly than a word that looks like a
 * name but names nobody.
 */
const UNKNOWN_SPEAKER_KEY = 'them'

/**
 * Every transcript line must be attributed (spec item d): a real name when one is
 * known, a numbered fallback when it is not — never the raw storage key (`SPEAKER_00`,
 * seen on a transcript this app did not just diarize, or one whose diarize pass threw)
 * and never an empty string (a hand-edited transcript.json). `numbering` is one Map per
 * render call, so every line from the same not-yet-named speaker gets the same number
 * instead of a fresh one each time, numbered in the order that speaker first appears.
 *
 * Deliberately does not retranslate an already-resolved name — a typed name, a voice
 * `identify()` matched, or a real "Speaker 2"/"ผู้พูด 2" placeholder diarize.ts already
 * assigned — into the *current* interface language: those are real, meaningful values
 * once set, in whatever language they were set, not a stand-in worth overriding.
 */
function speakerDisplayName(speaker: string, names: Record<string, string>, numbering: Map<string, string>): string {
  const stored = names[speaker]
  const isGenericUnattributed =
    speaker === UNKNOWN_SPEAKER_KEY && (stored === en.speakerDefaults.them || stored === th.speakerDefaults.them)
  if (stored && !isGenericUnattributed) return stored
  if (!numbering.has(speaker)) numbering.set(speaker, t().unnamedSpeaker(numbering.size + 1))
  return numbering.get(speaker)!
}

/** `segs`/`names`/`container` default to the live-session panel; the meeting detail
 * page (below) passes its own so the two never share state. `segs` must already be in
 * t0 order — both callers already guarantee that (writeTranscript on disk, the running
 * session's own sort in onSegments) — so speakerDisplayName's first-appearance
 * numbering is stable across re-renders instead of reshuffling as more lines arrive. */
const playerEl = $('player')
const playerPlayBtn = $<HTMLButtonElement>('player-play')
const playerSeek = $<HTMLInputElement>('player-seek')
const playerTimeEl = $('player-time')

/**
 * Plays a past meeting back, and plays one line of it on demand.
 *
 * Two <audio> elements, not one: the meeting was recorded as two separate tracks and
 * was never mixed (spec §4.1), and mixing them here would mean building a whole new WAV
 * per meeting — 350MB for a long one — to hear something the two tracks already say
 * together. They start at the same instant, so playing both from the same position is
 * the mix. Every seek sets both, which also means any drift is corrected the moment the
 * user touches anything.
 *
 * They stream over `meeting://` (index.ts) rather than a Blob URL, so seeking into the
 * middle of a three-hour recording costs a Range request instead of the whole file.
 */
const players: HTMLAudioElement[] = []
let playerDuration = 0
/** Segments of the meeting currently open, so the line under the playhead can be lit —
 * kept beside the players rather than read from detailSegments, because the transcript
 * can be re-rendered by a speaker rename while playback continues. */
let playerSegments: Transcript['segments'] = []

const playing = (): boolean => players.some((a) => !a.paused && !a.ended)

function stopPlayer(): void {
  for (const audio of players) {
    audio.pause()
    audio.removeAttribute('src')
    audio.load()
  }
  players.length = 0
  playerSegments = []
  playerEl.hidden = true
  playerDuration = 0
}

/** Builds the player for one meeting. `tracks` is which WAVs are actually still on
 * disk — the meetings list can delete the audio and keep the transcript, and that
 * meeting simply has no player rather than a broken one. */
function openPlayer(id: string, tracks: Record<string, boolean>, segs: Transcript['segments'], durationSec: number): void {
  stopPlayer()
  const present = Object.keys(tracks).filter((track) => tracks[track])
  if (present.length === 0) return

  playerSegments = segs
  playerDuration = durationSec
  for (const track of present) {
    const audio = new Audio(`meeting://audio/${encodeURIComponent(id)}/${track}.wav`)
    audio.preload = 'metadata'
    // The transcript's own times are the source of truth for the scrubber, but a
    // meeting whose transcript never recorded a duration still has one on disk.
    audio.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(audio.duration)) playerDuration = Math.max(playerDuration, audio.duration)
      renderPlayer()
    })
    audio.addEventListener('ended', renderPlayer)
    players.push(audio)
  }
  // One track drives the clock; the others follow it. Whichever it is, they were all
  // started together, so it speaks for the meeting's position.
  players[0]!.addEventListener('timeupdate', renderPlayer)
  playerEl.hidden = false
  renderPlayer()
}

function seekPlayer(seconds: number): void {
  const at = Math.min(Math.max(seconds, 0), Math.max(playerDuration - 0.05, 0))
  for (const audio of players) audio.currentTime = at
  renderPlayer()
}

async function togglePlayer(): Promise<void> {
  if (playing()) {
    for (const audio of players) audio.pause()
  } else {
    // Both at once rather than one after the other: awaiting the first would start the
    // second a beat late, and that beat is audible as an echo of the same room.
    await Promise.allSettled(players.map((a) => a.play()))
  }
  renderPlayer()
}

function renderPlayer(): void {
  if (players.length === 0) return
  const at = players[0]!.currentTime
  playerPlayBtn.textContent = playing() ? '❙❙' : '▶'
  playerPlayBtn.setAttribute('aria-label', playing() ? t().playerPause : t().playerPlay)
  playerTimeEl.textContent = `${fmt(at)} / ${fmt(playerDuration)}`
  if (document.activeElement !== playerSeek) {
    playerSeek.value = String(playerDuration > 0 ? Math.round((at / playerDuration) * 1000) : 0)
  }

  // The line under the playhead, lit. Looked up on every tick rather than tracked as
  // state, because a seek, a rename and a re-render can each move it independently.
  const rows = detailTranscriptEl.querySelectorAll('p')
  const current = playerSegments.findIndex((seg) => at >= seg.t0 && at < seg.t1)
  rows.forEach((row, i) => row.classList.toggle('playing', i === current && playing()))
}

playerPlayBtn.onclick = () => void togglePlayer()
playerSeek.oninput = () => seekPlayer((Number(playerSeek.value) / 1000) * playerDuration)

/** Scrolls the detail page's speaker editor to one speaker and marks it, so a name
 * noticed in the transcript can be corrected without hunting for its row. */
function jumpToSpeakerRow(speaker: string): void {
  // `data-keys` holds every cluster the row covers — one row can be several of them.
  const input = detailSpeakersEl.querySelector<HTMLInputElement>(`input[data-keys~="${CSS.escape(speaker)}"]`)
  if (!input) return
  const row = input.closest('.who')
  row?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  row?.classList.add('found')
  // Removed on its own: the mark is a "here it is", not a selection to be dismissed.
  setTimeout(() => row?.classList.remove('found'), 1600)
  input.focus()
}

function renderTranscript(
  segs: Transcript['segments'] = segments,
  names: Record<string, string> = speakers,
  container: HTMLElement = transcript,
): void {
  const numbering = new Map<string, string>()
  container.replaceChildren(
    ...segs.map((s) => {
      const row = document.createElement('p')
      if (s.speaker === 'me') row.className = 'me'
      const at = document.createElement('span')
      at.className = 't'
      at.textContent = fmt(s.t0)
      const who = document.createElement('span')
      who.className = 'who'
      who.textContent = speakerDisplayName(s.speaker, names, numbering)
      // A wrong name is spotted here, while reading, but it is fixed in the editor above
      // — and with a meeting that came back with forty speakers, finding the right row
      // up there is the hard part. Clicking the name does that walk.
      if (container === detailTranscriptEl) {
        who.classList.add('who-jump')
        who.title = t().speakerJump
        who.onclick = (e) => {
          e.stopPropagation() // the row itself seeks the player; the name does not
          jumpToSpeakerRow(s.speaker)
        }
      }
      const text = document.createElement('span')
      text.textContent = s.text
      // Only the detail page has a player to seek, and only while the audio it plays
      // still exists — the live panel's rows stay plain text.
      if (container === detailTranscriptEl && players.length > 0) {
        row.className = `${row.className} playable`.trim()
        row.title = t().playLineHint
        row.onclick = () => {
          seekPlayer(s.t0)
          if (!playing()) void togglePlayer()
        }
      }
      row.append(at, who, text)
      return row
    }),
  )
  // Only the live panel auto-follows new lines — a past meeting's transcript (the
  // detail page passes its own container) should stay put wherever the reader left it.
  if (container === transcript) followTranscript()
}

/** `dir`/`spk`/`container` default to the live-session panel, same as renderTranscript
 * above. `onPreview` re-renders whichever transcript this panel's typing should
 * preview into; `onSave` commits the round-tripped result into whichever variable
 * owns `spk` — the live session's own `speakers`, or the detail page's own copy. */
function renderSpeakerPanel(
  dir: string | null = meetingDir,
  spk: Record<string, string> = speakers,
  container: HTMLElement = speakerPanel,
  onPreview: () => void = () => renderTranscript(),
  onSave: (updated: Record<string, string>) => void = (updated) => {
    speakers = updated
  },
  spkVoices: Transcript['speakerVoices'] = speakerVoices,
): void {
  container.replaceChildren()
  if (!dir) return
  void ensureVoiceNames()

  // One row per PERSON, not per diarization cluster. Clustering routinely splits one
  // voice across a dozen keys — a real meeting came back with SPEAKER_00 through
  // SPEAKER_45 for four people — and once several of them carry the same name they ARE
  // one person everywhere downstream: the transcript prints one name, voices.ts merges
  // them by name. Listing them separately was showing the user the app's internal
  // clustering and asking them to maintain it.
  //
  // Grouped by the STORED name, never by what is displayed: an unnamed key displays as
  // "Speaker 3" (speakerDisplayName numbers them as they first appear), and those are
  // genuinely unknown and genuinely separate until someone says otherwise, so each keeps
  // its own row.
  const groups = new Map<string, string[]>()
  for (const label of Object.keys(spk)) {
    const name = (spk[label] ?? '').trim()
    const key = name === '' ? `\u0000${label}` : name
    groups.set(key, [...(groups.get(key) ?? []), label])
  }

  const inputs = new Map<string, HTMLInputElement>()
  for (const [, labels] of groups) {
    const first = labels[0]!
    const row = document.createElement('div')
    row.className = 'who'
    const tag = document.createElement('code')
    // The keys behind the row, said once. A person split across a dozen clusters is
    // worth knowing about — it is the visible symptom of the speaker-split setting
    // being too fine for this recording.
    tag.textContent = labels.length === 1 ? first : t().speakerParts(labels.length)
    tag.title = labels.join(' ')

    // Visible up front, not just after saving (spec item 3): a voice this diarize pass
    // already tied to an id renames everywhere that id is used; anything else renames
    // only this meeting — see speakerScopeHint below for the full rule. Only a speaker
    // the app matched to a stored voice can BE mis-matched; everyone else is just a name
    // someone typed here, and the ordinary rename already fixes that.
    const linked = labels.filter((label) => spkVoices?.[label])
    if (linked.length > 0) {
      const badge = document.createElement('span')
      badge.className = 'voice-badge'
      badge.textContent = '🔊'
      badge.title = t().voiceRecognisedTag
      tag.append(badge)
    }

    const input = document.createElement('input')
    input.value = spk[first] ?? ''
    // Suggests the people the app already knows. This is where a person's name is
    // actually typed, meeting after meeting, so it is where "พี่เพิร์ด" gets typed for
    // "พี่เพิร์ช" and becomes a second person — and picking the existing name here is
    // the same merge the hint below already promises for two speakers in one meeting.
    input.setAttribute('list', VOICE_NAMES_LIST)
    input.dataset['speaker'] = first
    // Every key in the group, so a line in the transcript can find the row its own
    // speaker ended up inside (jumpToSpeakerRow).
    input.dataset['keys'] = labels.join(' ')
    input.oninput = () => {
      for (const label of labels) spk[label] = input.value
      onPreview()
    }
    inputs.set(first, input)
    row.append(tag, input)

    // Hear who this is, from the row where you name them. The detail page is already
    // streaming the meeting (openPlayer), so a sample is not a second extraction and a
    // second player — it is a seek. The longest line of theirs, because the shortest is
    // usually "ครับ" and tells you nothing about whose voice it is.
    const longest = playerSegments
      .filter((seg) => labels.includes(seg.speaker))
      .reduce<Transcript['segments'][number] | null>((best, seg) => (!best || seg.t1 - seg.t0 > best.t1 - best.t0 ? seg : best), null)
    if (container === detailSpeakersEl && players.length > 0 && longest) {
      const hear = document.createElement('button')
      hear.className = 'hear-voice'
      hear.textContent = t().speakerHear
      hear.title = t().speakerHearHint
      hear.onclick = () => {
        seekPlayer(longest.t0)
        if (!playing()) void togglePlayer()
      }
      row.append(hear)
    }

    if (linked.length > 0) {
      const wrong = document.createElement('button')
      wrong.className = 'wrong-voice'
      wrong.textContent = t().speakerWrongVoice
      wrong.title = t().speakerWrongVoiceHint
      wrong.onclick = async () => {
        if (!dir) return
        const answer = await window.api.ask(t().speakerWrongTitle(spk[first] ?? first), t().speakerWrongDetail, [
          t().speakerWrongYes,
          t().deleteCancel,
        ])
        if (answer !== 0) return
        wrong.disabled = true
        // Every key under this name, because the report is about the name: the group is
        // the set of clusters currently claimed to be this person, and the claim is what
        // was just called wrong.
        for (const label of linked) await window.api.unlinkSpeaker(dir, label)
        // Emptied rather than deleted: an absent key would take the row out of this
        // editor, and the row is where the correction gets typed. Empty is also what
        // every reader of `speakers` already treats as unnamed — the transcript falls
        // straight back to "Speaker N" (speakerDisplayName) without being told.
        for (const label of labels) spk[label] = ''
        for (const label of labels) if (spkVoices) delete spkVoices[label]
        onSave(spk)
        onPreview()
        renderSpeakerPanel(dir, spk, container, onPreview, onSave, spkVoices)
        container.querySelector<HTMLInputElement>(`input[data-speaker="${CSS.escape(first)}"]`)?.focus()
      }
      row.append(wrong)
    }

    container.append(row)
  }

  const save = document.createElement('button')
  save.textContent = t().speakerSave
  save.onclick = async () => {
    save.disabled = true
    // Expanded back out to one entry per key: the rows are people, but the transcript
    // and everything under it are still keyed by cluster.
    const named: Record<string, string> = {}
    for (const [first, input] of inputs) {
      for (const label of (input.dataset['keys'] ?? first).split(' ')) {
        // Blank stays blank. Falling back to the raw key here used to save a speaker
        // literally called "SPEAKER_18", which then displayed as "SPEAKER_18" instead of
        // the "Speaker N" placeholder an unnamed speaker is supposed to read as.
        named[label] = input.value.trim()
      }
    }
    const result = (await window.api.renameSpeakers(dir, named)).speakers
    onSave(result)
    // Saving here is one of the ways a voice gets a name in the first place, so the
    // suggestions are stale the moment it returns.
    knownVoiceNames = []
    void ensureVoiceNames()
    save.disabled = false
    save.textContent = t().speakerSaved
  }

  const hint = document.createElement('div')
  hint.className = 'hint'
  hint.textContent = t().speakerMergeHint
  const scopeHint = document.createElement('div')
  scopeHint.className = 'hint'
  scopeHint.textContent = t().speakerScopeHint
  container.append(save, hint, scopeHint)
}

/** A button that copies a fixed value and gives the existing copy → copied feedback. */
function copyButton(value: string): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.textContent = t().copy
  btn.onclick = async () => {
    await navigator.clipboard.writeText(value)
    btn.textContent = t().copied
    setTimeout(() => (btn.textContent = t().copy), 1500)
  }
  return btn
}

/** A labelled, code-styled value with its own copy button — the URL row, and the
 * shape every other MCP field below is built from. */
function mcpField(labelText: string, displayText: string, copyValue: string): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'mcp-field'
  const label = document.createElement('span')
  label.className = 'mcp-field-label'
  label.textContent = labelText
  const row = document.createElement('div')
  row.className = 'mcp-code-row'
  const code = document.createElement('code')
  code.className = 'mcp-code'
  code.textContent = displayText
  const actions = document.createElement('div')
  actions.className = 'mcp-code-actions'
  actions.append(copyButton(copyValue))
  row.append(code, actions)
  wrap.append(label, row)
  return wrap
}

const TOKEN_MASK = '••••••••••••'
// Persists across re-renders (language switch, port apply) the same way
// permissionsIncludeScreen does above — an explicit remembered variable rather than
// resetting the user's reveal choice or app pick every time showMcpState re-runs.
let mcpTokenRevealed = false
let mcpConnectApp: 'code' | 'desktop' = 'code'

/** The token never sits on screen in plain text by default — masked here, and
 * everywhere else it appears (the per-app snippets below), until explicitly shown.
 * The copy button always copies the real token regardless of reveal state.
 *
 * `mcpTokenRevealed` is the one source of truth for "is the token revealed"; the
 * reveal button here does not touch its own `code` element directly (that was the
 * HIGH 1 bug — this field and mcpAppPicker's snippet were two closures each
 * re-deriving the mask from the flag independently, so toggling one left the other
 * showing a stale mask). Instead it calls `onToggle`, which re-runs the single
 * render path (renderMcpConnect) that both this field and the snippet are built
 * from, so they can never disagree about whether the token is showing. */
function mcpTokenField(token: string, onToggle: () => void): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'mcp-field'
  const label = document.createElement('span')
  label.className = 'mcp-field-label'
  label.textContent = t().mcpTokenLabel
  const row = document.createElement('div')
  row.className = 'mcp-code-row'
  const code = document.createElement('code')
  code.className = 'mcp-code'
  code.textContent = mcpTokenRevealed ? token : TOKEN_MASK
  const actions = document.createElement('div')
  actions.className = 'mcp-code-actions'
  const reveal = document.createElement('button')
  reveal.textContent = mcpTokenRevealed ? t().mcpTokenHide : t().mcpTokenReveal
  reveal.onclick = onToggle
  actions.append(reveal, copyButton(token))
  row.append(code, actions)
  wrap.append(label, row)
  return wrap
}

/** Claude Code speaks HTTP and can send a header; Claude Desktop and ChatGPT Desktop
 * load local servers over stdio, so they go through a bridge with the token in the
 * URL instead (saves quoting a header inside JSON). One app shown at a time, picked
 * with the same segmented control used elsewhere for a short set of choices — one
 * obvious copy button for whichever app is selected, instead of every app's snippet
 * stacked down the page at once. */
function mcpAppPicker(url: string, token: string): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'mcp-field'

  const label = document.createElement('span')
  label.className = 'mcp-field-label'
  label.textContent = t().mcpConnectAppLabel

  const picker = document.createElement('div')
  picker.className = 'segmented'
  picker.setAttribute('role', 'radiogroup')
  picker.setAttribute('aria-label', t().mcpConnectAppLabel)

  const apps: { key: 'code' | 'desktop'; name: string; steps: () => string; snippet: string }[] = [
    {
      key: 'code',
      name: 'Claude Code',
      steps: () => t().mcpConnectStepsCode,
      snippet: `claude mcp add --scope user --transport http meeting-inspector ${url} --header "Authorization: Bearer ${token}"`,
    },
    {
      key: 'desktop',
      name: 'Claude Desktop / ChatGPT Desktop',
      steps: () => t().mcpConnectStepsDesktop,
      snippet: JSON.stringify(
        { 'meeting-inspector': { command: 'npx', args: ['-y', 'mcp-remote', `${url}${token}`] } },
        null,
        2,
      ),
    },
  ]

  const stepsEl = document.createElement('span')
  stepsEl.className = 'mcp-field-label'
  const row = document.createElement('div')
  row.className = 'mcp-code-row'
  const snippetCode = document.createElement('code')
  snippetCode.className = 'mcp-code'
  const actions = document.createElement('div')
  actions.className = 'mcp-code-actions'
  const copyBtn = document.createElement('button')
  actions.append(copyBtn)
  row.append(snippetCode, actions)

  function renderActive(): void {
    const active = apps.find((a) => a.key === mcpConnectApp) ?? apps[0]!
    stepsEl.textContent = active.steps()
    snippetCode.textContent = mcpTokenRevealed ? active.snippet : active.snippet.split(token).join(TOKEN_MASK)
    copyBtn.textContent = t().copy
    copyBtn.onclick = async () => {
      await navigator.clipboard.writeText(active.snippet)
      copyBtn.textContent = t().copied
      setTimeout(() => (copyBtn.textContent = t().copy), 1500)
    }
  }

  for (const app of apps) {
    const opt = document.createElement('label')
    opt.className = 'segmented-opt'
    const input = document.createElement('input')
    input.type = 'radio'
    input.name = 'mcp-connect-app'
    input.checked = app.key === mcpConnectApp
    input.onchange = () => {
      mcpConnectApp = app.key
      renderActive()
    }
    const span = document.createElement('span')
    span.textContent = app.name
    opt.append(input, span)
    picker.append(opt)
  }
  renderActive()

  wrap.append(label, picker, stepsEl, row)
  return wrap
}

/** The connecting side of the MCP panel — separate from the server card above it,
 * since turning the server on and wiring up a particular app are different concerns
 * (spec item 3). Hidden behind a plain hint until the server actually has a URL and
 * token to hand out. */
function renderMcpConnect(state: McpState): void {
  mcpConnectEl.replaceChildren()
  const ready = Boolean(state.url && state.token)
  mcpConnectOffEl.hidden = ready
  mcpConnectEl.hidden = !ready
  if (!ready || !state.url || !state.token) return
  mcpConnectEl.append(
    mcpField(t().mcpUrlLabel, state.url, state.url),
    mcpTokenField(state.token, () => {
      mcpTokenRevealed = !mcpTokenRevealed
      renderMcpConnect(state)
    }),
    mcpAppPicker(state.url, state.token),
  )
}

// MEDIUM 3: showMcpState used to stomp portInput unconditionally, so any unrelated
// re-render (flipping the MCP toggle, switching language) silently threw away a port
// number the user had typed but not yet saved. `portDirty` tracks "has this input
// diverged from the last state we synced it from" — set on every keystroke, cleared
// once the user's edit is actually the thing that produced the new state (portSave).
// Re-render then only writes portInput.value while it's still in sync with state.
let portDirty = false
portInput.oninput = () => {
  portDirty = true
}

/** Same "hold the data, not the rendered text" treatment as adHocWarning/queueMsg
 * above — an ad-hoc mcpStateEl error used to live only as DOM a stray
 * `replaceChildren()` (from an unrelated toggle or language switch) would erase with
 * no way back short of retriggering the failure. Held here and re-applied by every
 * showMcpState call instead. */
let mcpErrorMsg: string | null = null

function showMcpState(state: McpState): void {
  mcpToggle.checked = state.enabled
  if (!portDirty) portInput.value = String(state.requestedPort)
  mcpStateEl.replaceChildren()
  if (state.portMoved && state.port !== null) {
    const moved = document.createElement('div')
    moved.className = 'warn'
    // Three ways this can land: the requested port was busy and we stepped down to
    // the default (stable, just point clients at it); the requested port WAS the
    // default and busy, so there was only one failed attempt before an ephemeral
    // port (no second "default" to blame); or the requested port and the default
    // were both busy, landing on an ephemeral port after two failed attempts.
    moved.textContent =
      state.port === state.defaultPort
        ? t().portTakenUsingDefault(state.requestedPort, state.port)
        : state.requestedPort === state.defaultPort
          ? t().portTakenUsingAnyIsDefault(state.requestedPort, state.port)
          : t().portTakenUsingAny(state.requestedPort, state.port)
    mcpStateEl.append(moved)
  }
  renderMcpError()
  renderMcpConnect(state)
}

/** The only thing allowed to touch the `.mcperror` box — called after every
 * `mcpStateEl.replaceChildren()` (showMcpState) as well as whenever the message
 * itself changes (showMcpError), so the box's presence always matches `mcpErrorMsg`
 * regardless of which one ran most recently. */
function renderMcpError(): void {
  const box = mcpStateEl.querySelector<HTMLElement>('.mcperror')
  if (!mcpErrorMsg) {
    box?.remove()
    return
  }
  if (box) {
    box.textContent = mcpErrorMsg
    return
  }
  const fresh = document.createElement('div')
  fresh.className = 'warn mcperror'
  fresh.textContent = mcpErrorMsg
  mcpStateEl.prepend(fresh)
}

function showMcpError(message: string): void {
  mcpErrorMsg = message
  renderMcpError()
}

/**
 * The voices the app has learned. Naming a speaker after a meeting teaches it one;
 * this is where you take it back.
 */
/**
 * Every name the app answers to, one row per person. Held here (rather than re-fetched)
 * so the pending-voice rows below can offer the same names as suggestions without a
 * second round trip per row.
 */
let knownVoiceNames: string[] = []

/**
 * Renames a person, and merges two of them when the new name is one that already
 * exists — the same operation from the app's point of view (voices.ts's renameVoices),
 * but not from the user's, so a merge says what it is and asks first. Merging is the
 * whole point: diarization files the same person under a fresh voice every time it
 * fails to recognise them, so "บิว" ends up in the list four times, and a typo'd name
 * is a fifth person until it is renamed onto the right one.
 */
async function renameVoice(from: string, to: string): Promise<void> {
  const trimmed = to.trim()
  if (!trimmed || trimmed === from) return void (await renderVoices())
  if (knownVoiceNames.includes(trimmed)) {
    const answer = await window.api.ask(t().voicesMergeTitle(from, trimmed), t().voicesMergeDetail, [
      t().voicesMergeConfirm,
      t().deleteCancel,
    ])
    if (answer !== 0) return void (await renderVoices())
  }
  await window.api.renameVoice(from, trimmed)
  await renderVoices()
  await renderPendingVoices()
}

async function renderVoices(): Promise<void> {
  const voices = await window.api.knownVoices()
  knownVoiceNames = voices.map((v) => v.name)
  voicesEl.replaceChildren()

  const heading = document.createElement('div')
  heading.className = 'hint'
  heading.textContent = voices.length > 0 ? t().voicesHeading(voices.length) : t().voicesEmpty
  voicesEl.append(heading)

  for (const voice of voices) {
    const row = document.createElement('div')
    row.className = 'voice'

    // An <input>, not a label with an edit button: renaming and merging are the two
    // things this list exists for now, and a name that reads as editable is the whole
    // affordance. The datalist is what makes a merge reachable without retyping — pick
    // the person this one is really the same as.
    const who = document.createElement('input')
    who.className = 'voice-name'
    who.value = voice.name
    who.setAttribute('list', VOICE_NAMES_LIST)
    who.title = t().voicesRenameHint
    who.onkeydown = (e) => {
      if (e.key === 'Enter') who.blur()
      else if (e.key === 'Escape') {
        who.value = voice.name
        who.blur()
      }
    }
    who.onchange = () => void renameVoice(voice.name, who.value)

    // Only said when there is more than one, so the common case stays a plain name.
    const samples = document.createElement('span')
    samples.className = 'voice-samples'
    samples.textContent = voice.samples > 1 ? t().voicesSamples(voice.samples) : ''

    const forget = document.createElement('button')
    forget.textContent = t().voicesForget
    forget.onclick = async () => {
      forget.disabled = true
      await window.api.forgetVoice(voice.name)
      await renderVoices()
    }
    row.append(who, samples, forget)
    voicesEl.append(row)
  }

  renderVoiceNameOptions()
}

/** The id of the one shared <datalist> every name box points at — the Speakers rows and
 * the pending-voice rows all want the same list of people. */
const VOICE_NAMES_LIST = 'voice-names'

/** The datalist is filled by renderVoices() whenever Settings › Speakers is on screen;
 * a meeting opened without ever going there has to fetch the names itself. Cached
 * rather than fetched per render: the speaker panel is rebuilt on every language switch
 * and every save, and the set of names only changes when something in this file changes
 * it (which clears the cache at the same time). */
async function ensureVoiceNames(): Promise<void> {
  if (knownVoiceNames.length > 0) return
  knownVoiceNames = (await window.api.knownVoices()).map((v) => v.name)
  renderVoiceNameOptions()
}

/** Rebuilt whenever the set of names changes; a single element, appended once, because
 * a <datalist> is referenced by id and does not care where in the document it sits. */
function renderVoiceNameOptions(): void {
  let list = document.getElementById(VOICE_NAMES_LIST) as HTMLDataListElement | null
  if (!list) {
    list = document.createElement('datalist')
    list.id = VOICE_NAMES_LIST
    document.body.append(list)
  }
  list.replaceChildren(
    ...knownVoiceNames.map((name) => {
      const option = document.createElement('option')
      option.value = name
      return option
    }),
  )
}

/** Playing a pending voice's sample is one at a time — a second click (this row or
 * another) must stop whatever is already playing rather than overlap it. */
let pendingAudio: HTMLAudioElement | null = null
let pendingAudioUrl: string | null = null
function stopPendingAudio(): void {
  pendingAudio?.pause()
  pendingAudio = null
  if (pendingAudioUrl) {
    URL.revokeObjectURL(pendingAudioUrl)
    pendingAudioUrl = null
  }
}

/** MEDIUM 4: renderPendingVoices rebuilds every row from scratch on every call —
 * including from onDiarized/onBatchDone, background IPC pushes that can land at any
 * moment while this panel is open — and an unconditional `replaceChildren()` was
 * throwing away whatever anyone had typed but not yet saved in *any* row, not just
 * the one that triggered the re-render. Same shape as the `adHocWarning`/`queueMsg`
 * fix above: hold the data outside the DOM instead of trusting the DOM to survive a
 * rebuild it doesn't know is coming. Keyed by voice id so a rebuild is lossless
 * regardless of which of the three call sites triggered it. */
const pendingVoiceDrafts = new Map<string, string>()

/**
 * Voices diarization has clustered but nobody has named yet (spec item 1). Each row
 * lets the user hear the voice before deciding what to call it (spec item 2) — the
 * sample comes back from main as raw WAV bytes (never a file path the renderer could
 * point anywhere) and is played from a Blob URL, which CSP's `media-src ... blob:`
 * already allows. Naming one here removes it from this list and, via voices.ts's
 * resolveSpeakerNames, updates every meeting that already recognised it (spec item 3)
 * — nothing on disk to walk or rewrite.
 */
async function renderPendingVoices(): Promise<void> {
  const items = await window.api.pendingVoices()
  stopPendingAudio()
  pendingVoicesEl.replaceChildren()

  // Drop drafts for ids that are no longer pending (named, or otherwise gone) so the
  // map doesn't grow forever.
  const liveIds = new Set(items.map((i) => i.id))
  for (const id of pendingVoiceDrafts.keys()) if (!liveIds.has(id)) pendingVoiceDrafts.delete(id)

  const heading = document.createElement('div')
  heading.className = 'hint'
  heading.textContent = items.length > 0 ? t().pendingHeading(items.length) : t().pendingEmpty
  pendingVoicesEl.append(heading)

  for (const item of items) {
    const row = document.createElement('div')
    row.className = 'pending-voice'

    const meta = document.createElement('div')
    meta.className = 'hint'
    meta.textContent = t().pendingHeard(item.meetingTitle, fmtMeetingWhen(item.at))
    row.append(meta)

    if (item.text) {
      const said = document.createElement('div')
      said.textContent = `${t().pendingSaidLabel}${item.text}`
      row.append(said)
    }

    const controls = document.createElement('div')
    controls.className = 'who'

    const play = document.createElement('button')
    play.textContent = t().pendingPlay
    play.onclick = async () => {
      stopPendingAudio()
      play.disabled = true
      play.textContent = t().pendingPlaying
      const sample = await window.api.voiceSample(item.id)
      const reset = () => {
        play.disabled = false
        play.textContent = t().pendingPlay
      }
      if (!sample) {
        play.textContent = t().pendingNoSample
        play.disabled = false
        setTimeout(reset, 1500)
        return
      }
      // Re-wrapped rather than passed straight through: the value that survives IPC
      // types as Uint8Array<ArrayBufferLike> (it could in principle back onto a
      // SharedArrayBuffer), which Blob's constructor does not accept — a fresh
      // Uint8Array always backs onto a plain ArrayBuffer.
      const url = URL.createObjectURL(new Blob([new Uint8Array(sample)], { type: 'audio/wav' }))
      pendingAudioUrl = url
      const audio = new Audio(url)
      pendingAudio = audio
      audio.onended = () => {
        reset()
        stopPendingAudio()
      }
      audio.onerror = () => {
        reset()
        stopPendingAudio()
      }
      await audio.play().catch(reset)
    }

    const input = document.createElement('input')
    input.placeholder = t().pendingNamePlaceholder
    // Suggests the people the app already knows: naming this voice with one of their
    // names is what "this is the same person" means here, and typing it out from memory
    // is exactly how "พี่เพิร์ด" ends up beside "พี่เพิร์ช" as a separate person.
    input.setAttribute('list', VOICE_NAMES_LIST)
    input.title = t().voicesRenameHint
    input.value = pendingVoiceDrafts.get(item.id) ?? ''
    input.oninput = () => pendingVoiceDrafts.set(item.id, input.value)

    const save = document.createElement('button')
    save.textContent = t().pendingSave
    save.onclick = async () => {
      const name = input.value.trim()
      if (!name) return
      save.disabled = true
      pendingVoiceDrafts.delete(item.id)
      await window.api.nameVoice(item.id, name)
      await renderPendingVoices()
      await renderVoices()
    }

    // Sits beside Save because it answers the same question the row is asking ("who is
    // this?") with the other honest answer: nobody. Without it an unnamed cluster could
    // only be cleared by naming it, so a burst of room noise stayed on this list for good.
    const discard = document.createElement('button')
    discard.textContent = t().pendingDiscard
    discard.title = t().pendingDiscardHint
    discard.className = 'danger'
    discard.onclick = async () => {
      discard.disabled = true
      pendingVoiceDrafts.delete(item.id)
      await window.api.discardVoice(item.id)
      await renderPendingVoices()
    }

    controls.append(play, input, save, discard)
    row.append(controls)
    pendingVoicesEl.append(row)
  }
}

/**
 * Lets someone hear what the noise setting does to their own room before a meeting
 * depends on it. Live meter, a live verdict from the same gate the recorder uses,
 * and what actually survives to the transcript.
 */
let micStop: (() => void) | null = null
let micFrames: Float32Array[] = []
let micProbes = { checks: 0, heard: 0, loudest: 0 }

/**
 * Thai regardless of the interface language — it is the transcriber being tested,
 * and the transcriber is set to Thai. The two English terms are the point: whether
 * they survive is what the vocabulary prompt exists for.
 */
const MIC_TEST_SENTENCE = 'วันนี้เราจะคุยเรื่อง deploy กับ migration ของฐานข้อมูลครับ'
const MIC_TEST_TERMS = ['deploy', 'migration']

const line = (label: string, text: string, dim = false): HTMLElement => {
  const row = document.createElement('div')
  if (dim) row.className = 'hint'
  const name = document.createElement('span')
  name.className = 'rowlabel'
  name.textContent = `${label}: `
  row.append(name, document.createTextNode(text))
  return row
}

const LEVELS = ['low', 'medium', 'high'] as const

/**
 * Turns the test into an answer rather than a reading. How often the gate counted
 * the voice, and whether anything reached the transcript, is what decides whether
 * this level suits this room.
 */
function micVerdict(text: string): { message: string; move?: 'low' | 'medium' | 'high' } {
  const pct = micProbes.checks > 0 ? Math.round((micProbes.heard / micProbes.checks) * 100) : 0
  const index = LEVELS.indexOf(noiseSelect.value as (typeof LEVELS)[number])
  const softer = LEVELS[index - 1]
  const harder = LEVELS[index + 1]

  // A silent microphone is not a filter problem, and telling someone to lower the
  // setting would send them the wrong way entirely.
  if (micProbes.loudest < 0.01) return { message: t().micVerdictQuiet }
  // Already at the most permissive level: lowering is not on offer, so the advice
  // has to be about the microphone instead of the setting.
  if (!text.trim()) {
    const message = `${t().micTestNothing} ${softer ? t().micVerdictTooStrict(pct) : t().micVerdictQuiet}`
    return { message, move: softer }
  }
  if (pct < 50) {
    return softer ? { message: t().micVerdictPatchy(pct), move: softer } : { message: t().micVerdictPatchy(pct) }
  }
  return { message: `${t().micVerdictGood(pct)} ${harder ? t().micVerdictTryStricter : ''}`.trim(), move: undefined }
}

/** The final verdict block (transcript comparison + move-a-level button) is the one
 * piece of `micHeard` a language switch must be able to re-derive — `micVerdict` is
 * pure over `micProbes` (already module state) and this stored transcript, so no
 * further state is needed. The transient "listening…"/"…"/too-quiet lines elsewhere
 * in this file are fine as plain text: they get overwritten every probe tick anyway. */
let micTestText: string | null = null

function renderMicHeard(): void {
  micHeard.replaceChildren()
  const text = micTestText
  if (text === null) return
  const { message, move } = micVerdict(text)
  if (text.trim()) {
    // Both sentences, together. Whether the transcription is any good is a
    // comparison, and clearing the prompt made that impossible to see.
    micHeard.append(line(t().micTestExpected, MIC_TEST_SENTENCE, true))
    micHeard.append(line(t().micTestGot, text.trim()))
    const lower = text.toLowerCase()
    const found = MIC_TEST_TERMS.filter((term) => lower.includes(term))
    micHeard.append(line('', t().micTestTerms(found, MIC_TEST_TERMS.filter((term) => !found.includes(term))), true))
  }
  const verdict = document.createElement('div')
  verdict.textContent = message
  micHeard.append(verdict)
  if (move) {
    const fix = document.createElement('button')
    const goingDown = LEVELS.indexOf(move) < LEVELS.indexOf(noiseSelect.value as (typeof LEVELS)[number])
    fix.textContent = goingDown ? t().micLower : t().micRaise
    fix.onclick = async () => {
      noiseSelect.value = move
      noiseSelect.dispatchEvent(new Event('change'))
      micTestText = null
      renderMicHeard()
    }
    micHeard.append(fix)
  }
}

/** Forced stop — used when Settings closes or navigates away from the Recording
 * category while a test is running (MEDIUM 4). Unlike the manual stop below, nobody
 * is looking at the panel any more, so this skips the final transcribe-and-verdict
 * round trip and just releases the mic. */
function stopMicTest(): void {
  if (!micStop) return
  micStop()
  micStop = null
  micFrames = []
  micToggle.textContent = t().micTest
  micLine.textContent = ''
  micVerdictEl.textContent = ''
  micVerdictEl.className = ''
  micLevel.className = ''
  micLevel.style.width = '0%'
  void window.api.endMicTest()
}

async function toggleMicTest(): Promise<void> {
  if (micStop) {
    micStop()
    micStop = null
    micToggle.textContent = t().micTest
    micLine.textContent = ''
    micVerdictEl.textContent = ''
    micVerdictEl.className = ''
    micLevel.className = ''
    micLevel.style.width = '0%'

    const total = micFrames.reduce((n, f) => n + f.length, 0)
    const all = new Int16Array(total)
    let at = 0
    for (const f of micFrames) for (const v of f) all[at++] = Math.max(-1, Math.min(1, v)) * 32767
    micFrames = []
    if (total > 16000) {
      micHeard.textContent = '…'
      // main can refuse this (micTestLocked, index.ts) — e.g. a batch pass started
      // from the main view while this test was already open. Without a catch here the
      // rejection propagated straight out of this handler, raw, AND skipped
      // endMicTest() below, leaving whisper-server held for a mic test the user had
      // already stopped.
      try {
        micTestText = await window.api.transcribeMic(all.buffer as ArrayBuffer)
        renderMicHeard()
      } catch (err) {
        micHeard.textContent = t().micTestFailed(reason(err))
      }
    }
    void window.api.endMicTest()
    return
  }

  micTestText = null
  micHeard.replaceChildren()
  micFrames = []
  micProbes = { checks: 0, heard: 0, loudest: 0 }
  try {
    micStop = await openMicTap((frame) => {
      micFrames.push(frame)
      let sum = 0
      for (const v of frame) sum += v * v
      const rms = Math.sqrt(sum / frame.length)
      micProbes.loudest = Math.max(micProbes.loudest, rms)
      setMicLevel(rms)
    })
  } catch (err) {
    micHeard.textContent = reason(err)
    return
  }
  micToggle.textContent = t().micTestStop
  micLine.textContent = `${t().micTestPrompt}: ${MIC_TEST_SENTENCE}`
  void probeLoop()
}

function setMicLevel(rms: number): void {
  micLevel.style.width = `${Math.min(100, Math.sqrt(rms) * 180)}%`
}

const toPcm = (frames: Float32Array[]): Int16Array => {
  const total = frames.reduce((n, f) => n + f.length, 0)
  const pcm = new Int16Array(total)
  let at = 0
  for (const f of frames) for (const v of f) pcm[at++] = Math.max(-1, Math.min(1, v)) * 32767
  return pcm
}

/**
 * Twice a second for the verdict and the bar; every few seconds it also transcribes
 * what was just said, because waiting until stop to find out whether your words
 * survived makes the setting impossible to tune by ear.
 */
async function probeLoop(): Promise<void> {
  let ticks = 0
  let transcribing = false
  while (micStop) {
    ticks += 1
    const recent = micFrames.slice(-20)
    const total = recent.reduce((n, f) => n + f.length, 0)

    // Say it while it is still fixable, rather than in the summary afterwards.
    if (ticks > 6 && micProbes.loudest < 0.01) micHeard.textContent = t().micTooQuiet

    // Every four seconds, show what the last few seconds actually transcribed to.
    if (ticks % 8 === 0 && !transcribing && micProbes.heard > 0) {
      const recentPcm = toPcm(micFrames.slice(-40))
      if (recentPcm.length > 16000) {
        transcribing = true
        void window.api
          .transcribeMic(recentPcm.buffer as ArrayBuffer)
          .then((said) => {
            if (micStop && said.trim()) micHeard.textContent = `${t().micTestGot}: ${said.trim()}`
          })
          .catch(() => {})
          .finally(() => {
            transcribing = false
          })
      }
    }

    if (total > 16000) {
      const pcm = toPcm(recent)
      const speech = await window.api.probeMic(pcm.buffer as ArrayBuffer).catch(() => false)
      if (!micStop) break
      micProbes.checks += 1
      if (speech) micProbes.heard += 1
      const level = Math.round(Math.min(1, Math.sqrt(micProbes.loudest) * 1.8) * 100)
      micVerdictEl.textContent = `${speech ? t().micTestSpeech : t().micTestDropped} · ${t().micLevelNow(level)}`
      micVerdictEl.className = speech ? 'speech' : 'dropped'
      // The bar itself says whether this is counted, so the level and the verdict
      // are one thing to watch rather than two.
      micLevel.className = speech ? 'speech' : ''
    }
    await new Promise((r) => setTimeout(r, 500))
  }
}

function setLevel(track: Track, rms: number): void {
  // sqrt curve: speech sits low on a linear scale and the bar would look dead.
  meters[track].style.width = `${Math.min(100, Math.sqrt(rms) * 180)}%`
}

async function start(): Promise<void> {
  doneState = null
  renderDone()
  speakerPanel.replaceChildren()
  segments = []
  // 'after'/'manual' modes: say so up front rather than leaving the panel looking
  // broken until segments land — which, in 'manual' mode, only happens once the user
  // picks this meeting from the meetings list.
  transcript.textContent =
    getTranscribeMode() === 'after'
      ? t().transcribeAfterPlaceholder
      : getTranscribeMode() === 'manual'
        ? t().transcribeManualPlaceholder
        : ''
  speakers = { ...t().speakerDefaults }
  speakerVoices = undefined
  meetingDir = null
  await window.api.requestPermissions()
  toggle.disabled = true
  try {
    const started = await Recorder.start(title.value, {
      onLevel: setLevel,
      onTrackLost: (track) => {
        setWarning({ text: () => t().trackLost(track) })
      },
    })
    recorder = started.recorder
    updateTranscriptionLocks()
  } catch (err) {
    const msg = reason(err)
    adHocWarning = { text: () => t().startFailed(msg) }
    await renderWarnings(true)
    return
  } finally {
    toggle.disabled = false
  }

  recordedMs = 0
  recordingSince = Date.now()
  ticker = window.setInterval(() => {
    elapsed.textContent = fmt(recordedSec())
    miniTimeEl.textContent = elapsed.textContent
  }, 500)
  elapsed.textContent = fmt(0)
  renderRecordingControls()
  title.disabled = true
  setWarning(null)
  document.body.classList.add('recording')
}

async function stop(): Promise<void> {
  const r = recorder
  recorder = null
  clearInterval(ticker)
  toggle.disabled = true
  // stop() only resolves once the queued tail chunks have come back and the
  // transcript is on disk, which can take a chunk or two.
  doneState = { kind: 'pending' }
  renderDone()
  // recorder is already null above, but session:stop's own offline pass ('after' mode)
  // is still running in main for the whole span of this await — doneState.kind ===
  // 'pending' is what transcriptionBusy() reads to keep the lock on through it.
  updateTranscriptionLocks()
  const result = await r?.stop()
  document.body.classList.remove('recording')
  toggle.disabled = false
  title.disabled = false
  recordedMs = 0
  recordingSince = null
  renderRecordingControls()
  elapsed.textContent = ''
  for (const track of ['loopback', 'mic'] as const) setLevel(track, 0)
  if (!result) {
    doneState = null
    renderDone()
    updateTranscriptionLocks()
    return
  }

  meetingDir = result.dir
  doneState = { kind: 'saved', durationSec: result.durationSec, segments: result.segments, dir: result.dir, id: result.id }
  renderDone()
  updateTranscriptionLocks()
  void renderMeetings() // the meeting just finished now belongs in the list too
}

/**
 * The meetings list (spec item 3/5) — every recorded meeting, with checkboxes for
 * picking several to transcribe at once while the user is away from the app. Rendered
 * into two places (spec item b: the main page's 5-most-recent preview, and the full
 * All Meetings page) from the same data and the same row-building code — one
 * `MeetingsPanel` per container, keyed the way `bars` (the model-download bar) keys its
 * DOM refs per container, so a re-render of one container never blanks the other's.
 */
type MeetingsPanel = {
  listEl: HTMLElement
  selectAllBtn: HTMLButtonElement
  selectNoneBtn: HTMLButtonElement
  transcribeBtn: HTMLButtonElement
  deleteBtn: HTMLButtonElement
  stopBtn: HTMLButtonElement
  progressEl: HTMLElement
  retranscribeHintEl: HTMLElement
  /** id -> that row's status <span>, so a live batch percentage (onBatchProgress fires
   * once per ~1MB chunk) can update just the one row in flight instead of rebuilding
   * every row on every tick. */
  statusEls: Map<string, HTMLElement>
  /** Main page shows only the 5 most recent (spec item a); All Meetings shows all of them. */
  limit: number | null
}
const mainMeetingsPanel: MeetingsPanel = {
  listEl: meetingsListEl,
  selectAllBtn: meetingsSelectAllBtn,
  selectNoneBtn: meetingsSelectNoneBtn,
  transcribeBtn: meetingsTranscribeBtn,
  deleteBtn: meetingsDeleteBtn,
  stopBtn: meetingsStopBtn,
  progressEl: meetingsProgressEl,
  retranscribeHintEl: meetingsRetranscribeHintEl,
  statusEls: new Map(),
  limit: 5,
}
const allMeetingsPanelState: MeetingsPanel = {
  listEl: allMeetingsListEl,
  selectAllBtn: allMeetingsSelectAllBtn,
  selectNoneBtn: allMeetingsSelectNoneBtn,
  transcribeBtn: allMeetingsTranscribeBtn,
  deleteBtn: allMeetingsDeleteBtn,
  stopBtn: allMeetingsStopBtn,
  progressEl: allMeetingsProgressEl,
  retranscribeHintEl: allMeetingsRetranscribeHintEl,
  statusEls: new Map(),
  limit: null,
}
const meetingsPanels = [mainMeetingsPanel, allMeetingsPanelState]

let meetingItems: MeetingItem[] = []
const selectedMeetings = new Set<string>()
let batchRunning = false
/** The one meeting the batch queue is actually working on right now (transcribing or
 * diarizing), and the live text to show on its row — thunk, not a rendered string, the
 * same reason every other reactive-to-language message in this file is (see
 * `adHocWarning`'s doc comment): a language switch must be able to re-derive it. */
let activeBatchId: string | null = null
let activeBatchText: (() => string) | null = null

const meetingSelectable = (m: MeetingItem): boolean => m.status === 'not-transcribed' || m.status === 'failed'
/** A done meeting is deliberately NOT selectable (below, meetingPickable is what a
 * checkbox actually gates) — re-running it is a real cost (meetingsRetranscribeWarning
 * below), so it must be a choice, not something "Select all" sweeps in (spec item c). */
const meetingRetranscribable = (m: MeetingItem): boolean => m.status === 'done'
const meetingPickable = (m: MeetingItem): boolean => meetingSelectable(m) || meetingRetranscribable(m)

function fmtMeetingWhen(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(lang === 'th' ? 'th-TH' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' })
}

/**
 * Swaps a row's title for a text box, in place. Deliberately not a prompt() or a modal:
 * a rename is a correction to something already on screen, and the row it belongs to is
 * the clearest place to make it.
 *
 * `saved` guards the two ways out that can both fire for one edit — Enter also blurs
 * the input — so a rename is never sent twice. Escape restores the row without asking
 * main anything; anything else (Enter, clicking away) commits, and an unchanged or
 * blank-but-unchanged title is a no-op main will hand straight back (renameMeeting).
 */
function startTitleEdit(row: HTMLElement, title: HTMLElement, m: MeetingItem): void {
  const input = document.createElement('input')
  input.className = 'meeting-title meeting-title-edit'
  input.value = m.title
  let saved = false
  const commit = (next: string | null): void => {
    if (saved) return
    saved = true
    if (next === null || next.trim() === m.title) void renderMeetings()
    else void renameMeetingRow(m.id, next)
  }
  input.onkeydown = (e) => {
    if (e.key === 'Enter') commit(input.value)
    else if (e.key === 'Escape') commit(null)
  }
  input.onblur = () => commit(input.value)
  row.replaceChild(input, title)
  input.focus()
  input.select()
}

/** macOS's own default double-click interval. Long enough that a deliberate double
 * click always beats it, short enough that opening a transcript still feels immediate. */
const DOUBLE_CLICK_MS = 250

function renderMeetingRowsInto(panel: MeetingsPanel): void {
  panel.statusEls.clear()
  const items = panel.limit === null ? meetingItems : meetingItems.slice(0, panel.limit)
  panel.listEl.replaceChildren(
    ...items.map((m) => {
      const row = document.createElement('div')
      row.className = 'meeting-row'

      const checkbox = document.createElement('input')
      checkbox.type = 'checkbox'
      checkbox.disabled = !meetingPickable(m) || batchRunning
      checkbox.checked = selectedMeetings.has(m.id)
      checkbox.onchange = () => {
        if (checkbox.checked) selectedMeetings.add(m.id)
        else selectedMeetings.delete(m.id)
        updateMeetingsActions()
      }

      // A done meeting's title doubles as the way into its transcript (spec item 1) —
      // a real <button> only when there is something to open, a plain <span> otherwise,
      // so a not-yet/still-transcribing/failed row is not a dead-looking control.
      const openable = m.status === 'done'
      const title = document.createElement(openable ? 'button' : 'span')
      title.className = openable ? 'meeting-title meeting-title-open' : 'meeting-title'
      title.textContent = m.title
      title.title = t().meetingRenameHint
      // One target, two gestures — single click opens the transcript, double click
      // renames in place. Opening is held for DOUBLE_CLICK_MS so the second click still
      // has a row to land on: without the wait the first click swaps the whole page out
      // from under it, the second lands on the detail page instead, and `dblclick` never
      // fires at all (confirmed in the built app, not reasoned about). The same trade
      // Finder makes for click-to-select vs. double-click-to-open. A row that cannot be
      // opened has no such conflict and renames on the spot.
      let openTimer: number | undefined
      if (openable) {
        ;(title as HTMLButtonElement).type = 'button'
        title.onclick = () => {
          window.clearTimeout(openTimer)
          openTimer = window.setTimeout(() => void openMeetingDetail(m.id), DOUBLE_CLICK_MS)
        }
      }
      title.ondblclick = (e) => {
        e.preventDefault()
        window.clearTimeout(openTimer)
        if (batchRunning) return
        startTitleEdit(row, title, m)
      }

      const when = document.createElement('span')
      when.className = 'meeting-when'
      when.textContent = fmtMeetingWhen(m.startedAt)

      const dur = document.createElement('span')
      dur.className = 'meeting-dur'
      dur.textContent = fmt(m.durationSec)

      // Which language this meeting will be (or was) decoded in — so picking a meeting
      // recorded under an old setting to transcribe now is an informed choice, not a
      // surprise (spec item 1).
      const language = document.createElement('span')
      language.className = 'meeting-lang'
      language.textContent = t().meetingLangName[m.language]

      const status = document.createElement('span')
      status.className = `meeting-status ${m.status}`
      status.textContent = m.id === activeBatchId && activeBatchText ? activeBatchText() : t().meetingsStatus[m.status]
      panel.statusEls.set(m.id, status)

      row.append(checkbox, title, when, dur, language, status)
      return row
    }),
  )
  if (items.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'hint'
    empty.textContent = t().meetingsEmpty
    panel.listEl.append(empty)
  }
}

function renderMeetingRows(): void {
  for (const panel of meetingsPanels) renderMeetingRowsInto(panel)
  meetingsViewAllBtn.hidden = mainMeetingsPanel.limit === null || meetingItems.length <= mainMeetingsPanel.limit
  meetingsViewAllBtn.textContent = t().viewAllMeetings(meetingItems.length)
}

/** Pushes this batch tick straight onto whichever row is already on screen, in either
 * panel, instead of waiting for the next full renderMeetings() — cheap enough to call
 * on every progress event (onBatchProgress fires roughly once per 1MB read). */
function updateActiveRowStatus(): void {
  if (!activeBatchId || !activeBatchText) return
  for (const panel of meetingsPanels) {
    const el = panel.statusEls.get(activeBatchId)
    if (el) el.textContent = activeBatchText()
  }
}

/** Puts a row back to its plain disk-derived status text — used when the diarize loop
 * moves on to the next meeting (below), since nothing else re-renders that row in the
 * meantime: onBatchItem's own renderMeetings() only covers the transcribe phase, and
 * batch:diarizing carries just one id at a time, not "and here is what to undo". Without
 * this, a meeting's row stays on "Working out who's speaking…" forever after its own
 * turn ends, confirmed live — every finished meeting piled up the same stale text until
 * the whole queue's batch:done finally forced a full re-render. */
function resetRowToBaseStatus(id: string): void {
  const m = meetingItems.find((x) => x.id === id)
  if (!m) return
  for (const panel of meetingsPanels) {
    const el = panel.statusEls.get(id)
    if (el) el.textContent = t().meetingsStatus[m.status]
  }
}

/**
 * Mirrors index.ts's `transcriptionBusy`/`micTestLocked` guards (spec item 2): a live
 * recording, session:stop's own offline pass (still ongoing while `doneState` reads
 * 'pending' — recorder is already null by then, see stop()), or a running batch, are
 * all main-side reasons a pass-disturbing setting would be refused. Kept in one place
 * so every call site below agrees on what "busy" means.
 */
function transcriptionBusy(): boolean {
  return recorder !== null || doneState?.kind === 'pending' || batchRunning
}

/**
 * Disables the controls transcriptionBusy() above would otherwise let the user click
 * only to have main refuse — with a reason shown, not just a dead control (spec item
 * 2). Called wherever recorder/doneState/batchRunning changes, and once more on every
 * language switch so the reason text re-renders in the right language.
 */
function updateTranscriptionLocks(): void {
  const busy = transcriptionBusy()
  noiseSelect.disabled = busy
  noiseHint.textContent = busy ? t().noiseLockedHint : (t().noiseHint[noiseSelect.value] ?? '')
  // Only the batch case is disabled proactively — whether a non-live *recording*
  // blocks the mic test depends on which mode that particular recording started in,
  // and the mode selector stays free to change mid-recording (spec item 2's own
  // "safe to change mid-run" list), so the renderer cannot always predict it in
  // advance. Main is the source of truth there; toggleMicTest handles that rejection
  // instead of trying to guess it here. `!micStop` is just a safety net — batchRunning
  // cannot actually turn true while a mic test is open (mic test only lives in
  // Settings, and the meetings-list Transcribe button only lives in the main view,
  // hidden while Settings is open), so a test in progress should never be found here.
  micToggle.disabled = batchRunning && !micStop
  micTestLockHint.textContent = batchRunning ? t().micTestLockedReason : ''

  // MEDIUM 2: onboarding has no cancel of its own, and Start/Stop, the batch queue,
  // the timer, and the meters all live in #main-view, which onboarding hides — so
  // "Run setup again" is locked out here instead, the same way the mic test above is
  // locked out for a running batch. Recording is included (unlike micToggle's own
  // lock, which only cares about a batch) because a live recording is exactly the
  // other way into this trap: Start, then Settings › General › "Run setup again".
  onboardingRerunBtn.disabled = busy
  onboardingRerunLockHint.textContent = busy ? t().onboardingRerunLockedReason : ''

  // The update card is locked for the same reason (it replaces the app doing the work),
  // and says so from renderUpdate — which has to run again whenever `busy` changes.
  renderUpdate()
}

function updateMeetingsActionsFor(panel: MeetingsPanel): void {
  // Labels, not just disabled/hidden — this is the only place these buttons' text ever
  // gets set, so it has to run on first paint (called from renderMeetings(), itself
  // called from applyLanguage() at boot) and again on every language switch.
  panel.selectAllBtn.textContent = t().meetingsSelectAll
  panel.selectNoneBtn.textContent = t().meetingsSelectNone
  panel.stopBtn.textContent = t().meetingsStop
  panel.selectAllBtn.disabled = batchRunning
  panel.selectNoneBtn.disabled = batchRunning || selectedMeetings.size === 0
  panel.transcribeBtn.disabled = batchRunning || selectedMeetings.size === 0
  panel.transcribeBtn.textContent = t().meetingsTranscribe(selectedMeetings.size)
  panel.deleteBtn.disabled = batchRunning || selectedMeetings.size === 0
  panel.deleteBtn.textContent = t().meetingsDelete(selectedMeetings.size)
  panel.stopBtn.hidden = !batchRunning
  // Spec item c: say the cost before the click, not after — how many of what's
  // currently selected are a done meeting being deliberately re-run.
  const doneSelected = meetingItems.filter((m) => selectedMeetings.has(m.id) && m.status === 'done').length
  panel.retranscribeHintEl.textContent = doneSelected > 0 ? t().meetingsRetranscribeWarning(doneSelected) : ''
}
function updateMeetingsActions(): void {
  for (const panel of meetingsPanels) updateMeetingsActionsFor(panel)
}

/** Refetches the list from disk — cheap (a directory walk + small JSON reads), called
 * after every meeting the batch queue finishes so statuses stay current without
 * polling. */
async function renderMeetings(): Promise<void> {
  meetingItems = await window.api.listMeetings()
  for (const id of [...selectedMeetings]) {
    const m = meetingItems.find((x) => x.id === id)
    if (!m || !meetingPickable(m)) selectedMeetings.delete(id)
  }
  meetingsHeadingEl.textContent = t().meetingsHeading
  allMeetingsBackLabel.textContent = t().settingsBack
  allMeetingsTitleEl.textContent = t().allMeetingsTitle
  renderMeetingRows()
  updateMeetingsActions()
}

for (const panel of meetingsPanels) {
  // Select all deliberately only ever grabs meetingSelectable, not meetingPickable —
  // a done meeting must never get swept in (spec item c).
  panel.selectAllBtn.onclick = () => {
    for (const m of meetingItems) if (meetingSelectable(m)) selectedMeetings.add(m.id)
    renderMeetingRows()
    updateMeetingsActions()
  }
  panel.selectNoneBtn.onclick = () => {
    selectedMeetings.clear()
    renderMeetingRows()
    updateMeetingsActions()
  }
  panel.transcribeBtn.onclick = async () => {
    if (selectedMeetings.size === 0) return
    batchRunning = true
    batchModelMissing = false
    activeBatchId = null
    activeBatchText = null
    renderMeetingsProgress('')
    renderMeetingRows()
    updateMeetingsActions()
    updateTranscriptionLocks()
    try {
      await window.api.transcribeMeetings([...selectedMeetings])
    } catch (err) {
      batchRunning = false
      renderMeetingsProgress(reason(err))
      renderMeetingRows()
      updateMeetingsActions()
      updateTranscriptionLocks()
    }
  }
  panel.deleteBtn.onclick = () => void deleteSelectedMeetings()
  panel.stopBtn.onclick = () => {
    // MEDIUM 5: immediate, honest feedback — diarizing a meeting cannot be interrupted
    // mid-pass (diarize.ts), so without this the button gave no sign it had registered
    // the click until batch:done eventually arrived, possibly minutes later, and read
    // as hung in the meantime.
    renderMeetingsProgress(t().meetingsStopping)
    void window.api.cancelTranscribeMeetings()
  }
}

/**
 * Deleting a recording is the one thing in this app that cannot be undone, so what
 * gets asked depends on what is actually at stake — and everything is asked BEFORE
 * anything is deleted, so backing out of the second question does not leave the first
 * question's meetings already gone.
 *
 * A meeting that was never transcribed has nothing but its audio: deleting it deletes
 * everything there ever was of it, and there is no "keep the transcript" version of
 * that choice (store.ts's deleteMeeting doc comment) — hence two confirmations and the
 * whole folder.
 *
 * A transcribed one keeps its words either way, so its question is the useful one:
 * the audio is most of the disk space and nothing reads it again, so is the transcript
 * going too?
 */
async function deleteSelectedMeetings(): Promise<void> {
  const chosen = meetingItems.filter((m) => selectedMeetings.has(m.id))
  if (chosen.length === 0) return
  const undone = chosen.filter((m) => m.status !== 'done')
  const done = chosen.filter((m) => m.status === 'done')

  if (undone.length > 0) {
    const first = await window.api.ask(t().deleteUndoneTitle(undone.length), t().deleteUndoneDetail, [t().deleteConfirm, t().deleteCancel])
    if (first !== 0) return
    const second = await window.api.ask(t().deleteUndoneConfirmTitle, t().deleteUndoneConfirmDetail, [t().deleteConfirm, t().deleteCancel])
    if (second !== 0) return
  }

  let keepTranscripts = false
  if (done.length > 0) {
    const answer = await window.api.ask(t().deleteDoneTitle(done.length), t().deleteDoneDetail, [
      t().deleteAudioOnly,
      t().deleteEverything,
      t().deleteCancel,
    ])
    if (answer === 2) return
    keepTranscripts = answer === 0
  }

  try {
    // Two calls, because the two groups answered different questions — the untranscribed
    // ones never had a "keep the transcript" option to choose.
    if (undone.length > 0) await window.api.deleteMeetings(undone.map((m) => m.id), false)
    if (done.length > 0) await window.api.deleteMeetings(done.map((m) => m.id), keepTranscripts)
    selectedMeetings.clear()
    renderMeetingsProgress('')
  } catch (err) {
    renderMeetingsProgress(t().deleteFailed(reason(err)))
  }
  await renderMeetings()
}

/**
 * Renames a saved meeting in place, from the row itself (double-click its title). The
 * title lives in the folder name, so main moves the folder and the meeting's id changes
 * with it — which is why the selection is retargeted at the id that comes back rather
 * than left pointing at one that no longer exists.
 */
async function renameMeetingRow(id: string, title: string): Promise<void> {
  try {
    const next = await window.api.setMeetingTitle(id, title)
    if (next !== id && selectedMeetings.delete(id)) selectedMeetings.add(next)
    renderMeetingsProgress('')
  } catch (err) {
    renderMeetingsProgress(t().renameFailed(reason(err)))
  }
  await renderMeetings()
}

/** Same "text + optional action" shape as the ad-hoc warning box above, for the one
 * spot in the meetings panel that can also be caused by a missing model. Writes into
 * both panels' progress line — there is only ever one batch running, so both copies
 * should always agree regardless of which page is on screen. */
function renderMeetingsProgress(text: string, action?: () => void): void {
  for (const panel of meetingsPanels) {
    panel.progressEl.replaceChildren(document.createTextNode(text))
    if (!action) continue
    const button = document.createElement('button')
    button.textContent = t().modelsGoToSettings
    button.onclick = action
    panel.progressEl.append(document.createElement('br'), button)
  }
}

// Set on any 'failed' batch item whose error names a missing model (isModelMissing) —
// the per-row status already says "Failed — try again" (meetingsStatus.failed), but
// retrying without the model is a dead end, so onBatchDone below replaces the normal
// idle/cancelled line with something that actually explains why and where to fix it.
let batchModelMissing = false

window.api.onBatchItem((item: BatchItem) => {
  if (item.status === 'failed' && item.error && isModelMissing(item.error)) batchModelMissing = true
  // A meeting stops being "the one in flight" the moment its own item event says so —
  // unless it is about to enter the diarize phase, which sends its own batch:diarizing
  // and reclaims activeBatchId then. Without this, a meeting that finished with nothing
  // left to diarize would keep showing its last "Transcribing… 100%" text forever,
  // since disk truth alone (meeting:list) has no percentage to replace it with.
  if (item.status !== 'running' && activeBatchId === item.id) {
    activeBatchId = null
    activeBatchText = null
  }
  if (item.status === 'running') {
    activeBatchId = item.id
    activeBatchText = null
  }
  // The status change (running/done/failed/cancelled) is worth a fresh read from disk —
  // a progress tick alone is not, see onBatchProgress below.
  void renderMeetings()
})
window.api.onBatchProgress(({ id, index, total, fraction }: BatchTick) => {
  const title = meetingItems.find((m) => m.id === id)?.title ?? id
  renderMeetingsProgress(t().meetingsProgress(title, index, total, Math.round(fraction * 100)))
  // Reuses the exact same "Transcribing… N%" wording the single-recording 'after'-mode
  // queue line already uses (t().transcribing) — same meaning, same words.
  activeBatchId = id
  activeBatchText = () => t().transcribing(Math.round(fraction * 100))
  updateActiveRowStatus()
})
window.api.onBatchDiarizing(({ id, index, total }: BatchDiarizing) => {
  const title = meetingItems.find((m) => m.id === id)?.title ?? id
  renderMeetingsProgress(t().meetingsDiarizing(title, index, total))
  // The previous meeting's diarize call has already returned by the time this event
  // for the *next* one arrives (diarize.ts's loop is sequential, one at a time) — put
  // its row back to plain "Done" before moving the live text onto the new one, or it
  // keeps reading "Working out who's speaking…" long after that is no longer true.
  if (activeBatchId && activeBatchId !== id) resetRowToBaseStatus(activeBatchId)
  // By now this meeting's own status (meeting:list) already reads "done" — its
  // transcribing pass finished before the whole queue's diarize pass even started
  // (index.ts's batch:start, MEDIUM 4) — so without this the row would flash "Done"
  // for the length of a diarize call instead of naming the phase it is actually in.
  activeBatchId = id
  activeBatchText = () => t().diarizing
  updateActiveRowStatus()
})
window.api.onBatchDone(({ cancelled }) => {
  batchRunning = false
  activeBatchId = null
  activeBatchText = null
  if (batchModelMissing) renderMeetingsProgress(t().modelMissingWarning, modelMissingAction)
  else renderMeetingsProgress(cancelled ? t().meetingsCancelled : '')
  updateTranscriptionLocks()
  void renderMeetings()
  // The batch's diarize pass (spec item 4/MEDIUM 4) is exactly where a new stranger's
  // voice would get clustered into a pending entry — refresh the Settings list so it
  // shows up without waiting for a language switch or a manual reopen.
  void renderPendingVoices()
})

/**
 * All Meetings (spec item b) is a plain top-level page — no state of its own beyond
 * what's already module-level (meetingItems/selectedMeetings/batchRunning), so opening
 * it is just showPage(); its rows are already kept current in the background by every
 * renderMeetings()/updateActiveRowStatus() call above, whether or not this page is the
 * one currently on screen.
 */
function openAllMeetings(): void {
  showPage(allMeetingsPage)
}
function closeAllMeetings(): void {
  showPage(mainView)
}
meetingsViewAllBtn.onclick = () => openAllMeetings()
allMeetingsBackBtn.onclick = () => closeAllMeetings()

/**
 * A single past meeting's transcript (spec item 1) — its own module-level state,
 * deliberately separate from the live session's (`segments`/`speakers`/`meetingDir`),
 * so viewing an old meeting can never collide with a recording still running in the
 * background (see `showPage`'s doc comment).
 */
let detailId: string | null = null
let detailDir: string | null = null
let detailSegments: Transcript['segments'] = []
let detailSpeakers: Record<string, string> = {}
/** The detail page's own copy of `speakerVoices` above, same reason it keeps its own
 * `detailSpeakers` rather than sharing the live session's. */
let detailSpeakerVoices: Transcript['speakerVoices'] = undefined
let detailStartedAt = ''
let detailDurationSec = 0
/** False once a meeting's audio has been deleted from the meetings list — the words
 * were kept, the recording was not, and the page has to say so rather than just quietly
 * have no player. */
let detailHasAudio = true

/** Static chrome first (always current, even before a meeting is loaded), then the
 * per-meeting header — split out so applyLanguage() can refresh both without knowing
 * whether a meeting is currently open. */
function renderDetailMeta(): void {
  detailBackLabel.textContent = t().settingsBack
  detailRevealBtn.textContent = t().detailReveal
  if (!detailId) return
  detailTitleEl.textContent = titleOf(detailId)
  detailMetaEl.textContent =
    `${fmtMeetingWhen(detailStartedAt)} · ${fmt(detailDurationSec)}` +
    (detailHasAudio ? '' : ` · ${t().playerNoAudio}`)
}

/** Delegates to the exact same renderSpeakerPanel the live session uses (generalized
 * above to take its data/container/callbacks as parameters) rather than a second copy. */
function renderDetailSpeakers(): void {
  renderSpeakerPanel(
    detailDir,
    detailSpeakers,
    detailSpeakersEl,
    () => renderTranscript(detailSegments, detailSpeakers, detailTranscriptEl),
    (updated) => {
      detailSpeakers = updated
    },
    detailSpeakerVoices,
  )
}

async function openMeetingDetail(id: string): Promise<void> {
  const { dir, audio, transcript: tr } = await window.api.getTranscript(id)
  detailId = id
  detailDir = dir
  detailSegments = tr.segments
  detailSpeakers = tr.speakers
  detailSpeakerVoices = tr.speakerVoices
  detailStartedAt = tr.startedAt
  detailDurationSec = tr.durationSec
  detailHasAudio = Object.values(audio).some(Boolean)
  renderDetailMeta()
  // Before the transcript, not after: whether each line is clickable depends on whether
  // there is a player for it to seek.
  openPlayer(id, audio, tr.segments, tr.durationSec)
  renderTranscript(detailSegments, detailSpeakers, detailTranscriptEl)
  renderDetailSpeakers()
  showPage(detailPage)
}
function closeMeetingDetail(): void {
  // Leaving the page has to stop the sound with it — same rule the voice-sample player
  // in Settings already follows: audio playing with no visible player anywhere is the
  // app talking to itself.
  stopPlayer()
  showPage(mainView)
}
detailBackBtn.onclick = () => closeMeetingDetail()
detailRevealBtn.onclick = () => {
  if (detailDir) void window.api.reveal(detailDir)
}

window.api.onSegments((track, incoming) => {
  segments.push(...incoming.map((s) => ({ ...s, speaker: track === 'mic' ? 'me' : 'them' })))
  segments.sort((a, b) => a.t0 - b.t0)
  renderTranscript()
})
window.api.onQueue((depth) => {
  // Nothing is dropped; a deep queue just means the transcript lags further behind.
  setQueueMsg(depth > 3 ? () => t().queueBacklog(depth) : null)
})
window.api.onTranscriptError((message) => {
  setWarning(
    isModelMissing(message)
      ? { text: () => t().modelMissingWarning, action: modelMissingAction }
      : { text: () => t().whisperError(message) },
  )
})
window.api.onTranscribing((fraction) => {
  // Overwritten by onDiarizing's message moments later, the same way onQueue's
  // backlog text already gets replaced once diarization starts.
  setQueueMsg(() => t().transcribing(Math.round(fraction * 100)))
})

window.api.onDiarizing(() => {
  setQueueMsg(() => t().diarizing)
})
window.api.onDiarized((dir, updated) => {
  setQueueMsg(null)
  meetingDir = dir
  segments = updated.segments
  speakers = updated.speakers
  speakerVoices = updated.speakerVoices
  renderTranscript()
  renderSpeakerPanel()
  // This diarize pass is exactly where a new stranger's voice gets clustered into a
  // pending entry (spec item 1) — keep the Settings list current without waiting for
  // the user to switch language or reopen the panel.
  void renderPendingVoices()
})
window.api.onDiarizeError((message) => {
  setQueueMsg(null)
  setWarning(
    isModelMissing(message)
      ? { text: () => t().modelMissingWarning, action: modelMissingAction }
      : { text: () => t().diarizeError(message) },
  )
})

window.api.onModelProgress(({ file, received: bytes }) => {
  if (bars.size === 0) return
  received.set(file, bytes)
  for (const { name: nameEl } of bars.values()) nameEl.textContent = modelName(file)
  updateOverallBar()
})

portSave.onclick = async () => {
  const port = Number(portInput.value)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    showMcpError(t().portInvalid)
    return
  }
  portSave.disabled = true
  try {
    const state = await window.api.setMcpPort(port)
    // The save succeeded, so the box's value is now the authoritative one — safe (and
    // correct) for the next re-render to sync from state again, and whatever error was
    // showing (most likely portInvalid, from a previous attempt) is now stale.
    portDirty = false
    mcpErrorMsg = null
    showMcpState(state)
  } catch (err) {
    showMcpError(reason(err))
  } finally {
    portSave.disabled = false
  }
}

mcpToggle.onchange = async () => {
  mcpToggle.disabled = true
  try {
    showMcpState(await window.api.toggleMcp(mcpToggle.checked))
  } catch (err) {
    mcpToggle.checked = !mcpToggle.checked
    showMcpError(reason(err))
  } finally {
    mcpToggle.disabled = false
  }
}

/** Applies the given language to every static label and re-renders every dynamic panel. */
/** The title field's placeholder is the name the meeting would actually get if left
 * blank, not the words "Meeting title" — the same string the meetings list will show
 * for it afterwards. It carries a clock minute, so it is re-derived on a timer as well
 * as on every language switch rather than being set once at startup and going stale. */
function syncTitlePlaceholder(): void {
  title.placeholder = untitledTitle(new Date())
}
setInterval(syncTitlePlaceholder, 20_000)

function applyLanguage(l: Language): void {
  lang = l
  document.documentElement.lang = l
  langRadios.en.checked = l === 'en'
  langRadios.th.checked = l === 'th'

  syncTitlePlaceholder()
  // Relabels the capsule's buttons, the paused notice and the floating bar in one go.
  renderRecordingControls()
  meterLabels.loopback.textContent = t().meterOthers
  meterLabels.mic.textContent = t().meterUs
  settingsOpenLabel.textContent = t().settingsSummary
  settingsBackLabel.textContent = t().settingsBack
  settingsTitleEl.textContent = t().settingsSummary
  for (const key of SETTINGS_CATEGORIES) {
    settingsCatButtons[key].textContent = catLabel[key]()
    settingsPanelTitles[key].textContent = catLabel[key]()
  }
  langRowLabel.textContent = t().langRowLabel
  micTestRowLabel.textContent = t().micTestRowLabel
  mcpRowLabel.textContent = t().mcpRowLabel
  transcribeModeLabelEl.textContent = t().transcribeModeLabel
  transcribeModeNames.after.textContent = t().transcribeModeAfter
  transcribeModeNames.live.textContent = t().transcribeModeLive
  transcribeModeNames.manual.textContent = t().transcribeModeManual
  transcribeModeHint.textContent = t().transcribeModeHint[getTranscribeMode()] ?? ''
  meetingLangLabelEl.textContent = t().meetingLangLabel
  const meetingLangOptions = meetingLangSelect.options
  meetingLangOptions[0]!.textContent = t().meetingLangName.th
  meetingLangOptions[1]!.textContent = t().meetingLangName.en
  meetingLangHintEl.textContent = t().meetingLangHint
  renderRemote()
  echoLabelEl.textContent = t().echoLabel
  echoHintEl.textContent = t().echoHint
  speakerSplitLabelEl.textContent = t().speakerSplitLabel
  for (const option of speakerSplitSelect.options) {
    option.textContent = t().speakerSplitName[option.value as SpeakerSplit] ?? option.value
  }
  renderSpeakerSplitHint()
  noiseLabel.textContent = t().noiseLabel
  portLabel.textContent = t().portLabel
  portSave.textContent = t().portSave
  const options = noiseSelect.options
  options[0]!.textContent = t().noiseLow
  options[1]!.textContent = t().noiseMedium
  options[2]!.textContent = t().noiseHigh
  noiseHint.textContent = t().noiseHint[noiseSelect.value] ?? ''
  micToggle.textContent = micStop ? t().micTestStop : t().micTest
  micLine.textContent = micStop ? `${t().micTestPrompt}: ${MIC_TEST_SENTENCE}` : ''
  void renderVoices()
  void renderPendingVoices()
  mcpLabel.textContent = t().mcpLabel
  mcpConnectTitleEl.textContent = t().mcpConnectTitle
  mcpConnectOffEl.textContent = t().mcpConnectOff
  renderUpdate()
  onboardingRerunLabelEl.textContent = t().onboardingRerunLabel
  onboardingRerunBtn.textContent = t().onboardingRerun

  void renderWarnings()
  renderQueue()
  renderDone()
  renderMicHeard()
  updateTranscriptionLocks()
  void renderModels()
  void renderAsrModel()
  renderSpeakerPanel()
  void renderMeetings()
  renderDetailMeta()
  // Only re-render the detail page's own transcript/speakers if a meeting is actually
  // loaded there — renderDetailMeta() above already covers its static chrome either way.
  if (detailId) {
    renderTranscript(detailSegments, detailSpeakers, detailTranscriptEl)
    renderDetailSpeakers()
  }
  void window.api.mcpState().then(showMcpState)
  // Harmless (and cheap) even when onboarding isn't open — re-derives whichever step
  // is current, so a language switch mid-onboarding does not leave it half-translated.
  renderOnboardingStep()
}

for (const [code, radio] of Object.entries(langRadios) as [Language, HTMLInputElement][]) {
  radio.onchange = async () => {
    if (!radio.checked) return
    try {
      applyLanguage((await window.api.setLanguage(code)).language)
    } catch (err) {
      // The radio's own checked state already flipped natively on click — put it back
      // in sync with the language that's actually still active before reporting why.
      langRadios.en.checked = lang === 'en'
      langRadios.th.checked = lang === 'th'
      setWarning({ text: () => t().languageSaveFailed(reason(err)) })
    }
  }
}

toggle.onclick = () => void (recorder ? stop() : start())
micToggle.onclick = () => void toggleMicTest()

noiseSelect.onchange = async () => {
  noiseSelect.disabled = true
  try {
    // Applies to the next chunk, not the next launch — the whole point is trying a
    // level and hearing whether it helped. Refused by main (spec item 2) if a pass
    // started in the brief window since this control was last enabled; the control is
    // disabled again below regardless of outcome, so there is nothing further to do
    // here beyond not leaving the rejection raw.
    await window.api.setNoiseFilter(noiseSelect.value as 'low' | 'medium' | 'high')
  } catch {
    // The only way this rejects is the lock above (a pass started in the brief window
    // since the control was last enabled) — same reason, same hint.
    noiseHint.textContent = t().noiseLockedHint
  } finally {
    // Not a bare `= false`: transcriptionBusy() may have gone true in the time this
    // await took, and this is what keeps the control (and its hint) honest either way.
    updateTranscriptionLocks()
  }
}

/** Two sentences, not one: what this step does to a transcript, and the fact that it
 * cannot fix the transcript already on disk — the setting is only consulted when a
 * meeting is diarized, so an existing one has to be re-transcribed to feel it. */
function renderSpeakerSplitHint(): void {
  const step = speakerSplitSelect.value as SpeakerSplit
  speakerSplitHintEl.textContent = `${t().speakerSplitHint[step] ?? ''} ${t().speakerSplitApplies}`
}

/**
 * The state of the one feature that sends anything off this machine. Held here so the
 * whole card re-renders from a single place — including on every language switch, since
 * the warning is the most important text in it and must never be left in the language
 * the user just switched away from.
 */
let remoteModels: RemoteModel[] = []
let remoteStatus: { kind: 'unknown' } | { kind: 'none' } | { kind: 'checking' } | { kind: 'ok'; models: number; usd: number | null; free: boolean } | { kind: 'failed'; message: string } = { kind: 'unknown' }

function renderRemote(): void {
  const on = remoteToggle.checked
  remoteLabelEl.textContent = t().remoteLabel
  // The lead sells the feature while it is off and explains the scope while it is on —
  // one line either way, because the long version below is the one that matters and it
  // must not be competing with a second paragraph for attention.
  remoteLeadEl.textContent = on ? t().remoteOnHint : t().remoteLead
  remoteOpenEl.hidden = !on
  if (!on) return

  remoteWarningEl.textContent = t().remoteWarning
  remoteKeyInput.placeholder = t().remoteKeyPlaceholder
  remoteConnectBtn.textContent = t().remoteConnect
  remoteConnectBtn.disabled = remoteStatus.kind === 'checking'
  remoteForgetBtn.textContent = t().remoteForget
  remoteModelLabelEl.textContent = t().remoteModelLabel
  // The model list and the key's own delete button only exist once the key has proved
  // it works — before that there is nothing to list and nothing worth deleting.
  remoteConnectedEl.hidden = remoteStatus.kind !== 'ok'

  if (remoteStatus.kind === 'checking') remoteStateEl.textContent = t().remoteConnecting
  else if (remoteStatus.kind === 'failed') remoteStateEl.textContent = t().remoteFailed(remoteStatus.message)
  else if (remoteStatus.kind === 'ok') {
    remoteStateEl.textContent =
      t().remoteConnected(remoteStatus.models) +
      (remoteStatus.usd !== null ? t().remoteCredit(remoteStatus.usd) : '') +
      (remoteStatus.free ? t().remoteFreeTier : '')
  } else remoteStateEl.textContent = t().remoteNoKey

  // Rebuilt rather than patched: the list comes from OpenRouter and its contents and
  // order (cheapest first) change between one connect and the next.
  const chosen = remoteModelSelect.value
  remoteModelSelect.replaceChildren(
    ...remoteModels.map((m) => {
      const option = document.createElement('option')
      option.value = m.id
      option.textContent = m.usdPerHour !== null ? `${m.name} — $${m.usdPerHour.toFixed(2)}/hr` : m.name
      return option
    }),
  )
  if (remoteModels.some((m) => m.id === chosen)) remoteModelSelect.value = chosen
  renderRemotePrice()
}

/** Spelled out under the picker, not just as a suffix in it: an estimate needs its
 * assumption said out loud, and "free" needs its catch said out loud too. */
function renderRemotePrice(): void {
  const model = remoteModels.find((m) => m.id === remoteModelSelect.value)
  if (!model) return void (remotePriceEl.textContent = '')
  if (model.free) remotePriceEl.textContent = t().remoteModelFree
  else if (model.usdPerHour === null || model.usdPerMillionAudio === null) {
    remotePriceEl.textContent = t().remoteModelUnpriced
  } else remotePriceEl.textContent = t().remoteModelPrice(model.usdPerHour, model.usdPerMillionAudio)
  remotePriceEl.textContent += ` ${t().remoteModelAdvice}`
}

async function loadRemoteModels(connect?: string): Promise<void> {
  remoteStatus = { kind: 'checking' }
  renderRemote()
  try {
    const info = connect === undefined ? await window.api.openrouterModels() : await window.api.connectOpenrouter(connect)
    remoteModels = info.models
    remoteStatus = { kind: 'ok', models: info.models.length, usd: info.usdRemaining, free: info.freeTier }
    // The key is good, so the stored model id is worth checking against what actually
    // exists today — a model that has been withdrawn would otherwise fail per chunk.
    const settings = await window.api.getSettings()
    remoteModelSelect.value = info.models.some((m) => m.id === settings.remoteModel)
      ? settings.remoteModel
      : (info.models[0]?.id ?? '')
  } catch (err) {
    remoteModels = []
    remoteStatus = { kind: 'failed', message: reason(err) }
  }
  renderRemote()
  if (remoteModelSelect.value) await window.api.setRemoteModel(remoteModelSelect.value)
}

remoteToggle.onchange = async () => {
  const engine: AsrEngine = remoteToggle.checked ? 'openrouter' : 'local'
  // Asked once, on the way in, on top of the warning that then stays on screen — this is
  // the only setting in the app that changes where the user's audio goes.
  if (engine === 'openrouter') {
    const answer = await window.api.ask(t().remoteConfirmTitle, t().remoteConfirmDetail, [
      t().remoteConfirmYes,
      t().deleteCancel,
    ])
    if (answer !== 0) {
      remoteToggle.checked = false
      return renderRemote()
    }
  }
  remoteToggle.disabled = true
  try {
    await window.api.setAsrEngine(engine)
  } finally {
    remoteToggle.disabled = false
  }
  renderRemote()
  // Switching off deliberately leaves the key on disk — coming back is a toggle, not a
  // trip to openrouter.ai for a new one. Only "Remove key" deletes it.
  if (engine === 'openrouter' && (await window.api.hasOpenrouterKey())) await loadRemoteModels()
}

remoteConnectBtn.onclick = async () => {
  const key = remoteKeyInput.value.trim()
  if (!key) return
  remoteConnectBtn.disabled = true
  try {
    await loadRemoteModels(key)
  } finally {
    remoteConnectBtn.disabled = false
    // Not left sitting in the box: it is already stored, and the box is the one place
    // it could be read back off the screen.
    remoteKeyInput.value = ''
  }
}

remoteForgetBtn.onclick = async () => {
  await window.api.forgetOpenrouter()
  remoteModels = []
  remoteStatus = { kind: 'none' }
  remoteToggle.checked = false
  renderRemote()
}

remoteModelSelect.onchange = async () => {
  renderRemotePrice()
  await window.api.setRemoteModel(remoteModelSelect.value)
}

echoToggle.onchange = async () => {
  echoToggle.disabled = true
  try {
    // Applies to the next transcript written, not to the ones already on disk.
    await window.api.setEchoFilter(echoToggle.checked)
  } finally {
    echoToggle.disabled = false
  }
}

speakerSplitSelect.onchange = async () => {
  speakerSplitSelect.disabled = true
  try {
    await window.api.setSpeakerSplit(speakerSplitSelect.value as SpeakerSplit)
    renderSpeakerSplitHint()
  } finally {
    speakerSplitSelect.disabled = false
  }
}

meetingLangSelect.onchange = async () => {
  meetingLangSelect.disabled = true
  try {
    // Applies to the next chunk sent to whisper-server, not the next launch.
    await window.api.setMeetingLanguage(meetingLangSelect.value as MeetingLanguage)
  } finally {
    meetingLangSelect.disabled = false
  }
}

const onTranscribeModeChange = async (): Promise<void> => {
  setTranscribeModeDisabled(true)
  try {
    // Takes effect on the next recording — this one, if nobody has pressed Start yet.
    await window.api.setTranscribeMode(getTranscribeMode())
    transcribeModeHint.textContent = t().transcribeModeHint[getTranscribeMode()] ?? ''
  } finally {
    setTranscribeModeDisabled(false)
  }
}
for (const r of Object.values(transcribeModeRadios)) r.onchange = onTranscribeModeChange

void window.api.getSettings().then((settings) => {
  noiseSelect.value = settings.noiseFilter
  setTranscribeModeValue(settings.transcribeMode)
  meetingLangSelect.value = settings.meetingLanguage
  speakerSplitSelect.value = settings.speakerSplit
  echoToggle.checked = settings.echoFilter
  remoteToggle.checked = settings.asrEngine === 'openrouter'
  if (settings.asrEngine === 'openrouter') {
    void window.api.hasOpenrouterKey().then((has) => {
      remoteStatus = has ? remoteStatus : { kind: 'none' }
      if (has) void loadRemoteModels()
      else renderRemote()
    })
  }
  applyLanguage(settings.language)
  // A genuine first run (no settings.json at all — settings.ts's getSettings tells that
  // apart from an existing user simply upgrading into this build) lands here instead of
  // the main page. Everything onboarding sets is applied immediately as the user picks
  // it (see each step's own onchange above), so there is nothing left to apply here.
  if (!settings.onboarded) void showOnboarding()
})
