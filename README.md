# meeting-inspector

Meeting transcription + summarization desktop app (macOS first, Electron).

Design spec: `~/Journal/2026-08-27-meeting-inspector-design.md`

The four models (~3.1 GB) download themselves on first run — the app shows a
panel with a progress bar per file. Cancelling keeps what arrived and resumes
from there. `MODELS_DIR` overrides where they land (default `~/whisper-models`).

```
npm install
npm run dev        # electron-vite dev
npm test           # chunker, wav, store, merge, mcp
npm run typecheck
npm run dist       # release/Meeting Inspector-<version>-arm64.dmg
npm run icon       # redraw build/icon.icns from build/icon.mjs
```

`dist` builds a static `whisper-server` from source first (`brew install cmake`,
a few minutes the first time, cached after). Homebrew's `whisper-cpp` cannot be
bundled — its ggml loads backends by dlopen from a path fixed at compile time —
but it still works as a fallback for a checkout you have not built.

The .dmg is unsigned and unnotarized, so the first launch needs right-click →
Open → Open Anyway. It carries its own `whisper-server`, so the only
thing the target machine fetches is the models, on first run. Without them the
app still records and says exactly which file is missing.

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

The panel gives you the line to paste, per client:

```
# Claude Code — speaks HTTP directly
claude mcp add --scope user --transport http meeting-inspector \
  http://127.0.0.1:8787/ --header "Authorization: Bearer <token>"
```

Claude Desktop's chat reads only its own config, and its custom connectors have
to be reachable from Anthropic's servers — a localhost URL is not. Locally it
goes through a stdio bridge instead, in
`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{ "mcpServers": { "meeting-inspector": {
  "command": "npx",
  "args": ["-y", "mcp-remote", "http://127.0.0.1:8787/<token>"]
} } }
```

Restart Claude Desktop after editing it. Nothing leaves the machine.

Cloud clients — ChatGPT, Grok — cannot reach localhost, so there is a tunnel
toggle that runs `cloudflared tunnel` (`brew install cloudflared`). **Turning it
on puts your meeting transcripts on the public internet**, behind the same
token. It is off by default and turns itself off with the server.

ChatGPT's custom connectors offer only OAuth or no authentication, so the token
can also ride in the URL — the panel shows `https://<tunnel>/<token>`, which you
add with authentication set to "None". Weaker than a header, since URLs reach
proxy logs, which is why it is not the default.

The server only answers while the app is open.

### Cloudflare Worker (optional)

`worker/` is the same four tools reading from R2 instead of the local disk — a
permanent HTTPS URL, so clients reach your meetings without the Mac being awake
and without a tunnel whose address changes every time.

```
npx wrangler login
npx wrangler r2 bucket create meeting-inspector
npx wrangler secret put MCP_TOKEN  --config worker/wrangler.jsonc   # read
npx wrangler secret put SYNC_TOKEN --config worker/wrangler.jsonc   # write
npm run worker:deploy
```

Put the URL and `SYNC_TOKEN` under ตั้งค่า; each meeting then has a
"ส่งขึ้นคลาวด์" button. **Nothing uploads on its own** — spec §10's point is that
putting transcripts online is a decision, so it stays one press per meeting.

The two secrets are separate on purpose: the read token may travel in the URL
for clients that cannot send headers, and a URL that reaches proxy logs must
never carry write access.

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
