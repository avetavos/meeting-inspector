import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { getSettings, setSettings } from './settings.ts'

/**
 * settings.ts reads `SETTINGS_FILE` fresh on every call (voices.ts's voicesFile()
 * pattern), not once at import time (models.ts's MODELS_DIR pattern) — so, unlike
 * whisper.test.ts/download.test.ts, there is no need to set the env var before the
 * static import above; each test just points it at its own fresh, empty directory.
 */
async function freshSettingsFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'settings-test-'))
  const file = join(dir, 'settings.json')
  process.env['SETTINGS_FILE'] = file
  return file
}

test('getSettings: no file at all is a genuine first run — onboarded is false', async () => {
  await freshSettingsFile() // mkdtemp only; the settings.json itself is never written
  assert.equal((await getSettings()).onboarded, false)
})

test('getSettings: a file that predates the onboarded field reads as an existing user, not a fresh install', async () => {
  const file = await freshSettingsFile()
  // No `onboarded` key at all — exactly what upgrading from before this field existed
  // looks like on disk.
  await writeFile(file, JSON.stringify({ language: 'th' }))
  const settings = await getSettings()
  assert.equal(settings.onboarded, true, 'must not be dumped into onboarding just for upgrading')
  assert.equal(settings.language, 'th', 'a known key from before the field still applies')
})

test('getSettings: an explicit onboarded:false is honoured (mid-onboarding, not yet finished)', async () => {
  const file = await freshSettingsFile()
  await writeFile(file, JSON.stringify({ onboarded: false }))
  assert.equal((await getSettings()).onboarded, false)
})

test('getSettings: an explicit onboarded:true is honoured', async () => {
  const file = await freshSettingsFile()
  await writeFile(file, JSON.stringify({ onboarded: true }))
  assert.equal((await getSettings()).onboarded, true)
})

test('getSettings: a corrupt file still reads as an existing user, not a fresh install (LOW-MEDIUM 6)', async () => {
  const file = await freshSettingsFile()
  // What a crash mid-write (the bug atomic writes now prevent) used to leave behind.
  await writeFile(file, '{not json')
  const settings = await getSettings()
  assert.equal(settings.onboarded, true, 'a file that exists at all means someone had already set this app up')
  assert.equal(settings.mcp, true, 'every other field falls back to DEFAULTS')
  assert.equal(settings.asrModel, 'turbo')
})

test('setSettings: writes atomically — no stray .tmp file left behind, and the file holds the new value', async () => {
  const file = await freshSettingsFile()
  await setSettings({ language: 'th' })
  const entries = await readdir(join(file, '..'))
  assert.deepEqual(entries.filter((n) => n.includes('.tmp')), [], 'no partial-write artifact left on disk')
  assert.equal((JSON.parse(await readFile(file, 'utf8')) as { language: string }).language, 'th')
})

test('setSettings: an out-of-range value from an untrusted caller does not survive the round trip', async () => {
  await freshSettingsFile()
  const settings = await setSettings({ mcpPort: -1 } as never)
  assert.equal(settings.mcpPort, 8787, 'falls back to DEFAULTS.mcpPort rather than persisting garbage')
})
