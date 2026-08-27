// Spike: does getDisplayMedia({audio:'loopback'}) actually deliver non-silent PCM
// on this macOS version, for this Electron version? Prints a verdict and exits.
//
// RESULT 2026-08-27, macOS 26.5.2:
//   Electron 38.8.6 (Chromium 140) PASS   <- pinned
//   Electron 37.10.3               PASS
//   Electron 44.0.0 (Chromium 152) FAIL — track exists, PCM is all zeros.
//     Not fixable by flag: MacCatapSystemAudioLoopbackCapture and
//     MacLoopbackAudioForScreenShare, both on and off, all silent. (electron#49607)
const { app, BrowserWindow, desktopCapturer, session, systemPreferences } = require('electron')
const { spawn } = require('child_process')

// Sweep knob: SPIKE_FLAGS="a=b,c" -> chromium switches, to find a combo where loopback works.
for (const f of (process.env.SPIKE_FLAGS || '').split(',').filter(Boolean)) {
  const [k, ...v] = f.split('=')
  app.commandLine.appendSwitch(k, v.join('=') || undefined)
}

app.whenReady().then(async () => {
  console.log(`\n=== flags=${process.env.SPIKE_FLAGS || 'none'} Electron ${process.versions.electron} / Chromium ${process.versions.chrome} ===`)
  console.log(`screen permission: ${systemPreferences.getMediaAccessStatus('screen')}`)
  console.log(`mic permission:    ${systemPreferences.getMediaAccessStatus('microphone')}\n`)

  session.defaultSession.setDisplayMediaRequestHandler(async (_req, callback) => {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      // 4x4 rather than 0x0 — 0x0 triggers GPU texture wrapping errors (electron#49607)
      thumbnailSize: { width: 4, height: 4 },
    })
    callback({ video: sources[0], audio: 'loopback' })
  }, { useSystemPicker: false })

  const win = new BrowserWindow({ width: 640, height: 400, show: true })
  win.webContents.on('console-message', (_e, _lvl, msg) => {
    console.log(msg)
    // Play through a *separate* process so phase B tests audio we did not produce ourselves.
    if (msg === 'PHASE:B') spawn('/bin/sh', ['-c', 'for i in 1 2 3 4 5 6 7 8; do afplay /System/Library/Sounds/Submarine.aiff; done'])
    if (msg.startsWith('VERDICT')) setTimeout(() => app.exit(msg.includes('PASS') ? 0 : 1), 300)
  })
  if (process.env.SPIKE_STOP_VIDEO) win.webContents.on('dom-ready', () => win.webContents.executeJavaScript('window.STOP_VIDEO=1'))
  win.loadFile('index.html')
})
