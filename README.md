# meeting-inspector

Meeting transcription + summarization desktop app (macOS first, Electron).

Design spec: `~/Journal/2026-08-27-meeting-inspector-design.md`

Needs whisper.cpp on PATH:

```
brew install whisper-cpp
```

The four models (~3.1 GB) download themselves on first run — the app shows a
panel with a progress bar per file. Cancelling keeps what arrived and resumes
from there. `MODELS_DIR` overrides where they land (default `~/whisper-models`).

```
npm install
npm run dev        # electron-vite dev
npm test           # chunker, wav, store, merge, mcp
npm run typecheck
npm run dist       # release/Meeting Inspector-<version>-arm64.dmg
```

The .dmg is unsigned and unnotarized, so the first launch needs right-click →
Open → Open Anyway. It bundles the app only: whisper.cpp still has to be
installed on the target machine, and the models download on first run. Without
either, the app still records and says exactly which file is missing.

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

Summarizing needs your own API key — pick a provider under ตั้งค่า and paste
one. Keys are per provider, encrypted with `safeStorage` (Keychain-backed on
macOS), and stay in the main process; the renderer can only ask whether a key
exists. The whole transcript goes out in one request.

| Provider | Default model | $/1M in | out |
|---|---|---|---|
| Claude (default) | `claude-opus-5` | 5 | 25 |
| OpenAI | `gpt-5.6` | 4 | 20 |
| Gemini | `gemini-3.7-flash` | 0.75 | 3.75 |
| xAI Grok | `grok-4.6` | 2 | 6 |

### MCP server

Under ตั้งค่า, "เปิด MCP server" serves `list_meetings`, `get_transcript`,
`get_summary` and `search_transcripts` over Streamable HTTP on
`http://127.0.0.1:8787/` (any free port if that one is taken), behind a bearer
token the panel shows. Point any MCP client at that URL with the token.

Cloud clients — ChatGPT, Grok — cannot reach localhost, so there is a tunnel
toggle that runs `cloudflared tunnel` (`brew install cloudflared`). **Turning it
on puts your meeting transcripts on the public internet**, behind the same
token. It is off by default and turns itself off with the server.

Model ids and prices were checked 2026-08-27 and move faster than this repo
does — the Model field overrides the default per provider without a code
change, and the table lives in one place in `src/main/summarize.ts`. Claude
prices the request before you run it (`count_tokens`); the others report what
the run actually cost.

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
