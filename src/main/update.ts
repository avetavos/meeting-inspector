import { spawn } from 'node:child_process'
import { mkdtemp, open, readdir, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'

/**
 * In-app updates, done the same way `install.sh` does them: fetch the latest release's
 * .dmg, mount it, and replace the app bundle in place.
 *
 * Not electron-updater, which is the obvious answer and does not work here: Squirrel.Mac
 * refuses to apply an update unless both the running app and the downloaded one carry a
 * valid Developer ID signature, and this app is ad-hoc signed (electron-builder's
 * `identity: null`). Adding the dependency would buy a code path that fails at the last
 * step on every machine. The steps below are the ones the install script already
 * performs and the user has already run once.
 */
const REPO = 'avetavos/meeting-inspector'
const LATEST = `https://api.github.com/repos/${REPO}/releases/latest`

export type UpdateInfo = { version: string; url: string; bytes: number; page: string }
export type UpdateProgress = { received: number; total: number }

/**
 * `1.2.3` newer than `1.2.2`, numerically per part rather than as strings ("10" must
 * beat "9"). Anything that does not parse as three numbers is treated as not newer:
 * a release named something unexpected should be ignored, never offered as an update.
 */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (v: string): number[] | null => {
    const parts = v.replace(/^v/, '').split('.')
    if (parts.length !== 3) return null
    const numbers = parts.map((p) => Number(p))
    return numbers.every((n) => Number.isInteger(n) && n >= 0) ? numbers : null
  }
  const a = parse(candidate)
  const b = parse(current)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!
  }
  return false
}

/** The shape of the GitHub release JSON this actually reads — declared rather than
 * trusted wholesale, since it arrives over the network. */
type Release = {
  tag_name?: unknown
  html_url?: unknown
  assets?: unknown
}

/**
 * The latest release, or null when this build is already it. Exported with `fetchJson`
 * injectable so the version/asset picking can be exercised without a network call.
 *
 * A release with no .dmg attached (a tag pushed before the build finished uploading)
 * reads as "nothing to update to" rather than as an error: there is genuinely nothing
 * to download yet, and saying so is more useful than a failure the user cannot act on.
 */
export async function latestUpdate(
  current: string,
  fetchJson: (url: string) => Promise<unknown> = defaultFetchJson,
): Promise<UpdateInfo | null> {
  const release = (await fetchJson(LATEST)) as Release
  const version = typeof release?.tag_name === 'string' ? release.tag_name.replace(/^v/, '') : ''
  if (!isNewer(version, current)) return null

  const assets = Array.isArray(release.assets) ? release.assets : []
  const dmg = assets.find(
    (a): a is { name: string; browser_download_url: string; size: number } =>
      typeof a?.name === 'string' &&
      a.name.endsWith('.dmg') &&
      typeof a?.browser_download_url === 'string' &&
      typeof a?.size === 'number',
  )
  if (!dmg) return null

  return {
    version,
    url: dmg.browser_download_url,
    bytes: dmg.size,
    page: typeof release.html_url === 'string' ? release.html_url : `https://github.com/${REPO}/releases`,
  }
}

async function defaultFetchJson(url: string): Promise<unknown> {
  // GitHub rejects API requests with no User-Agent.
  const res = await fetch(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': REPO } })
  if (!res.ok) throw new Error(`GitHub: ${res.status} ${res.statusText}`)
  return res.json()
}

/**
 * Downloads the .dmg to a throwaway directory and returns its path. Same streaming
 * shape as download.ts's model downloader, minus the resume: an interrupted app update
 * is 117MB to redo, not three gigabytes, and a half-file kept around between launches
 * would be a stale version waiting to be installed by mistake.
 */
export async function downloadUpdate(
  info: UpdateInfo,
  onProgress: (progress: UpdateProgress) => void,
  signal: AbortSignal,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'meeting-inspector-update-'))
  const part = join(dir, 'update.dmg.part')
  const target = join(dir, 'update.dmg')

  const res = await fetch(info.url, { signal })
  if (!res.ok || !res.body) throw new Error(`download: ${res.status} ${res.statusText}`)
  const total = Number(res.headers.get('content-length') ?? info.bytes)

  const handle = await open(part, 'w')
  let received = 0
  let announced = 0
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      await handle.write(chunk)
      received += chunk.length
      if (received - announced > 2_000_000 || received === total) {
        announced = received
        onProgress({ received, total })
      }
    }
  } finally {
    await handle.close()
  }
  // A short file must never be handed to hdiutil as if it were a whole disk image.
  if (received !== total) throw new Error(`download: got ${received} bytes of ${total}`)
  await rename(part, target)
  onProgress({ received, total })
  return target
}

/** `execPath` is …/Meeting Inspector.app/Contents/MacOS/Meeting Inspector; the bundle
 * is three levels up. Returns null when there is no .app above the executable at all.
 *
 * This is path arithmetic, not a safety check: under `electron-vite dev`/`preview` it
 * finds Electron's own bundle inside node_modules, which must never be replaced. The
 * caller (index.ts) gates on `app.isPackaged` first. */
export function bundlePathOf(execPath: string): string | null {
  const bundle = dirname(dirname(dirname(execPath)))
  return bundle.endsWith('.app') && bundle.split(sep).length > 1 ? bundle : null
}

const run = (command: string, args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))))
  })

/**
 * Mounts the downloaded image and puts the app inside it where the running one is.
 *
 * The swap is move-then-copy, not copy-over: the old bundle is moved aside first, so a
 * copy that fails halfway can put it back rather than leaving a half-written app at the
 * path the Dock points at. macOS lets a running executable's bundle be moved and
 * replaced (the process holds its own inode), which is what makes replacing yourself
 * from inside possible at all — and why the caller must relaunch immediately after.
 *
 * Nothing here strips quarantine: the .dmg was fetched by this process rather than by a
 * browser, so it never picks the attribute up in the first place.
 */
export async function installUpdate(dmgPath: string, bundle: string): Promise<void> {
  const mount = await mkdtemp(join(tmpdir(), 'meeting-inspector-mount-'))
  const staged = `${bundle}.incoming`
  const previous = `${bundle}.previous`

  try {
    await run('hdiutil', ['attach', '-nobrowse', '-quiet', '-readonly', '-mountpoint', mount, dmgPath])
    const app = (await readdir(mount)).find((entry) => entry.endsWith('.app'))
    if (!app) throw new Error('no .app inside the downloaded image')
    // Copied out of the image before unmounting, so the swap below never depends on a
    // mount staying alive, and `ditto` (not cp) so the bundle's signature survives.
    await rm(staged, { recursive: true, force: true })
    await run('ditto', [join(mount, app), staged])
  } finally {
    await run('hdiutil', ['detach', '-quiet', mount]).catch(() => {})
    await rm(mount, { recursive: true, force: true }).catch(() => {})
  }

  await rm(previous, { recursive: true, force: true })
  await rename(bundle, previous)
  try {
    await rename(staged, bundle)
  } catch (err) {
    await rename(previous, bundle).catch(() => {})
    throw err
  }
  await rm(previous, { recursive: true, force: true }).catch(() => {})
  await rm(dirname(dmgPath), { recursive: true, force: true }).catch(() => {})
}
