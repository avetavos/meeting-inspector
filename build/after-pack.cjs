// Ad-hoc signs the packaged app.
//
// `identity: null` tells electron-builder to skip signing, which leaves Electron's
// own ad-hoc signature in place — and that signature no longer matches a bundle we
// have added resources to. macOS then treats the app as damaged and refuses to open
// it at all, which is strictly worse than unsigned: there is no "Open Anyway".
//
// Re-signing ad-hoc restores the honest state — unsigned by an identified developer,
// openable with right-click -> Open. Notarizing would need a paid Developer ID.
const { execFileSync } = require('node:child_process')
const { join } = require('node:path')

exports.default = async function afterPack({ appOutDir, packager, electronPlatformName }) {
  if (electronPlatformName !== 'darwin') return
  const app = join(appOutDir, `${packager.appInfo.productFilename}.app`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--strict', '--verbose=2', app], { stdio: 'inherit' })
  console.log(`  • ad-hoc signed  ${app}`)
}
