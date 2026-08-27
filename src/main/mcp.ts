import { timingSafeEqual } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { NodeStreamableHTTPServerTransport, hostHeaderValidation } from '@modelcontextprotocol/node'
import { McpServer } from '@modelcontextprotocol/server'
import {
  registerTools,
  safeId,
  titleOf,
  type MeetingMeta,
  type MeetingStore,
  type Transcript,
} from '../shared/meetings.ts'

/**
 * Streamable HTTP on loopback only — one server every client can reach through a
 * stdio bridge, and nothing outside this machine can reach at all.
 */
export const PREFERRED_PORT = 8787

export type McpHandle = { url: string; port: number; close: () => Promise<void> }

/** Meetings as folders on disk — the local half of the same four tools. */
function diskStore(root: string): MeetingStore {
  const transcript = async (id: string) => {
    if (!safeId(id)) return null
    const raw = await readFile(join(root, id, 'transcript.json'), 'utf8').catch(() => null)
    return raw === null ? null : (JSON.parse(raw) as Transcript)
  }

  return {
    transcript,
    async list() {
      const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
      const found: MeetingMeta[] = []
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const t = await transcript(entry.name)
        if (!t) continue
        found.push({
          id: t.id,
          title: titleOf(entry.name),
          startedAt: t.startedAt,
          durationSec: t.durationSec,
        })
      }
      return found.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    },
  }
}

function buildServer(root: string): McpServer {
  const server = new McpServer({ name: 'meeting-inspector', version: '0.1.0' })
  registerTools(server, diskStore(root))
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

export async function startMcp(opts: { token: string; root: string; port?: number }): Promise<McpHandle> {
  // Loopback names only. Nothing off this machine is meant to reach the archive, and
  // this also blocks a web page from rebinding DNS onto the port.
  const validateHost = hostHeaderValidation(['localhost', '127.0.0.1', '[::1]'])

  const http = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (!validateHost(req, res)) return
    if (!authorized(req, opts.token)) {
      res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }
    // Stateless: a fresh server per request, so nothing leaks between clients.
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    await buildServer(opts.root).connect(transport)
    await transport.handleRequest(req, res)
  })

  const port = await listen(http, opts.port ?? PREFERRED_PORT)
  return {
    port,
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise<void>((resolve) => http.close(() => resolve())),
  }
}

const bind = (http: Server, port: number): Promise<number | null> =>
  new Promise((resolve) => {
    const onError = () => resolve(null)
    http.once('error', onError)
    http.listen(port, '127.0.0.1', () => {
      http.off('error', onError)
      const address = http.address()
      resolve(typeof address === 'object' && address ? address.port : null)
    })
  })

/**
 * Client configs hardcode the port, so a busy 8787 is worth waiting out — it is
 * usually our own previous instance still letting go of it. Only after that does it
 * fall back to any free port, and the UI says so, because every config then needs
 * updating.
 */
async function listen(http: Server, preferred: number): Promise<number> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const bound = await bind(http, preferred)
    if (bound) return bound
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  const anyFree = await bind(http, 0)
  if (anyFree) return anyFree
  throw new Error('เปิด MCP server ไม่ได้ — หา port ว่างไม่เจอ')
}
