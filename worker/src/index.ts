import { McpServer, createMcpHandler } from '@modelcontextprotocol/server'
import {
  registerTools,
  safeId,
  titleOf,
  type MeetingMeta,
  type MeetingStore,
  type Transcript,
} from '../../src/shared/meetings.ts'

export type Env = {
  MEETINGS: R2Bucket
  /** Read access, for MCP clients. */
  MCP_TOKEN: string
  /** Write access, for the desktop app. Deliberately a different secret. */
  SYNC_TOKEN: string
}

const INDEX = 'index.json'
const objectKey = (id: string, file: string) => `meetings/${id}/${file}`

/**
 * The same four tools as the desktop server, reading from R2 instead of disk.
 *
 * list_meetings goes through a maintained index rather than reading every meeting:
 * it is the call every question starts with, and one GET beats one per meeting.
 */
function r2Store(bucket: R2Bucket): MeetingStore {
  return {
    async list() {
      const meetings = await readIndex(bucket)
      return meetings.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    },
    async transcript(id) {
      if (!safeId(id)) return null
      const object = await bucket.get(objectKey(id, 'transcript.json'))
      return object ? await object.json<Transcript>() : null
    },
    async summary(id) {
      if (!safeId(id)) return null
      const object = await bucket.get(objectKey(id, 'summary.md'))
      return object ? await object.text() : null
    },
  }
}

async function readIndex(bucket: R2Bucket): Promise<MeetingMeta[]> {
  const object = await bucket.get(INDEX)
  return object ? await object.json<MeetingMeta[]>() : []
}

const unauthorized = () =>
  new Response(JSON.stringify({ error: 'unauthorized' }), {
    status: 401,
    headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer' },
  })

const bearer = (request: Request): string | null => {
  const header = request.headers.get('authorization')
  return header?.startsWith('Bearer ') ? header.slice(7) : null
}

/** Uploads one meeting and folds it into the index. */
async function sync(request: Request, env: Env, id: string): Promise<Response> {
  // Header only: a write token must never be reachable through a URL that ends up
  // in someone's proxy log.
  if (bearer(request) !== env.SYNC_TOKEN) return unauthorized()
  if (!safeId(id)) return new Response('bad id', { status: 400 })

  const body = (await request.json()) as { transcript: Transcript; summary?: string }
  if (!body?.transcript?.segments) return new Response('missing transcript', { status: 400 })

  await env.MEETINGS.put(objectKey(id, 'transcript.json'), JSON.stringify(body.transcript))
  if (body.summary) await env.MEETINGS.put(objectKey(id, 'summary.md'), body.summary)

  const index = await readIndex(env.MEETINGS)
  const meta: MeetingMeta = {
    id,
    title: titleOf(id),
    startedAt: body.transcript.startedAt,
    durationSec: body.transcript.durationSec,
    hasSummary: Boolean(body.summary) || index.find((m) => m.id === id)?.hasSummary === true,
  }
  await env.MEETINGS.put(INDEX, JSON.stringify([...index.filter((m) => m.id !== id), meta]))

  return Response.json({ ok: true, id, segments: body.transcript.segments.length })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const segments = url.pathname.split('/').filter(Boolean)

    if (segments[0] === 'sync') return sync(request, env, segments[1] ?? '')

    // ChatGPT's custom connectors offer only OAuth or no auth, so the read token may
    // also arrive as the first path segment. Strip it before the MCP handler sees it.
    const pathToken = segments[0]
    const authorized = bearer(request) === env.MCP_TOKEN || pathToken === env.MCP_TOKEN
    if (!authorized) return unauthorized()

    const handler = createMcpHandler(() => {
      const server = new McpServer({ name: 'meeting-inspector', version: '0.1.0' })
      registerTools(server, r2Store(env.MEETINGS))
      return server
    })
    const stripped = new Request(new URL('/', url), request)
    return handler.fetch(pathToken === env.MCP_TOKEN ? stripped : request)
  },
}
