import assert from 'node:assert/strict'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { PREFERRED_PORT, startMcp, type McpHandle } from './mcp.ts'
import { writeTranscript } from './store.ts'

const TOKEN = 'test-token-do-not-guess'
let server: McpHandle
let root: string

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'mcp-test-'))

  const sprint = join(root, '2026-08-27-1400-sprint-planning')
  await mkdir(sprint, { recursive: true })
  await writeTranscript(sprint, {
    id: '2026-08-27-1400-sprint-planning',
    startedAt: '2026-08-27T14:00:00+07:00',
    durationSec: 3120,
    speakers: { me: 'ผม', SPEAKER_00: 'พี่โจ้' },
    segments: [
      { t0: 12.4, t1: 18.9, speaker: 'SPEAKER_00', text: 'ตัว backend พร้อม deploy แล้ว' },
      { t0: 19.1, t1: 24.0, speaker: 'me', text: 'เดี๋ยวผมขึ้น staging ให้' },
      { t0: 25.0, t1: 30.0, speaker: 'SPEAKER_00', text: 'อย่าลืม rollback plan' },
    ],
  })
  const retro = join(root, '2026-08-20-1000-retro')
  await mkdir(retro, { recursive: true })
  await writeTranscript(retro, {
    id: '2026-08-20-1000-retro',
    startedAt: '2026-08-20T10:00:00+07:00',
    durationSec: 600,
    speakers: { me: 'ผม' },
    segments: [{ t0: 1, t1: 5, speaker: 'me', text: 'sprint ที่แล้วไม่มีปัญหา deploy' }],
  })

  // Port 0 so the suite never fights the running app for 8787.
  server = await startMcp({ token: TOKEN, root, port: 0 })
})

after(() => server.close())

type Rpc = { status: number; body: { result?: any; error?: any } | null }

let id = 0
async function rpc(method: string, params?: unknown, token = TOKEN, url?: string): Promise<Rpc> {
  const res = await fetch(url ?? server.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: params ?? {} }),
  })
  if (!res.ok) return { status: res.status, body: null }
  const raw = await res.text()
  // Streamable HTTP may answer as JSON or as a single SSE frame.
  const payload = raw.startsWith('event:') || raw.startsWith('data:')
    ? raw.split('\n').find((l) => l.startsWith('data:'))!.slice(5).trim()
    : raw
  return { status: res.status, body: JSON.parse(payload) as Rpc['body'] }
}

const callTool = async (name: string, args: unknown = {}) => {
  const { body } = await rpc('tools/call', { name, arguments: args })
  assert.ok(body?.result, `${name} returned an error: ${JSON.stringify(body?.error)}`)
  return body.result as { content: { text: string }[]; isError?: boolean }
}

test('mcp: a wrong bearer token is refused before anything is read', async () => {
  assert.equal((await rpc('tools/list', {}, 'wrong-token')).status, 401)
  assert.equal((await rpc('tools/list', {}, '')).status, 401)
})

test('mcp: the token may arrive in the path, for clients that cannot send headers', async () => {
  const withToken = `${server.url}${TOKEN}`
  const ok = await rpc('tools/list', {}, 'no-header-here', withToken)
  assert.equal(ok.status, 200)
  assert.ok(ok.body?.result?.tools?.length)

  const wrong = await rpc('tools/list', {}, 'no-header-here', `${server.url}not-the-token`)
  assert.equal(wrong.status, 401)
})

test('mcp: handshake and tool list', async () => {
  const { body } = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  })
  assert.equal(body?.result?.serverInfo?.name, 'meeting-inspector')

  const list = (await rpc('tools/list')).body?.result as { tools: { name: string }[] }
  assert.deepEqual(
    list.tools.map((t) => t.name).sort(),
    ['get_transcript', 'list_meetings', 'search_transcripts'],
  )
})

test('mcp: list_meetings is newest first', async () => {
  const meetings = JSON.parse((await callTool('list_meetings')).content[0]!.text)
  assert.deepEqual(
    meetings.map((m: { id: string; title: string }) => [m.id, m.title]),
    [
      ['2026-08-27-1400-sprint-planning', 'sprint-planning'],
      ['2026-08-20-1000-retro', 'retro'],
    ],
  )
})

test('mcp: get_transcript resolves speakers to the names the user typed', async () => {
  const t = JSON.parse((await callTool('get_transcript', { id: '2026-08-27-1400-sprint-planning' })).content[0]!.text)
  assert.equal(t.segments.length, 3)
  assert.equal(t.segments[0].speakerName, 'พี่โจ้')
  assert.equal(t.segments[1].speakerName, 'ผม')
})

test('mcp: search spans meetings and carries context', async () => {
  const found = JSON.parse((await callTool('search_transcripts', { query: 'deploy' })).content[0]!.text)
  assert.equal(found.hits.length, 2, 'both meetings mention deploy')
  assert.deepEqual(
    found.hits.map((h: { meetingId: string }) => h.meetingId).sort(),
    ['2026-08-20-1000-retro', '2026-08-27-1400-sprint-planning'],
  )
  const hit = found.hits.find((h: { meetingId: string }) => h.meetingId.endsWith('sprint-planning'))
  assert.equal(hit.speaker, 'พี่โจ้')
  assert.ok(hit.context.some((line: string) => line.includes('rollback')), 'context should include neighbours')

  const none = JSON.parse((await callTool('search_transcripts', { query: 'ไม่มีคำนี้แน่นอน' })).content[0]!.text)
  assert.deepEqual(none.hits, [])
})

test('mcp: an id cannot climb out of the notes folder', async () => {
  const escaped = await callTool('get_transcript', { id: '../../../etc' })
  assert.equal(escaped.isError, true)
})

test('mcp: a busy requested port falls back to the default port', async (t) => {
  // If a real instance of the app is already running on this machine, it's already
  // holding PREFERRED_PORT — stepping down there wouldn't prove the fallback works,
  // it would just collide. Skip rather than assert on a coin flip.
  const probe = await new Promise<ReturnType<typeof createServer> | null>((resolve) => {
    const s = createServer()
    s.once('error', () => resolve(null))
    s.listen(PREFERRED_PORT, '127.0.0.1', () => resolve(s))
  })
  if (!probe) {
    t.skip(`port ${PREFERRED_PORT} is already in use on this machine — skipping to avoid a flaky assertion`)
    return
  }
  await new Promise<void>((resolve) => probe.close(() => resolve()))

  const busy = createServer()
  await new Promise<void>((resolve) => busy.listen(0, '127.0.0.1', () => resolve()))
  const busyPort = (busy.address() as { port: number }).port

  const fellBack = await startMcp({ token: TOKEN, root, port: busyPort })
  try {
    assert.equal(fellBack.port, PREFERRED_PORT)
  } finally {
    await fellBack.close()
    await new Promise<void>((resolve) => busy.close(() => resolve()))
  }
})
