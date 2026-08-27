# meeting-inspector

Meeting transcription + summarization desktop app (macOS first, Electron).

Design spec: `~/Journal/2026-08-27-meeting-inspector-design.md`

Needs whisper.cpp on PATH plus two models (override paths with `WHISPER_SERVER`
and `WHISPER_MODELS`):

```
brew install whisper-cpp
mkdir -p ~/whisper-models && cd ~/whisper-models
curl -LO https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin
curl -LO https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin

# speaker diarization
R=https://github.com/k2-fsa/sherpa-onnx/releases/download
curl -sL $R/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2 \
  | tar xj -O sherpa-onnx-pyannote-segmentation-3-0/model.onnx > pyannote-segmentation-3-0.onnx
curl -Lo campplus-sv-zh_en.onnx \
  $R/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx
```

`MODELS_DIR` overrides where all four are looked up.

```
npm install
npm run dev        # electron-vite dev
npm test           # wav writer + meeting-id/slug
npm run typecheck
```

Each meeting is a folder in `~/Documents/MeetingNotes/<yyyy-mm-dd-HHMM-title>/`:

| file | what |
|---|---|
| `loopback.wav` | everyone else, 16kHz mono |
| `mic.wav` | you, 16kHz mono |
| `transcript.json` | the data — segments sorted by time, speaker per segment |
| `transcript.md` | the same thing to read |
| `summary.md` | the LLM summary, once you ask for one |

When a meeting ends the loopback track is diarized and every segment picks up the
speaker it overlaps most; the mic track is always you, so it is never guessed at.
Name the speakers in the panel that appears — giving two of them the same name is
how you merge a voice that got split in two.

Stopping waits for the queued tail chunks before writing, so the transcript
reaches the end of the meeting. Quitting mid-meeting saves what came back
rather than nothing.

Summarizing needs your own Anthropic API key — paste it under ตั้งค่า. It is
encrypted with `safeStorage` (Keychain-backed on macOS) and stays in the main
process; the renderer can only ask whether a key exists. The whole transcript
goes to `claude-opus-5` in one request, and the button shows what the input
costs before you spend anything.

Live transcription runs at ~5x realtime on an M3 Pro, so a 30s chunk comes back
in about 6s. Language is fixed to Thai for now.

To measure ASR accuracy (spec risk #3): `npm run asr:read`, record yourself
reading it in the app, stop, then `npm run asr:score`. The scorer runs the
app's own Chunker and Whisper over `mic.wav`, so it measures the shipping
pipeline. It scores the same audio twice, with and without the seed vocabulary, so the
prompt's effect is visible on one recording.

Measured on 125s of read Thai dev-meeting speech: term recall 21/27 without a
prompt, 26/27 with one (CER 15.1% -> 11.4%). The vocabulary lives in
`DEFAULT_PROMPT` in `src/main/whisper.ts` — edit it to match your team's jargon.

**Electron is pinned to 38.8.6.** 39+ returns a silent loopback audio track on
macOS 26 (electron#49607). Re-run `spike/electron-loopback` before bumping it.
