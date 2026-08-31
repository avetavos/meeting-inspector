import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import {
  NodeStreamableHTTPServerTransport,
  hostHeaderValidation,
  localhostOriginValidation,
} from '@modelcontextprotocol/node'
import { McpServer } from '@modelcontextprotocol/server'
import { displayTitle, registerTools, safeId, type LiveMeeting, type MeetingMeta, type MeetingStore } from '../shared/meetings.ts'
import { readTranscript, walkMeetings } from './store.ts'
import { resolveSpeakerNames } from './voices.ts'

/**
 * Streamable HTTP on loopback only — one server every client can reach through a
 * stdio bridge, and nothing outside this machine can reach at all.
 */
export const PREFERRED_PORT = 8787

export type McpHandle = { url: string; port: number; close: () => Promise<void> }

/** Meetings as folders on disk — the local half of the same tools. `live` is the one
 * thing not on disk: the recording in progress, handed in by the app (index.ts) because
 * only it knows there is one. */
function diskStore(root: string, live?: () => Promise<LiveMeeting | null>): MeetingStore {
  const transcript = async (id: string) => {
    if (!safeId(id)) return null
    // Reuses store.ts's own reader rather than a second readFile+JSON.parse here.
    const t = await readTranscript(join(root, id)).catch(() => null)
    if (!t) return null
    // Resolved the same way index.ts hands a transcript to the renderer (meeting:get,
    // meeting:rename) — a rename after diarize time used to reach only the app's own
    // UI; a connected assistant read `speakers` straight off disk and saw whatever
    // name was current at diarize time, stale the moment the user renamed anyone.
    return { ...t, speakers: await resolveSpeakerNames(t.speakers, t.speakerVoices) }
  }

  return {
    transcript,
    live,
    async list() {
      // Reuses store.ts's walk of the same folder rather than a second one here.
      // Unlike the meetings panel (store.ts's listMeetings), a meeting with no usable
      // transcript has nothing to summarize, so it is skipped here rather than shown.
      const walked = await walkMeetings(root)
      const found: MeetingMeta[] = []
      for (const { id, meta, transcript: t } of walked) {
        // walkMeetings walks every directory entry with no filter of its own — unlike
        // store.ts's old transcript(entry.name) route this used to go through, which
        // applied safeId() on the way in. Without it, a folder name get_transcript
        // would refuse (id.length===0, a leading '.', etc. — safeId's own doc comment)
        // could still be listed here, "found" but never fetchable.
        if (!t || !safeId(id)) continue
        found.push({
          // The folder name, not the id inside the file: `get_transcript` resolves by
          // folder, so reporting anything else lets a stray file rename a meeting.
          id,
          // From meeting.json, not parsed out of the folder name — the id is a uuid
          // now and the title is freetext beside it (store.ts's MeetingMetaFile).
          title: displayTitle(meta?.title ?? '', meta?.startedAt ?? t.startedAt),
          startedAt: t.startedAt,
          durationSec: t.durationSec,
        })
      }
      return found.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    },
  }
}

function buildServer(root: string, live?: () => Promise<LiveMeeting | null>): McpServer {
  const server = new McpServer({ name: 'meeting-inspector', version: '0.1.0' })
  registerTools(server, diskStore(root, live))
  return server
}

const sameSecret = (a: string, b: string): boolean => {
  const [x, y] = [Buffer.from(a), Buffer.from(b)]
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * Bearer header for clients that send one, or the token as the first path segment for
 * the stdio bridge — a header is awkward to quote inside a client's JSON config. Both
 * only ever travel over loopback.
 */
function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization
  if (header?.startsWith('Bearer ') && sameSecret(header.slice(7), token)) return true
  const first = (req.url ?? '/').split('?')[0]!.split('/').filter(Boolean)[0]
  return first !== undefined && sameSecret(first, token)
}

/**
 * `POST /mic` — the browser extension telling the app that the microphone was muted or
 * unmuted in the meeting the user is actually in. Deliberately the only thing it can
 * do: it carries one boolean, reads nothing back, and lives on the server that already
 * exists rather than opening a second port for it.
 *
 * Its own CORS and auth, separate from the MCP route below, because the caller is
 * unlike every other caller here. `localhostOriginValidation` rejects
 * `chrome-extension://…` — correctly, for the archive — so this route allows extension
 * origins and nothing else, and still requires the same bearer token. Any extension the
 * user installs could reach this if it knew the token; the token is the guard, exactly
 * as it is for the transcripts, and what is on the other side of this one is a
 * microphone toggle rather than a meeting.
 */
