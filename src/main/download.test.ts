import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
// Type-only, so it is erased and does not load the module before MODELS_DIR is set.
import type { ModelSpec } from './download.ts'

// models.ts reads MODELS_DIR at import time, so this has to land first.
const DIR = await mkdtemp(join(tmpdir(), 'download-test-'))
process.env['MODELS_DIR'] = DIR
const { downloadModel } = await import('./download.ts')

const BODY = Buffer.from(Array.from({ length: 50_000 }, (_, i) => i % 251))
let server: Server
let base: string

/** Set to make the server answer a ranged request as if it had no idea what a range is. */
let ignoreRanges = false
/** Set to cut the response short and drop the socket, the way a lost connection does. */
let truncateAfter: number | null = null
const seenRanges: (string | undefined)[] = []

before(async () => {
  server = createServer((req, res) => {
    seenRanges.push(req.headers.range)
    const match = ignoreRanges ? null : /bytes=(\d+)-/.exec(req.headers.range ?? '')
    const from = match ? Number(match[1]) : 0
    const slice = BODY.subarray(from)
    res.writeHead(match ? 206 : 200, {
      'content-length': String(slice.length), // always claims the full length
      ...(match ? { 'content-range': `bytes ${from}-${BODY.length - 1}/${BODY.length}` } : {}),
    })
    if (truncateAfter === null) {
      res.end(slice)
      return
    }
    // Let the bytes actually reach the client before killing the socket — an
    // immediate destroy sends an RST and the client discards them.
    res.write(slice.subarray(0, truncateAfter), () => setTimeout(() => res.socket?.destroy(), 50))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => server.close())

const spec = (file: string): ModelSpec => ({ file, url: `${base}/${file}`, bytes: BODY.length })
const run = (file: string) => downloadModel(spec(file), () => {}, AbortSignal.timeout(10_000))

test('download: a fresh file lands complete and drops its .part', async () => {
  await run('fresh.bin')
  assert.deepEqual(await readFile(join(DIR, 'fresh.bin')), BODY)
  await assert.rejects(stat(join(DIR, 'fresh.bin.part')), 'the partial should be gone')
})

test('download: an interrupted file resumes instead of starting over', async () => {
  const half = 20_000
  await writeFile(join(DIR, 'resume.bin.part'), BODY.subarray(0, half))
  seenRanges.length = 0

  await run('resume.bin')
  assert.deepEqual(seenRanges, [`bytes=${half}-`], 'should have asked only for the tail')
  assert.deepEqual(await readFile(join(DIR, 'resume.bin')), BODY, 'the halves must join up cleanly')
})

test('download: a server that ignores Range still produces the right file', async () => {
  await writeFile(join(DIR, 'ignored.bin.part'), BODY.subarray(0, 12_000))
  ignoreRanges = true
  try {
    await run('ignored.bin')
  } finally {
    ignoreRanges = false
  }
  // Starting over is the only safe move: appending to a full 200 body would corrupt it.
  assert.deepEqual(await readFile(join(DIR, 'ignored.bin')), BODY)
})

test('download: a dropped connection keeps what arrived and never looks complete', async () => {
  truncateAfter = 30_000
  try {
    await assert.rejects(run('short.bin'))
  } finally {
    truncateAfter = null
  }
  await assert.rejects(stat(join(DIR, 'short.bin')), 'a short file must never look complete')
  assert.equal((await stat(join(DIR, 'short.bin.part'))).size, 30_000, 'the prefix is kept to resume from')

  // And the retry finishes the job rather than starting over.
  seenRanges.length = 0
  await run('short.bin')
  assert.deepEqual(seenRanges, ['bytes=30000-'])
  assert.deepEqual(await readFile(join(DIR, 'short.bin')), BODY)
})

test('download: progress reports real byte counts', async () => {
  const seen: { received: number; total: number }[] = []
  await downloadModel(spec('progress.bin'), (p) => seen.push(p), AbortSignal.timeout(10_000))
  assert.ok(seen.length > 0)
  assert.deepEqual(seen.at(-1), { file: 'progress.bin', received: BODY.length, total: BODY.length })
})
