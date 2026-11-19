// Renders the app icon SVG to build/icon.png (512px) using Electron's own renderer.
// Run: npx electron scripts/make-icon.cjs
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <radialGradient id="g" cx="32%" cy="26%" r="80%">
      <stop offset="0" stop-color="#8ff5c4"/>
      <stop offset="0.55" stop-color="#2fd38a"/>
      <stop offset="1" stop-color="#159a60"/>
    </radialGradient>
  </defs>
  <path fill="url(#g)" d="M258 28c112 0 214 76 226 196 13 128-78 248-212 262-46 5-90-3-128-22l-74 22c-14 4-27-9-22-23l24-70C40 354 26 306 30 256 40 126 140 28 258 28Z"/>
  <ellipse cx="196" cy="236" rx="30" ry="40" fill="#0b1411"/>
  <ellipse cx="318" cy="236" rx="30" ry="40" fill="#0b1411"/>
  <ellipse cx="206" cy="222" rx="9" ry="12" fill="#fff"/>
  <ellipse cx="328" cy="222" rx="9" ry="12" fill="#fff"/>
  <path d="M210 330c28 26 66 26 94 0" stroke="#0b1411" stroke-width="20" stroke-linecap="round" fill="none"/>
</svg>`

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 512, height: 512, show: false, transparent: true, frame: false, useContentSize: true, webPreferences: { offscreen: true } })
  await win.loadURL('data:text/html,' + encodeURIComponent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`))
  await new Promise((r) => setTimeout(r, 300))
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 })
  const out = path.join(__dirname, '..', 'build')
  fs.mkdirSync(out, { recursive: true })
  fs.writeFileSync(path.join(out, 'icon.png'), img.resize({ width: 512, height: 512 }).toPNG())
  fs.writeFileSync(path.join(out, 'icon.svg'), svg)
  // multi-size .ico (PNG-compressed entries) for the exe, window, tray and taskbar
  const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
  const pngs = sizes.map((s) => img.resize({ width: s, height: s, quality: 'best' }).toPNG())
  const head = Buffer.alloc(6 + 16 * sizes.length)
  head.writeUInt16LE(0, 0)
  head.writeUInt16LE(1, 2)
  head.writeUInt16LE(sizes.length, 4)
  let offset = head.length
  sizes.forEach((s, i) => {
    const e = 6 + i * 16
    head.writeUInt8(s >= 256 ? 0 : s, e)
    head.writeUInt8(s >= 256 ? 0 : s, e + 1)
    head.writeUInt8(0, e + 2)
    head.writeUInt8(0, e + 3)
    head.writeUInt16LE(1, e + 4)
    head.writeUInt16LE(32, e + 6)
    head.writeUInt32LE(pngs[i].length, e + 8)
    head.writeUInt32LE(offset, e + 12)
    offset += pngs[i].length
  })
  fs.writeFileSync(path.join(out, 'icon.ico'), Buffer.concat([head, ...pngs]))
  console.log('icon written', img.getSize())
  app.quit()
})
