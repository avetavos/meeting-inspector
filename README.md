# meeting-inspector

Meeting transcription + summarization desktop app (macOS first, Electron).

Design spec: `~/Journal/2026-08-27-meeting-inspector-design.md`

```
npm install
npm run dev        # electron-vite dev
npm test           # wav writer + meeting-id/slug
npm run typecheck
```

Recordings land in `~/Documents/MeetingNotes/<yyyy-mm-dd-HHMM-title>/` as two
16kHz mono WAVs — `loopback.wav` (everyone else) and `mic.wav` (you).

**Electron is pinned to 38.8.6.** 39+ returns a silent loopback audio track on
macOS 26 (electron#49607). Re-run `spike/electron-loopback` before bumping it.
