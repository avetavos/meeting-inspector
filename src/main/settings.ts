import { app } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Provider } from './summarize.ts'

export type Settings = {
  provider: Provider
  models: Partial<Record<Provider, string>>
  mcp: boolean
  /** Off by default: on means meeting transcripts are reachable from the internet. */
  tunnel: boolean
  /** Cloudflare Worker base URL. Empty until the user deploys one. */
  workerUrl: string
}

const DEFAULTS: Settings = { provider: 'claude', models: {}, mcp: false, tunnel: false, workerUrl: '' }
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
