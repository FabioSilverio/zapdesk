import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { BufferJSON, type WAMessage } from 'baileys'
import type { Reminder, ScheduledMsg, Settings } from '@shared/types'

export interface ChatRec {
  id: string
  name?: string
  ts: number
  unread: number
  markedUnread?: boolean
  waPinned?: number
  localPin?: number
  section?: string
  muteUntil?: number
  archived?: boolean
  preview?: string
  previewFromMe?: boolean
  previewSender?: string
  lastMsgId?: string
  /** local rename ("Eu (Anotações)") */
  alias?: string
  /** Telegram: peer type + access hash (lets us talk to it before the dialog list loads) */
  tg?: { t: 'user' | 'bot' | 'group' | 'channel' | 'self'; hash?: string; contact?: boolean; readOut?: number; megagroup?: boolean }
}

export interface ContactRec {
  id: string
  name?: string
  notify?: string
  verifiedName?: string
  phoneNumber?: string
  tgHash?: string
}

export interface StickerRec {
  id: string
  source: 'account' | 'local'
  url?: string
  directPath?: string
  mediaKey?: string
  mimetype?: string
  width?: number
  height?: number
  fileLength?: number
  ts: number
  failed?: number
}

export interface Bucket {
  msgs: Map<string, WAMessage>
  reactions: Map<string, Record<string, string>>
  sorted?: WAMessage[]
  touched: number
}

export interface Meta {
  settings: Settings
  pinHash?: string
  pinSalt?: string
  pinLength?: number
  lidToPn: Record<string, string>
  stickers: StickerRec[]
  removedStickers: string[]
  waVersion?: [number, number, number]
  scheduled: ScheduledMsg[]
  reminders: Reminder[]
  migrations?: string[]
  /** voice-note transcriptions by message id */
  transcripts?: Record<string, string>
}

const MAX_PER_CHAT = 4000
const MAX_LOADED = 40

export const defaultSettings: Settings = {
  appearance: {
    theme: 'verde',
    accent: null,
    density: 'confortavel',
    messages: 'bolhas',
    pinned: 'grade',
    radius: 'suave',
    fontSize: 14,
    sidebarWidth: 264,
    autoScale: true,
    zoom: 1,
    glass: true
  },
  sections: ['pessoal', 'trabalho'],
  escClosesChat: true,
  keepDeleted: true,
  ghost: { noReadReceipts: false, noTyping: false, hideOnline: false },
  privacyBlur: false,
  linkPreviews: true,
  hoverPeek: true,
  autoTranscribe: true,
  quickReplies: [
    { key: 'oi', text: 'Oi! Tudo bem?' },
    { key: 'ja', text: 'Já te respondo 🙏' },
    { key: 'obg', text: 'Muito obrigado!' }
  ],
  lockMinutes: 10,
  notifications: true,
  notifyPreview: true,
  closeToTray: true,
  startWithWindows: false,
  sound: true
}

export const tsOf = (m: WAMessage): number => {
  const t: any = m.messageTimestamp
  if (!t) return 0
  if (typeof t === 'number') return t * 1000
  if (typeof t === 'object' && 'toNumber' in t) return t.toNumber() * 1000
  if (typeof t === 'object' && 'low' in t) return t.low * 1000
  return Number(t) * 1000
}

const safeName = (jid: string) => jid.replace(/[^a-zA-Z0-9@._-]/g, '_')

/** reads JSON; a corrupt/half-written file falls back to its last good copy (.bak) */
export function readJson<T>(file: string, fallback: T): T {
  for (const f of [file, file + '.bak']) {
    try {
      if (!fs.existsSync(f)) continue
      return JSON.parse(fs.readFileSync(f, 'utf8'), BufferJSON.reviver) as T
    } catch (err) {
      console.error('[store] unreadable', f, (err as Error).message)
    }
  }
  return fallback
}

/** write tmp → keep previous as .bak → swap in. A crash mid-write never loses the last good version. */
export function writeAtomic(file: string, data: unknown) {
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, BufferJSON.replacer))
  try {
    if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak')
  } catch {}
  fs.renameSync(tmp, file)
}

