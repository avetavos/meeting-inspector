import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bundlePathOf, isNewer, latestUpdate } from './update.ts'

test('update: a version is only newer when it is numerically newer', () => {
  assert.equal(isNewer('0.5.0', '0.4.0'), true)
  assert.equal(isNewer('v0.5.0', '0.4.0'), true, 'the tag keeps its leading v; the comparison must not care')
  assert.equal(isNewer('0.4.1', '0.4.0'), true)
  assert.equal(isNewer('1.0.0', '0.9.9'), true)
  // Numerically, not as strings — this is the one a naive compare gets wrong.
  assert.equal(isNewer('0.10.0', '0.9.0'), true)

  assert.equal(isNewer('0.4.0', '0.4.0'), false, 'the same version is not an update')
  assert.equal(isNewer('0.3.9', '0.4.0'), false)
  // Anything unparseable must read as "no update", never as one: offering a download
  // the user cannot evaluate is worse than staying quiet.
  assert.equal(isNewer('nightly', '0.4.0'), false)
  assert.equal(isNewer('0.4', '0.4.0'), false)
  assert.equal(isNewer('0.4.0', 'unknown'), false)
})

const release = (over: Record<string, unknown> = {}): unknown => ({
  tag_name: 'v0.5.0',
  html_url: 'https://github.com/avetavos/meeting-inspector/releases/tag/v0.5.0',
  assets: [
    { name: 'Meeting.Inspector-0.5.0-arm64.dmg.blockmap', browser_download_url: 'https://x/blockmap', size: 120 },
    { name: 'Meeting.Inspector-0.5.0-arm64.dmg', browser_download_url: 'https://x/app.dmg', size: 122_000_000 },
  ],
  ...over,
})

test('update: the latest release is offered only when it is newer and actually has a .dmg', async () => {
  const found = await latestUpdate('0.4.0', async () => release())
  assert.equal(found?.version, '0.5.0', 'the leading v is stripped — this string is shown to the user')
  assert.equal(found?.url, 'https://x/app.dmg', 'the .dmg, not the .blockmap sitting next to it')
  assert.equal(found?.bytes, 122_000_000)

  assert.equal(await latestUpdate('0.5.0', async () => release()), null, 'already on it')
  assert.equal(await latestUpdate('0.6.0', async () => release()), null, 'ahead of it')

  // A tag pushed before the build finished uploading: nothing to download yet, which is
  // "no update" rather than an error the user can do anything about.
  assert.equal(await latestUpdate('0.4.0', async () => release({ assets: [] })), null)
  assert.equal(await latestUpdate('0.4.0', async () => release({ assets: 'not-a-list' })), null)
  assert.equal(await latestUpdate('0.4.0', async () => release({ tag_name: undefined })), null)

  // Falls back to the releases page when GitHub sends no html_url, so the field is
  // never undefined for a caller that wants somewhere to point.
  const noPage = await latestUpdate('0.4.0', async () => release({ html_url: undefined }))
  assert.match(noPage!.page, /^https:\/\/github\.com\//)
})

test('update: only a real .app bundle can be replaced in place', () => {
  assert.equal(
    bundlePathOf('/Applications/Meeting Inspector.app/Contents/MacOS/Meeting Inspector'),
    '/Applications/Meeting Inspector.app',
  )
  // Path derivation only — it happily finds Electron's OWN bundle under
  // electron-vite dev/preview, which is exactly why index.ts gates the update on
  // `app.isPackaged` before ever calling this, rather than on the result being non-null.
  assert.equal(bundlePathOf('/Users/x/proj/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), '/Users/x/proj/node_modules/electron/dist/Electron.app')
  assert.equal(bundlePathOf('/usr/local/bin/something'), null)
})
