import { homedir } from 'node:os'
import { join } from 'node:path'

/** Downloaded once by hand for now — see the README. Spec §12 wants this in-app. */
export const MODELS_DIR = process.env['MODELS_DIR'] ?? join(homedir(), 'whisper-models')

export const model = (name: string): string => join(MODELS_DIR, name)
