// Publishes the freshly built installer to the update folder the installed app watches.
// usage: node scripts/publish-update.mjs "novidade 1|novidade 2"
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const v = pkg.version
const src = path.join(root, 'release', `Zapdesk Setup ${v}.exe`)
if (!fs.existsSync(src)) {
  console.error('installer not found: ' + src)
  process.exit(1)
}
const dir = process.env.ZAP_UPDATE_DIR || path.join(process.env.LOCALAPPDATA, 'zapdesk-updates')
fs.mkdirSync(dir, { recursive: true })
const file = `Zapdesk-Setup-${v}.exe`
fs.copyFileSync(src, path.join(dir, file))
const notes = (process.argv.slice(2).join(' ') || '').split('|').map((s) => s.trim()).filter(Boolean)
fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify({ version: v, file, notes, date: new Date().toISOString() }, null, 2))
// keep only the newest two installers
const old = fs.readdirSync(dir).filter((f) => /^Zapdesk-Setup-.*\.exe$/.test(f) && f !== file)
old.sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs)
for (const f of old.slice(1)) fs.rmSync(path.join(dir, f), { force: true })
console.log(`published ${v} → ${dir}`)
