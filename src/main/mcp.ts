import { spawn, type ChildProcess } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { NodeStreamableHTTPServerTransport, hostHeaderValidation } from '@modelcontextprotocol/node'
import { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import type { Transcript } from './store.ts'

/**
 * Streamable HTTP rather than stdio (spec §10): ChatGPT and Grok cannot speak stdio,
 * and one HTTP server covers every client instead of one transport per client family.
 */
const PREFERRED_PORT = 8787

export type McpHandle = { url: string; port: number; close: () => Promise<void> }

type Meeting = { id: string; title: string; startedAt: string; durationSec: number; hasSummary: boolean }

async function meetings(root: string): Promise<Meeting[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const found: Meeting[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const transcript = await readTranscriptAt(root, entry.name)
    if (!transcript) continue
    found.push({
      id: transcript.id,
      // The id is `<date>-<time>-<title>`; the title is whatever follows the stamp.
      title: entry.name.replace(/^\d{4}-\d{2}-\d{2}-\d{4}-/, ''),
      startedAt: transcript.startedAt,
      durationSec: transcript.durationSec,
      hasSummary: await readFile(join(root, entry.name, 'summary.md'), 'utf8').then(
        () => true,
        () => false,
      ),
    })
  }
  return found.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

async function readTranscriptAt(root: string, id: string): Promise<Transcript | null> {
  // The id doubles as the folder name, so refuse anything that could climb out of root.
  if (id.includes('/') || id.includes('\\') || id.startsWith('.')) return null
  return readFile(join(root, id, 'transcript.json'), 'utf8').then(
    (raw) => JSON.parse(raw) as Transcript,
    () => null,
  )
}

const who = (t: Transcript, speaker: string) => t.speakers[speaker] ?? speaker

function buildServer(root: string): McpServer {
  const server = new McpServer({ name: 'meeting-inspector', version: '0.1.0' })
  const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] })

  server.registerTool(
    'list_meetings',
    {
      title: 'List meetings',
      description: 'ทุกการประชุมที่บันทึกไว้ ใหม่สุดก่อน',
      inputSchema: z.object({}),
    },
    async () => text(await meetings(root)),
  )

  server.registerTool(
    'get_transcript',
    {
      title: 'Get transcript',
      description: 'transcript เต็มของการประชุมหนึ่ง พร้อมชื่อคนพูด',
      inputSchema: z.object({ id: z.string().describe('meeting id จาก list_meetings') }),
    },
    async ({ id }) => {
      const transcript = await readTranscriptAt(root, id)
      if (!transcript) throw new Error(`ไม่พบการประชุม ${id}`)
      return text({
        ...transcript,
        segments: transcript.segments.map((s) => ({ ...s, speakerName: who(transcript, s.speaker) })),
      })
    },
  )

  server.registerTool(
    'get_summary',
    {
      title: 'Get summary',
      description: 'สรุปของการประชุมหนึ่ง (markdown)',
      inputSchema: z.object({ id: z.string() }),
    },
    async ({ id }) => {
      if (!(await readTranscriptAt(root, id))) throw new Error(`ไม่พบการประชุม ${id}`)
      const summary = await readFile(join(root, id, 'summary.md'), 'utf8').catch(() => null)
      if (summary === null) throw new Error(`การประชุม ${id} ยังไม่ได้สรุป`)
      return { content: [{ type: 'text' as const, text: summary }] }
    },
  )

  server.registerTool(
    'search_transcripts',
    {
      title: 'Search transcripts',
      description: 'ค้นข้อความข้ามทุกการประชุม คืน segment ที่ตรงพร้อมบริบทรอบข้าง',
      inputSchema: z.object({
        query: z.string(),
        limit: z.number().int().positive().max(200).default(20),
      }),
    },
    // Straight scan over the JSON files, no index (spec §10). Add SQLite FTS the day
    // this is actually slow, not before.
    async ({ query, limit }) => {
      const needle = query.toLowerCase()
      const hits: unknown[] = []
      for (const meeting of await meetings(root)) {
        const transcript = await readTranscriptAt(root, meeting.id)
        if (!transcript) continue
        transcript.segments.forEach((segment, i) => {
          if (hits.length >= limit || !segment.text.toLowerCase().includes(needle)) return
          hits.push({
            meetingId: meeting.id,
            t0: segment.t0,
            speaker: who(transcript, segment.speaker),
            text: segment.text,
            context: transcript.segments
              .slice(Math.max(0, i - 2), i + 3)
              .map((s) => `${who(transcript, s.speaker)}: ${s.text}`),
          })
        })
        if (hits.length >= limit) break
      }
      return text({ query, hits })
    },
  )

  return server
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
    if (req.headers.authorization !== `Bearer ${opts.token}`) {
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
