import { spawn, type ChildProcess } from 'node:child_process'
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
 * Streamable HTTP rather than stdio (spec §10): ChatGPT and Grok cannot speak stdio,
 * and one HTTP server covers every client instead of one transport per client family.
 */
const PREFERRED_PORT = 8787

export type McpHandle = { url: string; port: number; close: () => Promise<void> }

/** Meetings as folders on disk — the local half of the same four tools. */
function diskStore(root: string): MeetingStore {
  const read = async (id: string, file: string) =>
    safeId(id) ? readFile(join(root, id, file), 'utf8').catch(() => null) : null

  const transcript = async (id: string) => {
    const raw = await read(id, 'transcript.json')
    return raw === null ? null : (JSON.parse(raw) as Transcript)
  }

  return {
    transcript,
    summary: (id) => read(id, 'summary.md'),
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
          hasSummary: (await read(entry.name, 'summary.md')) !== null,
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
 * Bearer header for clients that can send one (Claude Code, Claude Desktop). ChatGPT's
 * custom connectors offer only OAuth or no-auth, so the token may also arrive as the
 * first path segment — a secret URL. Weaker, since URLs end up in proxy logs, but it
 * is the only way a header-less client can be let in at all.
 */
function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization
  if (header?.startsWith('Bearer ') && sameSecret(header.slice(7), token)) return true
  const first = (req.url ?? '/').split('?')[0]!.split('/').filter(Boolean)[0]
  return first !== undefined && sameSecret(first, token)
}

export async function startMcp(opts: {
  token: string
  root: string
  port?: number
  /** Extra Host values to accept — the tunnel hostname when the tunnel is on. */
  allowHosts?: string[]
}): Promise<McpHandle> {
  const validateHost = hostHeaderValidation(['localhost', '127.0.0.1', '[::1]', ...(opts.allowHosts ?? [])])

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

/** Falls back to any free port so a busy 8787 does not stop the server from starting. */
async function listen(http: Server, preferred: number): Promise<number> {
  for (const port of [preferred, 0]) {
    const bound = await new Promise<number | null>((resolve) => {
      const onError = () => resolve(null)
      http.once('error', onError)
      http.listen(port, '127.0.0.1', () => {
        http.off('error', onError)
        const address = http.address()
        resolve(typeof address === 'object' && address ? address.port : null)
      })
    })
    if (bound) return bound
  }
  throw new Error('เปิด MCP server ไม่ได้ — หา port ว่างไม่เจอ')
}

/**
 * Turning this on puts meeting transcripts on the public internet, which is why it is
 * off by default and has to be an explicit press (spec §10). Uses whatever cloudflared
 * the user installed rather than bundling a binary.
 */
export function startTunnel(port: number): Promise<{ url: string; stop: () => void }> {
  return new Promise((resolve, reject) => {
    let proc: ChildProcess
    try {
      proc = spawn('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${port}`])
    } catch {
      reject(new Error('ไม่พบ cloudflared — ติดตั้งด้วย `brew install cloudflared`'))
      return
    }
    const stop = () => proc.kill()
    const timer = setTimeout(() => {
      stop()
      reject(new Error('cloudflared ไม่คืน URL ภายใน 30 วินาที'))
    }, 30_000)

    const onChunk = (chunk: Buffer) => {
      const url = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(chunk.toString())?.[0]
      if (!url) return
      clearTimeout(timer)
      resolve({ url, stop })
    }
    proc.stdout?.on('data', onChunk)
    proc.stderr?.on('data', onChunk) // cloudflared prints the URL on stderr
    proc.once('error', () => {
      clearTimeout(timer)
      reject(new Error('ไม่พบ cloudflared — ติดตั้งด้วย `brew install cloudflared`'))
    })
  })
}
