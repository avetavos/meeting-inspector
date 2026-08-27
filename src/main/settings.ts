import { app } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PREFERRED_PORT } from './mcp.ts'
export type Language = 'en' | 'th'

/** How hard to work at ignoring everything that is not speech. Rooms differ. */
export type NoiseFilter = 'low' | 'medium' | 'high'

export type Settings = {
  /** On by default: leaving the app open is how a connected assistant reaches it. */
  mcp: boolean
  /** UI language. English by default; Thai is one switch away in settings. */
  language: Language
  noiseFilter: NoiseFilter
  /** Port the MCP server should hold. Client configs name it, so it is worth keeping. */
  mcpPort: number
}

/** Below 1024 needs root; the app has no business asking for that. Exported so the
 * main-process write path can reject garbage instead of trusting the renderer's copy
 * of this same check. */
export const validPort = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= 1024 && n <= 65535

// mcp.ts's PREFERRED_PORT is the single source of truth for 8787 — a second literal
// here would silently disagree with it if either one moved, and portMoved would start
// lying.
const DEFAULTS: Settings = { mcp: true, language: 'en', noiseFilter: 'medium', mcpPort: PREFERRED_PORT }
const FILE = () => join(app.getPath('userData'), 'settings.json')

/**
 * Reads only the keys this version knows about. Spreading the file wholesale kept
 * settings from removed features alive forever — a stale `provider` and `workerUrl`
 * outlived the code that used them — and let a corrupt value through unchecked.
 */
export async function getSettings(): Promise<Settings> {
  try {
    const stored = JSON.parse(await readFile(FILE(), 'utf8')) as Partial<Settings>
    return {
      mcp: typeof stored.mcp === 'boolean' ? stored.mcp : DEFAULTS.mcp,
      language: stored.language === 'th' || stored.language === 'en' ? stored.language : DEFAULTS.language,
      noiseFilter: ['low', 'medium', 'high'].includes(stored.noiseFilter as string)
        ? (stored.noiseFilter as NoiseFilter)
        : DEFAULTS.noiseFilter,
      mcpPort: validPort(stored.mcpPort) ? stored.mcpPort : DEFAULTS.mcpPort,
    }
  } catch {
    return DEFAULTS
  }
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch }
  await writeFile(FILE(), JSON.stringify(next, null, 2))
  return next
}
