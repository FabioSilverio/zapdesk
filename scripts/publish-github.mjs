// Publishes the current version as a public GitHub release, the one every installed Zapdesk checks for updates.
// Builds WITHOUT Apple's SF Pro (it can't be redistributed): the fonts folder is moved aside during the build
// and always put back. usage: node scripts/publish-github.mjs "novidade 1|novidade 2"
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const v = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
const fonts = path.join(root, 'src', 'renderer', 'src', 'assets', 'fonts')
const aside = path.join(os.tmpdir(), 'zapdesk-sf-fonts-' + process.pid)
// npm is a .cmd on Windows (needs a shell); gh is a real exe and must NOT go through one (spaces in args)
const run = (cmd, args, shell = false) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', shell })

const notes = (process.argv.slice(2).join(' ') || '').split('|').map((s) => s.trim()).filter(Boolean)
const body = [
  `**Instalador:** \`Zapdesk-Setup-${v}.exe\` (instala e abre sozinho) · **Portátil:** \`Zapdesk-portable-${v}.exe\` (roda sem instalar)`,
  '',
  'O Zapdesk instalado avisa sozinho quando sai versão nova (botão verde no rodapé).',
  '',
  ...(notes.length ? ['### Novidades', ...notes.map((n) => '- ' + n)] : [])
].join('\n')

const moved = fs.existsSync(fonts)
if (moved) fs.renameSync(fonts, aside)
let setup, portable
try {
  run('npm', ['run', 'dist'], process.platform === 'win32')
  const out = path.join(os.tmpdir(), 'zapdesk-gh-' + v)
  fs.rmSync(out, { recursive: true, force: true })
  fs.mkdirSync(out, { recursive: true })
  setup = path.join(out, `Zapdesk-Setup-${v}.exe`)
  portable = path.join(out, `Zapdesk-portable-${v}.exe`)
  fs.copyFileSync(path.join(root, 'release', `Zapdesk Setup ${v}.exe`), setup)
  fs.copyFileSync(path.join(root, 'release', 'Zapdesk-portable.exe'), portable)
} finally {
  if (moved) {
    fs.mkdirSync(path.dirname(fonts), { recursive: true })
    fs.renameSync(aside, fonts)
  }
}
// the public build must never carry Apple's fonts
const asar = path.join(root, 'release', 'win-unpacked', 'resources', 'app.asar')
if (fs.existsSync(asar) && /sf-pro-display-\d+[^"]*\.otf/.test(fs.readFileSync(asar).toString('latin1'))) {
  console.error('SF Pro found in the public build: not publishing')
  process.exit(1)
}
const notesFile = path.join(path.dirname(setup), 'notes.md')
fs.writeFileSync(notesFile, body)
run('gh', ['release', 'create', 'v' + v, setup, portable, '--title', `Zapdesk ${v}`, '--notes-file', notesFile, '--latest'])
fs.rmSync(path.dirname(setup), { recursive: true, force: true })
console.log(`github release v${v} published`)
