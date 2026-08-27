// Draws build/icon.icns. Run with `npm run icon`.
//
// Electron does the rasterizing because it is already a dependency — pulling in
// librsvg or ImageMagick just to draw ten squares would not be worth it.
import { app, BrowserWindow } from 'electron'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

// Two rows of bars: what everyone else said, and what you said, never mixed —
// the decision the whole app is built around.
const OTHERS = [80, 152, 106, 128]
const YOU = [120, 74, 158, 96]

const bars = (heights, y, fill) =>
  heights
    .map((h, i) => `<rect x="${165 + i * 190}" y="${y - h}" width="124" height="${h * 2}" rx="62" fill="${fill}"/>`)
    .join('')

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.4" y2="1">
      <stop offset="0" stop-color="#4C3BCF"/>
      <stop offset="1" stop-color="#1B1141"/>
    </linearGradient>
  </defs>
  <!-- Apple's macOS grid: 824 of artwork inside a 1024 canvas, so this sits at the
       same visual size as every other icon in the Dock rather than looking oversized. -->
  <g transform="translate(100 100) scale(0.8047)">
    <rect width="1024" height="1024" rx="230" fill="url(#bg)"/>
    ${bars(OTHERS, 330, '#A99CFF')}
    ${bars(YOU, 694, '#FFFFFF')}
  </g>
</svg>`

// name -> pixel size. macOS wants every rung of this ladder present.
const SIZES = {
  'icon_16x16': 16,
  'icon_16x16@2x': 32,
  'icon_32x32': 32,
  'icon_32x32@2x': 64,
  'icon_128x128': 128,
  'icon_128x128@2x': 256,
  'icon_256x256': 256,
  'icon_256x256@2x': 512,
  'icon_512x512': 512,
  'icon_512x512@2x': 1024,
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, webPreferences: { offscreen: true } })
  await win.loadURL(`data:text/html,<body style="margin:0;background:transparent">${encodeURIComponent(svg)}</body>`)
  await new Promise((r) => setTimeout(r, 400))

  const work = mkdtempSync(join(tmpdir(), 'icon-'))
  const master = join(work, 'master.png')
  writeFileSync(master, (await win.webContents.capturePage()).toPNG())

  const iconset = join(work, 'icon.iconset')
  execFileSync('mkdir', ['-p', iconset])
  for (const [name, size] of Object.entries(SIZES)) {
    execFileSync('sips', ['-Z', String(size), master, '--out', join(iconset, `${name}.png`)], { stdio: 'ignore' })
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(HERE, 'icon.icns')])

  console.log('wrote build/icon.icns')
  app.exit(0)
})
