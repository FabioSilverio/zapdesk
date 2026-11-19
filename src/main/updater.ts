// One-click updates. New builds are published to an update folder (scripts/publish-update.mjs writes
// latest.json + the installer there); the app watches it, shows an "update" button, and on click runs
// the installer silently and relaunches itself. Swap UPDATE_DIR for a URL later to update over the internet.
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { UpdateInfo } from '@shared/types'

export const UPDATE_DIR = process.env.ZAP_UPDATE_DIR || path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'zapdesk-updates')

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
    if (!newer(raw.version, app.getVersion())) return null
    const file = path.join(UPDATE_DIR, path.basename(raw.file))
    if (!fs.existsSync(file) || fs.statSync(file).size < 1_000_000) return null
    return { version: raw.version, notes: Array.isArray(raw.notes) ? raw.notes.map(String).slice(0, 12) : [], date: String(raw.date ?? ''), file }
  } catch {
    return null
  }
}

/** checks now, whenever the folder changes, and every 20 min; calls back only when the answer changes */
export function watchUpdates(onChange: (u: UpdateInfo | null) => void) {
  let last = ''
  const check = () => {
    const u = readUpdate()
    const key = u ? u.version + u.file : ''
    if (key === last) return
    last = key
    onChange(u)
  }
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
