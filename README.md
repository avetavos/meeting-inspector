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
```

```
npm install
npm run dev        # electron-vite dev
npm test           # wav writer + meeting-id/slug
npm run typecheck
```

Recordings land in `~/Documents/MeetingNotes/<yyyy-mm-dd-HHMM-title>/` as two
16kHz mono WAVs — `loopback.wav` (everyone else) and `mic.wav` (you).

Live transcription runs at ~5x realtime on an M3 Pro, so a 30s chunk comes back
in about 6s. Language is fixed to Thai for now.

To measure ASR accuracy (spec risk #3): `npm run asr:read`, record yourself
reading it in the app, stop, then `npm run asr:score`. The scorer runs the
app's own Chunker and Whisper over `mic.wav`, so it measures the shipping
pipeline. macOS TTS reading the same script scores CER 12.4% / term recall
48% — that is the floor, not a target; it pronounces English with Thai
phonology.

**Electron is pinned to 38.8.6.** 39+ returns a silent loopback audio track on
macOS 26 (electron#49607). Re-run `spike/electron-loopback` before bumping it.
