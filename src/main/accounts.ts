import fs from 'node:fs'
import path from 'node:path'
import type { Settings } from '@shared/types'
import { defaultSettings, readJson, writeAtomic } from './store'

/** app-wide state shared by every account: settings + the PIN */
export interface AppMeta {
  settings: Settings
  pinHash?: string
  pinSalt?: string
  pinLength?: number
  migrations?: string[]
}

export class AppConfig {
  meta: AppMeta
  private file: string
  private timer: NodeJS.Timeout | null = null

  constructor(userData: string, seed: () => Partial<AppMeta> | undefined) {
    this.file = path.join(userData, 'app.json')
    const existed = fs.existsSync(this.file) || fs.existsSync(this.file + '.bak')
    const saved = existed ? readJson<Partial<AppMeta>>(this.file, {}) : (seed() ?? {})
    this.meta = {
      ...saved,
      settings: mergeSettings(saved.settings)
    }
    this.migrate(existed)
    this.flush()
  }

  private migrate(existed: boolean) {
    const done = new Set(this.meta.migrations ?? [])
    if (!done.has('pinned-list')) {
      // pinned chats moved from big vertical tiles to a highlighted row section
      this.meta.settings.appearance.pinned = 'lista'
      done.add('pinned-list')
    }
    if (!done.has('glass-on')) {
      // the new Liquid Glass look is the default for everyone (Aparência → Vidro turns it off)
      this.meta.settings.appearance.glass = true
      done.add('glass-on')
    }
    if (!done.has('font-choice')) {
      // fonts became a choice (SF Pro can't ship in the public build): whoever already used the app keeps
      // the look they had; a brand-new install leaves it unset so the first launch asks
      if (existed && !this.meta.settings.appearance.font) this.meta.settings.appearance.font = 'sf'
      done.add('font-choice')
    }
    if (!done.has('auto-transcribe-on')) {
      // voice notes you receive come with the text already (Configurações → Transcrição turns it off)
      this.meta.settings.autoTranscribe = true
      done.add('auto-transcribe-on')
    }
    this.meta.migrations = [...done]
  }

  markMeta() {
    if (this.timer) return
    this.timer = setTimeout(() => this.flush(), 800)
  }

  flush() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    try {
      writeAtomic(this.file, this.meta)
    } catch (err) {
      console.error('[config] write failed', err)
    }
  }
}

export function mergeSettings(s?: Partial<Settings>): Settings {
  return {
    ...defaultSettings,
    ...(s ?? {}),
    appearance: { ...defaultSettings.appearance, ...(s?.appearance ?? {}) },
    ghost: { ...defaultSettings.ghost, ...(s?.ghost ?? {}) }
  }
}

export interface AccountInfo {
  id: string
  /** data folder, relative to userData */
  dir: string
  label?: string
  phone?: string
  /** 'wa' (default, older accounts have no kind) or 'tg' */
  kind?: 'wa' | 'tg'
}

/** accounts.json: which WhatsApp accounts exist and which one is on screen */
export class AccountList {
  active: string
  list: AccountInfo[]
  private file: string

  constructor(private userData: string) {
    this.file = path.join(userData, 'accounts.json')
    const saved = readJson<{ active?: string; list?: AccountInfo[] }>(this.file, {})
    // the first install kept everything in /data: that becomes account #1
    this.list = saved.list?.length ? saved.list : [{ id: 'a1', dir: 'data' }]
    this.active = saved.active && this.list.some((a) => a.id === saved.active) ? saved.active : this.list[0].id
    this.save()
  }

  dirOf(a: AccountInfo) {
    return path.join(this.userData, a.dir)
  }

  get(id: string) {
    return this.list.find((a) => a.id === id)
  }

  add(kind: 'wa' | 'tg' = 'wa'): AccountInfo {
    const id = 'a' + Date.now().toString(36)
    const info: AccountInfo = { id, dir: path.join('accounts', id), kind }
    this.list.push(info)
    this.save()
    return info
  }

  remove(id: string) {
    this.list = this.list.filter((a) => a.id !== id)
    if (this.active === id) this.active = this.list[0]?.id ?? ''
    this.save()
  }

  update(id: string, patch: Partial<AccountInfo>) {
    const a = this.get(id)
    if (!a) return
    Object.assign(a, patch)
    this.save()
  }

  save() {
    try {
      writeAtomic(this.file, { active: this.active, list: this.list })
    } catch (err) {
      console.error('[accounts] write failed', err)
    }
  }
}
