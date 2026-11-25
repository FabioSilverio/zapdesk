// One-click updates, from two places:
//  - an update folder on this PC (scripts/publish-update.mjs writes latest.json + the installer there)
//  - the public GitHub releases (any PC: installed from GitHub, the app finds new versions there)
// The app shows an "update" button; on click it downloads if needed, runs the installer silently and relaunches.
import { app, net } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { UpdateInfo } from '@shared/types'

export const UPDATE_DIR = process.env.ZAP_UPDATE_DIR || path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'zapdesk-updates')

const REPO = 'FabioSilverio/zapdesk'
const DL_DIR = () => path.join(app.getPath('userData'), 'updates')
/** dev: pretend to be an older build to exercise the update path */
const appVersion = () => process.env.ZAP_FAKE_VERSION || app.getVersion()

/** 1.2.10 > 1.2.9 */
export function newer(a: string, b: string) {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0)
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0)
  return false
}

export function readUpdate(): UpdateInfo | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(UPDATE_DIR, 'latest.json'), 'utf8'))
    if (typeof raw?.version !== 'string' || typeof raw?.file !== 'string') return null
    if (!newer(raw.version, appVersion())) return null
    const file = path.join(UPDATE_DIR, path.basename(raw.file))
    if (!fs.existsSync(file) || fs.statSync(file).size < 1_000_000) return null
    return { version: raw.version, notes: Array.isArray(raw.notes) ? raw.notes.map(String).slice(0, 12) : [], date: String(raw.date ?? ''), file }
  } catch {
    return null
  }
}

// ---------- GitHub releases ----------
type Remote = UpdateInfo & { url: string; size: number }
let remote: Remote | null = null

/** latest public release; only an installer asset named Zapdesk-Setup-<v>.exe counts */
export async function checkGitHub() {
  try {
    const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { 'User-Agent': 'Zapdesk-updater', Accept: 'application/vnd.github+json' }
    })
    if (!res.ok) return
    const r = (await res.json()) as any
    const version = String(r?.tag_name ?? '').replace(/^v/i, '')
    const asset = (r?.assets as any[] | undefined)?.find((a) => /^Zapdesk-Setup-[\d.]+\.exe$/i.test(String(a?.name)))
    if (!asset || !/^\d+\.\d+\.\d+$/.test(version) || !newer(version, appVersion())) {
      remote = null
      return
    }
    const notes = String(r.body ?? '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^[-*•]\s+/.test(l))
      .map((l) => l.replace(/^[-*•]\s+/, '').replace(/\*\*/g, '').replace(/`/g, ''))
      .slice(0, 12)
    remote = { version, notes, date: String(r.published_at ?? ''), file: path.join(DL_DIR(), path.basename(String(asset.name))), remote: true, url: String(asset.browser_download_url), size: Number(asset.size) || 0 }
  } catch {
    /* offline: try again later */
  }
}

/** the update to offer: the local folder's when it's at least as new, else GitHub's */
export function currentUpdate(): UpdateInfo | null {
  const local = readUpdate()
  if (local && (!remote || !newer(remote.version, local.version))) return local
  if (!remote) return null
  const { url: _u, size: _s, ...info } = remote
  return info
}

const isDownloaded = (r: Remote) => {
  try {
    return fs.statSync(r.file).size === r.size && r.size > 1_000_000
  } catch {
    return false
  }
}

/** downloads the GitHub installer (once), reporting 0-100 */
export async function downloadRemote(onProgress: (pct: number) => void): Promise<boolean> {
  const r = remote
  if (!r) return false
  if (isDownloaded(r)) return true
  fs.mkdirSync(path.dirname(r.file), { recursive: true })
  // old installers never pile up
  for (const f of fs.readdirSync(path.dirname(r.file))) if (f !== path.basename(r.file)) fs.rmSync(path.join(path.dirname(r.file), f), { force: true })
  const res = await net.fetch(r.url, { headers: { 'User-Agent': 'Zapdesk-updater' } })
  if (!res.ok || !res.body) throw new Error('download falhou (' + res.status + ')')
  const part = r.file + '.part'
  const out = fs.createWriteStream(part)
  const reader = res.body.getReader()
  let got = 0
  let last = -1
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!out.write(value)) await new Promise<void>((ok) => out.once('drain', () => ok()))
      got += value.byteLength
      const pct = r.size ? Math.min(99, Math.floor((got / r.size) * 100)) : 0
      if (pct !== last) {
        last = pct
        onProgress(pct)
      }
    }
    await new Promise<void>((ok, fail) => out.end((e?: Error | null) => (e ? fail(e) : ok())))
  } catch (err) {
    out.destroy()
    fs.rmSync(part, { force: true })
    throw err
  }
  if (r.size && fs.statSync(part).size !== r.size) {
    fs.rmSync(part, { force: true })
    throw new Error('download incompleto')
  }
  fs.renameSync(part, r.file)
  onProgress(100)
  return true
}

/** checks now, whenever the folder changes, every 20 min (GitHub every 3 h); calls back only when the answer changes */
export function watchUpdates(onChange: (u: UpdateInfo | null) => void) {
  let last = ''
  const check = () => {
    const u = currentUpdate()
    const key = u ? u.version + u.file : ''
    if (key === last) return
    last = key
    onChange(u)
  }
  const gh = () => void checkGitHub().then(check)
  setTimeout(gh, 12_000)
  setInterval(gh, 3 * 3600_000).unref()
  try {
    fs.mkdirSync(UPDATE_DIR, { recursive: true })
    let t: ReturnType<typeof setTimeout> | undefined
    // the installer is copied before latest.json is written: settle a moment after the last change
    fs.watch(UPDATE_DIR, () => {
      clearTimeout(t)
      t = setTimeout(check, 1500)
    }).on('error', () => {})
  } catch {
    /* no folder access: the timer still works */
  }
  setTimeout(check, 4000)
  setInterval(check, 20 * 60_000).unref()
}

/** runs the installer silently (NSIS: /S, --force-run reopens the app when done) */
export function runInstaller(u: UpdateInfo) {
  const child = spawn(u.file, ['--updated', '/S', '--force-run'], { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
}
