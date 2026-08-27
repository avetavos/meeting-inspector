import { app, safeStorage } from 'electron'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const KEYS_FILE = () => join(app.getPath('userData'), 'keys.bin')

/**
 * API keys live in main only (spec §5) and never cross into the renderer — it can ask
 * whether a key exists and set a new one, never read one back.
 *
 * safeStorage encrypts against a Keychain-held key on macOS, so the blob on disk is
 * useless on another machine or account.
 */
async function load(): Promise<Record<string, string>> {
  try {
    const blob = await readFile(KEYS_FILE())
    return JSON.parse(safeStorage.decryptString(blob)) as Record<string, string>
  } catch {
    return {}
  }
}

export async function setKey(provider: string, key: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    // Writing the key in the clear would be worse than refusing to store it.
    throw new Error('เก็บ key ไม่ได้ — ระบบเข้ารหัสของเครื่องยังใช้ไม่ได้')
  }
  const keys = await load()
  if (key) keys[provider] = key
  else delete keys[provider]
  await writeFile(KEYS_FILE(), safeStorage.encryptString(JSON.stringify(keys)), { mode: 0o600 })
  // mode only applies when writeFile creates the file; an existing one keeps whatever
  // permissions it already had.
  await chmod(KEYS_FILE(), 0o600)
}

export async function getKey(provider: string): Promise<string | undefined> {
  return (await load())[provider]
}
