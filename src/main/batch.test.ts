import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runBatch, type BatchProgress } from './batch.ts'

test('batch: runs meetings one at a time, in order', async () => {
  const running: string[] = []
  let concurrent = 0
  let maxConcurrent = 0
  const done: string[] = []

  await runBatch(
    ['a', 'b', 'c'],
    async (id) => {
      running.push(id)
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await new Promise((r) => setTimeout(r, 5))
      concurrent--
    },
    new AbortController().signal,
    () => {},
    () => {},
    (progress, status) => {
      if (status === 'done') done.push(progress.id)
    },
  )

  assert.deepEqual(running, ['a', 'b', 'c'])
  assert.deepEqual(done, ['a', 'b', 'c'])
  assert.equal(maxConcurrent, 1, 'never two meetings transcribing at once')
})

test('batch: one meeting failing does not stop the rest', async () => {
  const finished: { id: string; status: string }[] = []

  const result = await runBatch(
    ['a', 'b', 'c'],
    async (id) => {
      if (id === 'b') throw new Error('whisper-server would not start')
    },
    new AbortController().signal,
    () => {},
    () => {},
    (progress, status) => finished.push({ id: progress.id, status }),
  )

  assert.deepEqual(finished, [
    { id: 'a', status: 'done' },
    { id: 'b', status: 'failed' },
    { id: 'c', status: 'done' },
  ])
  assert.equal(result.cancelled, false)
})

test('batch: reports index/total as it goes', async () => {
  const starts: BatchProgress[] = []

  await runBatch(
    ['a', 'b'],
    async () => {},
    new AbortController().signal,
    (progress) => starts.push(progress),
    () => {},
    () => {},
  )

  assert.deepEqual(starts, [
    { id: 'a', index: 1, total: 2 },
    { id: 'b', index: 2, total: 2 },
  ])
})

test('batch: cancelling before a meeting starts skips it, and it is never marked done', async () => {
  const controller = new AbortController()
  const finished: { id: string; status: string }[] = []

  const result = await runBatch(
    ['a', 'b', 'c'],
    async (id) => {
      if (id === 'a') controller.abort() // cancel while 'a' is still "running"
    },
    controller.signal,
    () => {},
    () => {},
    (progress, status) => finished.push({ id: progress.id, status }),
  )

  // 'a' still gets to finish (it was already running when cancel landed) and is
  // legitimately done; 'b' and 'c' never start once the signal is aborted.
  assert.deepEqual(finished, [{ id: 'a', status: 'done' }])
  assert.equal(result.cancelled, true)
})

test('batch: a meeting aborted mid-pass is reported failed, never done', async () => {
  const controller = new AbortController()
  const finished: { id: string; status: string }[] = []

  await runBatch(
    ['a', 'b'],
    async (id, _onProgress, signal) => {
      controller.abort()
      if (signal.aborted) throw new Error('cancelled')
    },
    controller.signal,
    () => {},
    () => {},
    (progress, status) => finished.push({ id: progress.id, status }),
  )

  assert.deepEqual(finished, [{ id: 'a', status: 'failed' }], 'b never starts once cancelled')
})