export class Store {
  chats = new Map<string, ChatRec>()
  contacts = new Map<string, ContactRec>()
  buckets = new Map<string, Bucket>()
  meta: Meta
  private dirtyChats = new Set<string>()
  private dirtyMeta = false
  private dirtyList = false
  private timer: NodeJS.Timeout | null = null

  // ---------- video posters: the first frame, grabbed once and kept (sharp preview, no download) ----------
  private posters?: Set<string>
  posterFile(chatId: string, msgId: string) {
    return path.join(this.dir, 'posters', createHash('sha1').update(chatId + '/' + msgId).digest('hex') + '.jpg')
  }
  hasPoster(chatId: string, msgId: string) {
    if (!this.posters) {
      try {
        this.posters = new Set(fs.readdirSync(path.join(this.dir, 'posters')))
      } catch {
        this.posters = new Set()
      }
    }
    return this.posters.has(path.basename(this.posterFile(chatId, msgId)))
  }
  savePoster(chatId: string, msgId: string, jpeg: Buffer) {
    if (jpeg.length < 200 || jpeg.length > 2_000_000) return
    const file = this.posterFile(chatId, msgId)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, jpeg)
    this.hasPoster(chatId, msgId)
    this.posters!.add(path.basename(file))
  }

  constructor(public dir: string) {
    fs.mkdirSync(path.join(dir, 'msgs'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'media'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'stickers'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'avatars'), { recursive: true })
    for (const c of readJson<ChatRec[]>(path.join(dir, 'chats.json'), [])) this.chats.set(c.id, c)
    for (const c of readJson<ContactRec[]>(path.join(dir, 'contacts.json'), [])) this.contacts.set(c.id, c)
    const meta = readJson<Partial<Meta>>(path.join(dir, 'meta.json'), {})
    this.meta = {
      lidToPn: {},
      stickers: [],
      removedStickers: [],
      scheduled: [],
      reminders: [],
      ...meta,
      settings: {
        ...defaultSettings,
        ...(meta.settings ?? {}),
        appearance: { ...defaultSettings.appearance, ...(meta.settings?.appearance ?? {}) },
        ghost: { ...defaultSettings.ghost, ...(meta.settings?.ghost ?? {}) }
      }
    }
  }

  /** one-time settings migrations */
  migrate() {
    const done = new Set(this.meta.migrations ?? [])
    if (!done.has('pinned-list')) {
      // pinned chats moved from big vertical tiles to a highlighted row section
      this.meta.settings.appearance.pinned = 'lista'
      done.add('pinned-list')
    }
    this.meta.migrations = [...done]
    this.markMeta()
  }

  /** forget a chat completely (messages file included) */
  removeChat(chatId: string) {
    this.chats.delete(chatId)
    this.buckets.delete(chatId)
    this.dirtyChats.delete(chatId)
    fs.rmSync(path.join(this.dir, 'msgs', safeName(chatId) + '.json'), { force: true })
    this.markList()
  }

  bucket(chatId: string): Bucket {
    let b = this.buckets.get(chatId)
    if (!b) {
      const raw = readJson<{ m: WAMessage[]; r: Record<string, Record<string, string>> }>(
        path.join(this.dir, 'msgs', safeName(chatId) + '.json'),
        { m: [], r: {} }
      )
      b = { msgs: new Map(), reactions: new Map(Object.entries(raw.r ?? {})), touched: Date.now() }
      for (const m of raw.m ?? []) if (m.key?.id) b.msgs.set(m.key.id, m)
      this.buckets.set(chatId, b)
    }
    b.touched = Date.now()
    return b
  }

  sorted(chatId: string): WAMessage[] {
    const b = this.bucket(chatId)
    if (!b.sorted) b.sorted = [...b.msgs.values()].sort((a, z) => tsOf(a) - tsOf(z))
    return b.sorted
  }

  putMessage(chatId: string, m: WAMessage): boolean {
    const b = this.bucket(chatId)
    const id = m.key.id!
    const prev = b.msgs.get(id)
    const isNew = !prev
    if (prev) {
      // keep local extras (edits, status) when a duplicate arrives
      const merged: any = { ...prev, ...m, message: m.message ?? prev.message, status: Math.max(prev.status ?? 0, m.status ?? 0) }
      // a CIPHERTEXT placeholder just got its real decrypted message: drop the stale decryption-error stub
      if (m.message && !m.messageStubType) {
        delete merged.messageStubType
        delete merged.messageStubParameters
      }
      b.msgs.set(id, merged as WAMessage)
    } else {
      b.msgs.set(id, m)
    }
    b.sorted = undefined
    this.markChat(chatId)
    return isNew
  }

  getMessage(chatId: string, id: string): WAMessage | undefined {
    return this.bucket(chatId).msgs.get(id)
  }

  findMessage(id: string): { chatId: string; msg: WAMessage } | undefined {
    for (const [chatId, b] of this.buckets) {
      const msg = b.msgs.get(id)
      if (msg) return { chatId, msg }
    }
    return undefined
  }

  markChat(chatId: string) {
    this.dirtyChats.add(chatId)
    this.schedule()
  }

  markList() {
    this.dirtyList = true
    this.schedule()
  }

  markMeta() {
    this.dirtyMeta = true
    this.schedule()
  }

  private schedule() {
    if (this.timer || this.disposed) return
    this.timer = setTimeout(() => this.flush(false), 1500)
  }

  private disposed = false
  /** stop writing (account being removed) */
  dispose() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.disposed = true
  }

  /**
   * Writes dirty data. Normal flushes write a few chats per tick (history sync can dirty hundreds at once
   * and serializing them all in one go would freeze the window); `all` is for quitting.
   */
  flush(all = true) {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.disposed) return
    try {
      let budget = all ? Infinity : 6
      for (const chatId of [...this.dirtyChats]) {
        if (budget-- <= 0) break
        this.dirtyChats.delete(chatId)
        const b = this.buckets.get(chatId)
        if (!b) continue
        let list = this.sorted(chatId)
        if (list.length > MAX_PER_CHAT) {
          list = list.slice(-MAX_PER_CHAT)
          b.msgs = new Map(list.map((m) => [m.key.id!, m]))
          b.sorted = list
        }
        try {
          writeAtomic(path.join(this.dir, 'msgs', safeName(chatId) + '.json'), {
            m: list,
            r: Object.fromEntries(b.reactions)
          })
        } catch (err) {
          console.error('[store] chat write failed', chatId, (err as Error).message)
        }
      }
      if (this.dirtyChats.size) this.timer = setTimeout(() => this.flush(false), 60)
      if (this.dirtyList) {
        writeAtomic(path.join(this.dir, 'chats.json'), [...this.chats.values()])
        writeAtomic(path.join(this.dir, 'contacts.json'), [...this.contacts.values()])
        this.dirtyList = false
      }
      if (this.dirtyMeta) {
        writeAtomic(path.join(this.dir, 'meta.json'), this.meta)
        this.dirtyMeta = false
      }
      this.evict()
    } catch (err) {
      console.error('[store] flush failed', err)
    }
  }

  /** keep memory small: unload buckets nobody looked at recently */
  private keep = new Set<string>()
  setKeep(ids: Iterable<string>) {
    this.keep = new Set(ids)
  }
  private evict() {
    if (this.buckets.size <= MAX_LOADED) return
    const candidates = [...this.buckets.entries()]
      .filter(([id]) => !this.keep.has(id) && !this.dirtyChats.has(id))
      .sort((a, b) => a[1].touched - b[1].touched)
    for (const [id] of candidates.slice(0, this.buckets.size - MAX_LOADED)) this.buckets.delete(id)
  }

  wipe() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.chats.clear()
    this.contacts.clear()
    this.buckets.clear()
    this.dirtyChats.clear()
    const keepSettings = this.meta.settings
    this.meta = { settings: keepSettings, lidToPn: {}, stickers: [], removedStickers: [], scheduled: [], reminders: [] }
    fs.rmSync(this.dir, { recursive: true, force: true })
    fs.mkdirSync(path.join(this.dir, 'msgs'), { recursive: true })
    fs.mkdirSync(path.join(this.dir, 'media'), { recursive: true })
    fs.mkdirSync(path.join(this.dir, 'stickers'), { recursive: true })
    fs.mkdirSync(path.join(this.dir, 'avatars'), { recursive: true })
    this.dirtyMeta = true
    this.flush()
  }
}
