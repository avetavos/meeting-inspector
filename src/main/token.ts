import { randomBytes } from 'node:crypto'
import { chmod, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'

/**
 * The bearer token for the local MCP server.
 *
 * This used to live in the Keychain via safeStorage, and that cost a password prompt
 * after every install: Keychain access is granted per binary signature, the app is
 * ad-hoc signed, and an ad-hoc signature changes with every rebuild — so macOS sees a
 * different application asking for the same item each time. "Always Allow" only ever
 * whitelists the exact build that asked.
 *
 * Keychain was buying nothing here anyway. The token guards a loopback-only server
 * whose data — the transcripts — sits in plain files in ~/Documents/MeetingNotes, and
 * the token itself is already stored in plaintext in the MCP client configs it is
 * pasted into, and shown in the app's own settings panel. Encrypting our copy while
 * the thing it protects lies in the open next door is theatre with a password prompt
 * attached. A 0600 file in the app's data directory is the honest equivalent.
 *
 * A signed build with a stable Developer ID would keep the Keychain quiet, but that
 * needs a paid Apple developer account, and it would still not make the token secret.
 */
const TOKEN_FILE = () => join(app.getPath('userData'), 'mcp-token')
const LEGACY_FILE = () => join(app.getPath('userData'), 'keys.bin')

async function write(token: string): Promise<string> {
  await writeFile(TOKEN_FILE(), token, { mode: 0o600 })
  // mode only applies when writeFile creates the file; an existing one keeps its own.
  await chmod(TOKEN_FILE(), 0o600)
  return token
}

/**
 * One last Keychain prompt on the first launch after upgrading, so the token the
 * user has already pasted into their client configs survives the move.
 */
async function migrate(): Promise<string | null> {
  const blob = await readFile(LEGACY_FILE()).catch(() => null)
  if (!blob) return null
  try {
    const keys = JSON.parse(safeStorage.decryptString(blob)) as Record<string, string>
    const token = keys['mcp']
    if (token) await write(token)
    return token ?? null
  } catch {
    return null
  } finally {
    // Either it moved or it is unreadable; either way it must not ask again.
    await rm(LEGACY_FILE(), { force: true })
  }
}

/** Generated once and kept — it is the only thing guarding the transcripts. */
export async function mcpToken(): Promise<string> {
  const stored = await readFile(TOKEN_FILE(), 'utf8').catch(() => '')
  if (stored.trim()) return stored.trim()
  return (await migrate()) ?? (await write(randomBytes(24).toString('base64url')))
}

/**
 * The user's own OpenRouter key, when they have chosen to transcribe off-machine.
 *
 * A 0600 file next to the MCP token, for the same reasons spelled out above: the
 * Keychain costs a password prompt on every rebuild of an ad-hoc-signed app, and buys
 * little here — anything that can read this file can read the transcripts it would be
 * used to produce. Never sent anywhere except openrouter.ai, and never handed back to
 * the renderer: the settings panel only ever learns whether one is set.
 */
const OPENROUTER_FILE = () => join(app.getPath('userData'), 'openrouter-key')

export async function openrouterKey(): Promise<string> {
  return (await readFile(OPENROUTER_FILE(), 'utf8').catch(() => '')).trim()
}

/** A blank key removes the file outright rather than leaving an empty one behind. */
export async function setOpenrouterKey(key: string): Promise<void> {
  const trimmed = key.trim()
  if (!trimmed) {
    await rm(OPENROUTER_FILE(), { force: true })
    return
  }
  await writeFile(OPENROUTER_FILE(), trimmed, { mode: 0o600 })
  await chmod(OPENROUTER_FILE(), 0o600)
}
