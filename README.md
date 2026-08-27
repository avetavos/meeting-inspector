# meeting-inspector

Meeting transcription desktop app (macOS first, Electron). Fully offline: it
records, transcribes and separates speakers on this machine and makes no
outbound requests of its own once the models are downloaded. Summarizing is the
job of whichever assistant you connect over MCP on loopback.

Design spec: `~/Journal/2026-08-27-meeting-inspector-design.md`

The four models (~3.1 GB) download themselves on first run — the app shows a
panel with a progress bar per file. Cancelling keeps what arrived and resumes
from there. `MODELS_DIR` overrides where they land (default `~/whisper-models`).
That download is the only time the app reaches the network.

```
npm install
npm run dev        # electron-vite dev
npm test           # chunker, wav, store, merge, download, mcp
npm run typecheck
npm run dist       # release/Meeting Inspector-<version>-arm64.dmg
npm run icon       # redraw build/icon.icns from build/icon.mjs
```

`dist` builds a static `whisper-server` from source first (`brew install cmake`,
a few minutes the first time, cached after). Homebrew's `whisper-cpp` cannot be
bundled — its ggml loads backends by dlopen from a path fixed at compile time —
but it still works as a fallback for a checkout you have not built.

The .dmg is unsigned and unnotarized, so the first launch needs right-click →
Open → Open Anyway. It carries its own `whisper-server`, so the only thing the
target machine fetches is the models. Without them the app still records and
says exactly which file is missing.

Each meeting is a folder in `~/Documents/MeetingNotes/<yyyy-mm-dd-HHMM-title>/`:

| file | what |
|---|---|
| `loopback.wav` | everyone else, 16kHz mono |
| `mic.wav` | you, 16kHz mono |
| `transcript.json` | the data — segments sorted by time, speaker per segment |
| `transcript.md` | the same thing to read |

When a meeting ends the loopback track is diarized and every segment picks up the
speaker it overlaps most; the mic track is always you, so it is never guessed at.
Name the speakers in the panel that appears — giving two of them the same name is
how you merge a voice that got split in two.

Stopping waits for the queued tail chunks before writing, so the transcript
reaches the end of the meeting. Quitting mid-meeting saves what came back
rather than nothing.

Live transcription runs at ~5x realtime on an M3 Pro, so a 30s chunk comes back
in about 6s. Language is fixed to Thai for now.

### MCP server

The MCP server starts with the app, so leaving Meeting Inspector open is all a
client needs. It serves `list_meetings`, `get_transcript` and
`search_transcripts` over Streamable HTTP on `http://127.0.0.1:8787/`, behind a
bearer token the panel shows. It binds loopback and accepts loopback `Host`
values only — nothing off this machine can reach it.

If something else holds 8787 it waits a few seconds before moving, since every
client config names that port, and says so in the panel when it has to move.

The panel gives you the line to paste, per client:

```
# Claude Code — speaks HTTP directly
claude mcp add --scope user --transport http meeting-inspector \
  http://127.0.0.1:8787/ --header "Authorization: Bearer <token>"
```

Claude Desktop and ChatGPT Desktop load local servers over stdio, so they reach
it through a bridge — Claude Desktop in
`~/Library/Application Support/Claude/claude_desktop_config.json`, ChatGPT
Desktop in the MCP config it shares with Codex CLI:

```json
{ "mcpServers": { "meeting-inspector": {
  "command": "npx",
  "args": ["-y", "mcp-remote", "http://127.0.0.1:8787/<token>"]
} } }
```

Restart the client after editing it. The token may ride in the URL like that
because it never leaves loopback; quoting a header inside JSON is the usual way
this setup fails silently.

Clients that fetch the URL from their own servers — ChatGPT on the web, Gemini's
custom connected apps — cannot reach a loopback address, and reaching them would
mean publishing the transcripts. They are out of scope by design.

The server only answers while the app is open.

### Measuring transcription accuracy

`npm run asr:read`, record yourself reading it in the app, stop, then
`npm run asr:score`. The scorer runs the app's own Chunker and Whisper over
`mic.wav`, so it measures the shipping pipeline. It scores the same audio twice,
with and without the seed vocabulary, so the prompt's effect is visible on one
recording.

Measured on 125s of read Thai dev-meeting speech: term recall 21/27 without a
prompt, 26/27 with one (CER 15.1% -> 11.4%). The vocabulary lives in
`DEFAULT_PROMPT` in `src/main/whisper.ts` — edit it to match your team's jargon.

**Electron is pinned to 38.8.6.** 39+ returns a silent loopback audio track on
macOS 26 (electron#49607). Re-run `spike/electron-loopback` before bumping it.