async function handleMic(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  onMic: ((muted: boolean) => void) | undefined,
): Promise<void> {
  const origin = req.headers.origin ?? ''
  const allowed = origin.startsWith('chrome-extension://')
  if (allowed) {
    res.setHeader('access-control-allow-origin', origin)
    res.setHeader('access-control-allow-headers', 'authorization, content-type')
    res.setHeader('access-control-allow-methods', 'POST, OPTIONS')
    res.setHeader('vary', 'origin')
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(allowed ? 204 : 403).end()
    return
  }
  // Header only, never the path form `authorized` also accepts: a token in a URL is a
  // token in a history entry and a log line, and the caller here is a web extension.
  const header = req.headers.authorization
  if (!(header?.startsWith('Bearer ') && sameSecret(header.slice(7), token))) {
    res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' }))
    return
  }

  const body = await new Promise<string>((resolve) => {
    let text = ''
    // Capped: this endpoint takes one boolean, and an unbounded read on a local socket
    // is an unbounded allocation.
    req.on('data', (chunk: Buffer) => {
      if (text.length < 1024) text += chunk.toString('utf8')
    })
    req.on('end', () => resolve(text))
  })
  const muted = (() => {
    try {
      return (JSON.parse(body) as { muted?: unknown }).muted === true
    } catch {
      return null
    }
  })()
  if (muted === null) {
    res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'expected {"muted": boolean}' }))
    return
  }
  onMic?.(muted)
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, muted }))
}

export async function startMcp(opts: {
  token: string
  root: string
  port?: number
  /** Called when the browser extension reports the meeting's own mic being toggled. */
  onMic?: (muted: boolean) => void
  /** The recording in progress, read at request time — not on disk, and not something
   * this module can know about on its own. */
  live?: () => Promise<LiveMeeting | null>
}): Promise<McpHandle> {
  // Loopback names only. Nothing off this machine is meant to reach the archive, and
  // this also blocks a web page from rebinding DNS onto the port.
  const validateHost = hostHeaderValidation(['localhost', '127.0.0.1', '[::1]'])
  // A page in a browser cannot guess the token, but Origin is the one check that
  // stops such a request before it is even read.
  const validateOrigin = localhostOriginValidation()

  const handler: Handler = async (req, res) => {
    if (!validateHost(req, res)) return
    // Before the origin check, which this route replaces with one of its own.
    if ((req.url ?? '/').split('?')[0] === '/mic') return handleMic(req, res, opts.token, opts.onMic)
    if (!validateOrigin(req, res)) return
    if (!authorized(req, opts.token)) {
      res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }
    // Stateless: a fresh server per request, so nothing leaks between clients.
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    await buildServer(opts.root, opts.live).connect(transport)
    await transport.handleRequest(req, res)
  }

  const http = await listen(handler, opts.port ?? PREFERRED_PORT)
  // bind()'s own error listener is off by now (it comes off in the listen callback),
  // so without this a post-listen error — accept() failing under fd exhaustion, say —
  // would be an uncaught exception that takes the whole main process down with it.
  http.on('error', (err) => console.error('mcp: server error after bind', err))
  const address = http.address()
  // Only null before 'listening' fires or after 'close' — unreachable here since we
  // already got the listen callback. Throwing rather than defaulting to a fake port
  // number (0) that could otherwise be mistaken for a real, if odd, bound state.
  if (typeof address !== 'object' || !address) throw new Error('mcp: server bound but has no address')
  const port = address.port
  return {
    port,
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise<void>((resolve) => http.close(() => resolve())),
  }
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

/**
 * A fresh server per attempt. Reusing one across attempts looks harmless and is not:
 * after a failed bind the object is still settling, and the next listen() throws
 * ERR_SERVER_ALREADY_LISTEN synchronously — so one busy port poisoned every fallback
 * and the server ended up on a random one even when the requested port was free.
 */
const bind = (handler: Handler, port: number): Promise<Server | null> =>
  new Promise((resolve) => {
    const http = createServer(handler)
    const onError = () => {
      http.close()
      resolve(null)
    }
    http.once('error', onError)
    http.listen(port, '127.0.0.1', () => {
      http.off('error', onError)
      resolve(http)
    })
  })

const RETRY_ATTEMPTS = 3
const RETRY_DELAY_MS = 150

/**
 * Client configs name the port, so a busy one is worth a brief retry first — but only
 * brief. restartMcp() already awaited our own previous server's close() before calling
 * in here, so by the time we're retrying it is almost always a foreign holder that
 * will never let go, not our own instance settling; this retry mainly covers our old
 * socket sitting in TIME_WAIT. Only after that does it step down: to the default port
 * if the user chose something else, and to any free port after that. Each step is
 * visible in the UI, because a moved port means every saved client config is now
 * pointing at nothing.
 */
async function listen(handler: Handler, preferred: number): Promise<Server> {
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    const bound = await bind(handler, preferred)
    if (bound) return bound
    // No point sleeping after the last attempt — nothing is going to retry it.
    if (attempt < RETRY_ATTEMPTS - 1) await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
  }
  if (preferred !== PREFERRED_PORT) {
    const fallback = await bind(handler, PREFERRED_PORT)
    if (fallback) return fallback
  }
  const anyFree = await bind(handler, 0)
  if (anyFree) return anyFree
  throw new Error('could not start the MCP server — no free port')
}
