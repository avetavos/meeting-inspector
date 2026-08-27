import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Downloaded once by hand for now — see the README. Spec §12 wants this in-app. */
export const MODELS_DIR = process.env['MODELS_DIR'] ?? join(homedir(), 'whisper-models')

export const model = (name: string): string => join(MODELS_DIR, name)

/**
 * The models are downloaded by hand today, so a fresh machine is missing them rather
 * than broken. Say which file and where, instead of failing somewhere deeper.
 */
export async function requireFiles(paths: string[], hint: string): Promise<void> {
  const missing: string[] = []
  for (const path of paths) {
    if (!(await access(path).then(() => true, () => false))) missing.push(path)
  }
  if (missing.length > 0) throw new Error(`Missing ${missing.join(', ')} — ${hint}`)
}
