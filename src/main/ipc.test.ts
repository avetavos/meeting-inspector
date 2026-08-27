import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * IPC channels are plain strings, so nothing else notices when the two sides drift:
 * the compiler cannot see them, and the runtime tests never register a handler.
 *
 * That is not hypothetical — deleting the LLM feature took the model-download
 * handlers with it, and the only symptom was a first-run panel that silently never
 * appeared, because the renderer's `void` swallowed the rejection.
 */
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path: string) => readFile(join(SRC, path), 'utf8')

const matches = (source: string, pattern: RegExp) =>
  new Set([...source.matchAll(pattern)].map((m) => m[1]!))

test('ipc: every channel the preload invokes has a handler in main', async () => {
  const preload = await read('preload/index.ts')
  const main = await read('main/index.ts')

  const invoked = matches(preload, /ipcRenderer\.invoke\(\s*'([^']+)'/g)
  const handled = matches(main, /ipcMain\.handle\(\s*'([^']+)'/g)

  assert.ok(invoked.size > 0, 'expected the preload to invoke something')
  const missing = [...invoked].filter((channel) => !handled.has(channel))
  assert.deepEqual(missing, [], `preload invokes channels main never registers: ${missing.join(', ')}`)
})

test('ipc: every channel the preload listens on is sent by main', async () => {
  const preload = await read('preload/index.ts')
  const main = await read('main/index.ts')

  const listened = matches(preload, /ipcRenderer\.on\(\s*'([^']+)'/g)
  const sent = matches(main, /(?:wc|e\.sender|win\.webContents)\.send\(\s*'([^']+)'/g)

  assert.ok(listened.size > 0, 'expected the preload to listen for something')
  const orphaned = [...listened].filter((channel) => !sent.has(channel))
  assert.deepEqual(orphaned, [], `preload listens for events main never sends: ${orphaned.join(', ')}`)
})

test('ipc: main registers nothing the preload cannot reach', async () => {
  const preload = await read('preload/index.ts')
  const main = await read('main/index.ts')

  const invoked = matches(preload, /ipcRenderer\.invoke\(\s*'([^']+)'/g)
  const handled = matches(main, /ipcMain\.handle\(\s*'([^']+)'/g)

  // A handler nobody calls is usually the other half of something half-deleted.
  const unreachable = [...handled].filter((channel) => !invoked.has(channel))
  assert.deepEqual(unreachable, [], `main registers handlers nothing invokes: ${unreachable.join(', ')}`)
})
