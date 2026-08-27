import { app } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
export type Settings = {
  /** On by default: leaving the app open is how a connected assistant reaches it. */
  mcp: boolean
}

const DEFAULTS: Settings = { mcp: true }
const FILE = () => join(app.getPath('userData'), 'settings.json')

export async function getSettings(): Promise<Settings> {
  try {
    return { ...DEFAULTS, ...(JSON.parse(await readFile(FILE(), 'utf8')) as Settings) }
  } catch {
    return DEFAULTS
  }
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch }
  await writeFile(FILE(), JSON.stringify(next, null, 2))
  return next
}
