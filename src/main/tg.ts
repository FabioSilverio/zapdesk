// Telegram account (MTProto via GramJS). Same surface as WaService (see service.ts), so the window,
// notifications, PIN lock, transcription, hover preview, themes… all work the same on it.
// Messages are kept in the same Store (one JSON per chat) as "records" carrying a ready UiMessage.
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { Api, TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import { NewMessage, Raw } from 'telegram/events/index.js'
import { EditedMessage } from 'telegram/events/EditedMessage.js'
import { DeletedMessage } from 'telegram/events/DeletedMessage.js'
import { CustomFile } from 'telegram/client/uploads.js'
import { Logger, LogLevel } from 'telegram/extensions/Logger.js'
import { UpdateConnectionState } from 'telegram/network/index.js'
import { getPeerId, strippedPhotoToJpg } from 'telegram/Utils.js'
import bigInt from 'big-integer'
import QRCode from 'qrcode'
import type { WAMessage } from 'baileys'
import type { ChatAction, ConnState, FavSticker, Folder, MainEvent, MsgKind, PersonInfo, PollInfo, Reaction, Reminder, ScheduledMsg, SharedItems, SharedLink, UiChat, UiMessage } from '@shared/types'
import { readJson, writeAtomic, type ChatRec, type StickerRec, type Store } from './store'
import { extractUrls, plain, voicePreview } from './normalize'
import { TgFile } from './tgfile'
import type { ChatService, IncomingInfo } from './service'

type Emit = (ev: MainEvent) => void

const PAGE = 60
const BATCH_MS = 40
const MAX_FILE = 2 * 1024 ** 3
const MAX_PHOTO = 10 * 1024 ** 2

let logError: (where: string, err: unknown) => void = (w, e) => console.error('[tg]', w, e)
export const setTgErrorLogger = (fn: typeof logError) => (logError = fn)

/** what we keep per message (Store-compatible: key + messageTimestamp) */
interface TgRec {
  key: { id: string; remoteJid: string; fromMe: boolean }
  messageTimestamp: number
  ui: UiMessage
  media?: { mime?: string; name?: string; size?: number; docId?: string; stickerThumb?: boolean }
  /** a poll: its id (vote updates name only that) and each option's id bytes, base64 */
  poll?: { id: string; opts: string[] }
  _deleted?: boolean
}

const tlText = (t: any): string => (typeof t === 'string' ? t : (t?.text ?? ''))

/** Telegram poll + results → what the bubble shows. min results don't say what you picked: keep what we knew */
function tgPoll(poll: Api.Poll, results: Api.PollResults | undefined, prev?: PollInfo): PollInfo {
  const byOpt = new Map(((results?.results ?? []) as Api.PollAnswerVoters[]).map((r) => [Buffer.from(r.option).toString('base64'), r]))
  return {
    name: tlText(poll.question) || 'Enquete',
    multi: !!poll.multipleChoice,
    closed: !!poll.closed || undefined,
    voters: results?.totalVoters ?? prev?.voters ?? 0,
    options: (poll.answers as Api.PollAnswer[]).map((a, i) => {
      const r = byOpt.get(Buffer.from(a.option).toString('base64'))
      return { name: tlText(a.text), votes: r?.voters ?? prev?.options[i]?.votes ?? 0, mine: results?.min ? !!prev?.options[i]?.mine : !!r?.chosen }
    })
  }
}

/** Telegram lets you edit your messages for 48 hours */
const TG_EDIT_WINDOW = 48 * 3600_000

/** per-chat Telegram facts we need offline (peer type + access hash to talk to it) */
export type TgChatInfo = NonNullable<ChatRec['tg']>

interface TgFolderRec extends Folder {
  include: string[]
  pinned: string[]
  exclude: string[]
  contacts?: boolean
  nonContacts?: boolean
  groups?: boolean
  broadcasts?: boolean
  bots?: boolean
  excludeMuted?: boolean
  excludeRead?: boolean
  excludeArchived?: boolean
}

interface Creds {
  apiId?: number
  apiHash?: string
  session?: string
}

const isMuted = (c: ChatRec) => {
  const m = c.muteUntil
  if (!m) return false
  return m < 0 || m > Date.now()
}

const toId = (peer: any) => 'tg:' + getPeerId(peer)
const rawId = (chatId: string) => chatId.replace(/^tg:/, '')
const big = (s: string | number) => bigInt(String(s))
const heart = (e: string) => (e === '❤' ? '❤️' : e)
const sha = (s: string) => createHash('sha1').update(s).digest('hex')

function nameOf(e: any): string {
  if (!e) return ''
  if (e instanceof Api.User) {
    if (e.deleted) return 'Conta excluída'
    return [e.firstName, e.lastName].filter(Boolean).join(' ') || (e.username ? '@' + e.username : '') || (e.phone ? '+' + e.phone : 'Telegram')
  }
  return e.title ?? ''
}

function infoOf(e: any, meId?: string): TgChatInfo | undefined {
  if (e instanceof Api.User) {
    if (meId && 'tg:' + e.id.toString() === meId) return { t: 'self', hash: e.accessHash?.toString() }
    return { t: e.bot ? 'bot' : 'user', hash: e.accessHash?.toString(), contact: !!e.contact }
  }
  if (e instanceof Api.Chat || e instanceof Api.ChatForbidden) return { t: 'group' }
  if (e instanceof Api.Channel) return { t: e.megagroup || e.gigagroup ? 'group' : 'channel', hash: e.accessHash?.toString(), megagroup: !!e.megagroup }
  if (e instanceof Api.ChannelForbidden) return { t: e.megagroup ? 'group' : 'channel', hash: e.accessHash?.toString() }
  return undefined
}

// ---------- formatting: Telegram entities ⇄ WhatsApp-style markup the renderer understands ----------

function toMarkup(text: string, entities: Api.TypeMessageEntity[] | undefined, mentions: Record<string, { id: string; name: string }>): string {
  if (!entities?.length || !text) return text
  const opens = new Map<number, string[]>()
  const closes = new Map<number, string[]>()
  const repl = new Map<number, { end: number; s: string }>()
  const add = (m: Map<number, string[]>, at: number, s: string, front = false) => {
    const l = m.get(at) ?? []
    front ? l.unshift(s) : l.push(s)
    m.set(at, l)
  }
  for (const e of entities) {
    let a = e.offset
    let b = e.offset + e.length
    if (e instanceof Api.MessageEntityMentionName || e instanceof Api.InputMessageEntityMentionName) {
      const uid = (e as any).userId?.toString?.() ?? ''
      if (uid) {
        mentions[uid] = { id: 'tg:' + uid, name: text.slice(a, b).replace(/^@/, '') }
        repl.set(a, { end: b, s: '@' + uid })
      }
      continue
    }
    while (a < b && /\s/.test(text[a])) a++
    while (b > a && /\s/.test(text[b - 1])) b--
    if (a >= b) continue
    let o = ''
    let c = ''
    if (e instanceof Api.MessageEntityBold) o = c = '*'
    else if (e instanceof Api.MessageEntityItalic) o = c = '_'
    else if (e instanceof Api.MessageEntityStrike) o = c = '~'
    else if (e instanceof Api.MessageEntityCode) o = c = '`'
    else if (e instanceof Api.MessageEntityPre) o = c = '```'
    else if (e instanceof Api.MessageEntityTextUrl) {
      const label = text.slice(a, b)
      if (label !== e.url && !label.includes(e.url)) add(closes, b, ' (' + e.url + ')', true)
      continue
    } else continue
    add(opens, a, o)
    add(closes, b, c, true)
  }
  let out = ''
  for (let i = 0; i <= text.length; ) {
    for (const s of closes.get(i) ?? []) out += s
    if (i === text.length) break
    for (const s of opens.get(i) ?? []) out += s
    const r = repl.get(i)
    if (r) {
      out += r.s
      i = r.end
      continue
    }
    out += text[i]
    i++
  }
  return out
}

const FMT_RE = /```([\s\S]+?)```|`([^`\n]+)`|(?<![\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\w*])|(?<![\w_])_(?!\s)([^_\n]+?)(?<!\s)_(?![\w_])|(?<![\w~])~(?!\s)([^~\n]+?)(?<!\s)~(?![\w~])/g

/** "*oi* _tudo_ `bem`" → plain text + Telegram entities (one level, like WhatsApp) */
export function fromMarkup(input: string): { text: string; entities: Api.TypeMessageEntity[] } {
  const entities: Api.TypeMessageEntity[] = []
  let text = ''
  let last = 0
  for (const m of input.matchAll(FMT_RE)) {
    text += input.slice(last, m.index)
    const inner = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? ''
    const offset = text.length
    const length = inner.length
    if (m[1] != null) entities.push(new Api.MessageEntityPre({ offset, length, language: '' }))
    else if (m[2] != null) entities.push(new Api.MessageEntityCode({ offset, length }))
    else if (m[3] != null) entities.push(new Api.MessageEntityBold({ offset, length }))
    else if (m[4] != null) entities.push(new Api.MessageEntityItalic({ offset, length }))
    else entities.push(new Api.MessageEntityStrike({ offset, length }))
    text += inner
    last = m.index! + m[0].length
  }
  text += input.slice(last)
  return { text, entities }
}

const LABEL: Partial<Record<MsgKind, string>> = {
  image: '📷 Foto',
  video: '🎬 Vídeo',
  audio: '🎤 Áudio',
  document: '📄 Documento',
  sticker: '💟 Figurinha',
  location: '📍 Localização',
  contact: '👤 Contato',
  poll: '📊 Enquete'
}

function previewOfUi(ui: UiMessage): string {
  if (ui.kind === 'text' || ui.kind === 'system') return plain(ui.text ?? '')
  const label = ui.kind === 'audio' && !ui.ptt ? '🎵 Música' : ui.kind === 'document' && ui.fileName ? '📄 ' + ui.fileName : (LABEL[ui.kind] ?? '')
  return plain([label, ui.kind === 'poll' || ui.kind === 'contact' || ui.kind === 'location' ? '' : ui.text].filter(Boolean).join(' '))
}

function serviceText(a: any, who: string): string {
  if (a instanceof Api.MessageActionChatAddUser) return `${who} adicionou alguém ao grupo`
  if (a instanceof Api.MessageActionChatJoinedByLink || a instanceof Api.MessageActionChatJoinedByRequest) return `${who} entrou pelo link`
  if (a instanceof Api.MessageActionChatDeleteUser) return `${who} saiu do grupo`
  if (a instanceof Api.MessageActionChatEditTitle) return `${who} mudou o nome para “${a.title}”`
  if (a instanceof Api.MessageActionChatEditPhoto) return `${who} mudou a foto do grupo`
  if (a instanceof Api.MessageActionChatDeletePhoto) return `${who} removeu a foto do grupo`
  if (a instanceof Api.MessageActionChatCreate || a instanceof Api.MessageActionChannelCreate) return `${who} criou “${(a as any).title}”`
  if (a instanceof Api.MessageActionPinMessage) return `${who} fixou uma mensagem`
  if (a instanceof Api.MessageActionPhoneCall) return a.video ? '📹 Chamada de vídeo' : '📞 Chamada de voz'
  if (a instanceof Api.MessageActionTopicCreate) return `${who} criou o tópico “${a.title}”`
  if (a instanceof Api.MessageActionChatMigrateTo || a instanceof Api.MessageActionChannelMigrateFrom) return 'O grupo virou supergrupo'
  if (a instanceof Api.MessageActionContactSignUp) return `${who} entrou no Telegram`
  if (a instanceof Api.MessageActionScreenshotTaken) return `${who} tirou um print`
  if (a instanceof Api.MessageActionHistoryClear) return 'Histórico apagado'
  return 'Atualização da conversa'
}

export class TgService implements ChatService {
  readonly kind = 'tg' as const
  conn: ConnState = 'loading'
  qr?: string
  me?: { id: string; name?: string; phone?: string }
  activeChat: string | null = null
  focused = false
  screenLocked = false
  passwordHint?: string
  loginError?: string
  onIncoming?: (i: IncomingInfo) => void
  onCall?: (from: string) => void
  onReminder?: (r: Reminder, chatName: string) => void
  onScheduledSent?: (s: ScheduledMsg, chatName: string) => void

  private client?: TelegramClient
  private creds: Creds
  private credsFile: string
  private stopped = false
  private handlersOn = false
  private pwResolve?: (pw: string) => void
  private loaded = new Set<string>()
  private historyEnd = new Set<string>()
  private pendingChats = new Set<string>()
  private pendingMsgs = new Map<string, Map<string, UiMessage>>()
  private batchTimer: NodeJS.Timeout | null = null
  private raw = new Map<string, Api.Message>()
  private mediaJobs = new Map<string, Promise<string>>()
  private files = new Map<string, TgFile>()
  private avatarJobs = new Map<string, Promise<string | null>>()
  private avatarQueue: (() => void)[] = []
  private avatarActive = 0
  private blocked = new Set<string>()
  private heldReads = new Map<string, number>()
  private timer?: NodeJS.Timeout
  private dialogsTimer?: NodeJS.Timeout
  private lastDialogs = 0
  private stickerDocs = new Map<string, Api.Document>()
  private sendingScheduled = new Set<string>()

  constructor(
    private store: Store,
    dataDir: string,
    private emit: Emit
  ) {
    this.credsFile = path.join(dataDir, 'tg.json')
    this.creds = readJson<Creds>(this.credsFile, {})
    const meta = this.store.meta as any
    if (meta.tgMe) this.me = meta.tgMe
  }

  private get settings() {
    return this.store.meta.settings
  }
  private get folderRecs(): TgFolderRec[] {
    return ((this.store.meta as any).tgFolders ?? []) as TgFolderRec[]
  }

  private saveCreds() {
    try {
      writeAtomic(this.credsFile, this.creds)
    } catch (err) {
      logError('tg creds', err)
    }
  }

  private setConn(conn: ConnState, qr?: string) {
    this.conn = conn
    if (conn === 'qr') this.qr = qr
    else if (conn !== 'password') this.qr = undefined
    this.emit({ type: 'conn', conn, qr: this.qr, me: this.me, passwordHint: this.passwordHint, loginError: this.loginError })
  }

  // ---------- login / connection ----------

  async start() {
    this.stopped = false
    if (!this.creds.apiId || !this.creds.apiHash) return this.setConn('setup')
    await this.connect()
  }

  /** first step of a Telegram login: the app keys from my.telegram.org */
  async setup(apiId: string, apiHash: string) {
    const id = Number(String(apiId).trim())
    const hash = String(apiHash).trim()
    if (!Number.isInteger(id) || id <= 0) throw new Error('api_id é um número (ex: 1234567)')
    if (!/^[a-f0-9]{32}$/i.test(hash)) throw new Error('api_hash tem 32 letras/números')
    this.creds = { apiId: id, apiHash: hash }
    this.loginError = undefined
    this.saveCreds()
    await this.connect()
  }

  password(pw: string) {
    this.loginError = undefined
    const r = this.pwResolve
    this.pwResolve = undefined
    this.setConn('connecting')
    r?.(pw)
  }

  private async connect() {
    if (this.stopped) return
    this.setConn(this.me ? 'reconnecting' : 'connecting')
    try {
      await this.client?.destroy().catch(() => {})
    } catch {}
    const client = new TelegramClient(new StringSession(this.creds.session ?? ''), this.creds.apiId!, this.creds.apiHash!, {
      connectionRetries: 1_000_000,
      retryDelay: 2000,
      autoReconnect: true,
      useWSS: false,
      deviceModel: 'Zapdesk',
      systemVersion: 'Windows',
      appVersion: app.getVersion(),
      langCode: 'pt',
      systemLangCode: 'pt-BR',
      baseLogger: new Logger(LogLevel.ERROR)
    })
    this.client = client
    this.handlersOn = false
    try {
      await client.connect()
    } catch (err) {
      logError('tg connect', err)
      this.setConn('reconnecting')
      setTimeout(() => void this.connect(), 8000)
      return
    }
    let authorized = false
    try {
      authorized = await client.checkAuthorization()
    } catch (err) {
      logError('tg auth check', err)
    }
    if (authorized) return this.onReady()
    if (this.creds.session) {
      // the session was ended from the phone ("Dispositivos → encerrar"): start clean, like WhatsApp does
      this.creds.session = undefined
      this.saveCreds()
      this.me = undefined
      ;(this.store.meta as any).tgMe = undefined
      ;(this.store.meta as any).tgFolders = []
      this.store.wipe()
      this.loaded.clear()
      this.historyEnd.clear()
      this.emit({ type: 'chatsRemoved', ids: ['*'] })
      this.emit({ type: 'folders', folders: [] })
    }
    await this.qrLogin(client)
  }

  private async qrLogin(client: TelegramClient) {
    try {
      await client.signInUserWithQrCode(
        { apiId: this.creds.apiId!, apiHash: this.creds.apiHash! },
        {
          qrCode: async ({ token }) => {
            const url = 'tg://login?token=' + token.toString('base64url')
            const img = await QRCode.toDataURL(url, { margin: 1, width: 280, color: { dark: '#0b0b0b', light: '#ffffff' } })
            this.setConn('qr', img)
          },
          password: async (hint) => {
            this.passwordHint = hint || undefined
            this.setConn('password')
            return new Promise<string>((res) => (this.pwResolve = res))
          },
          onError: async (err: any) => {
            const msg = String(err?.errorMessage ?? err?.message ?? err)
            if (/PASSWORD_HASH_INVALID/.test(msg)) {
              this.loginError = 'Senha errada — tenta de novo'
              return false
            }
            if (/API_ID_INVALID|API_ID_PUBLISHED_FLOOD/.test(msg)) {
              this.loginError = 'api_id / api_hash não conferem. Copie de novo de my.telegram.org'
              this.creds = {}
              this.saveCreds()
              this.setConn('setup')
              return true
            }
            logError('tg login', err)
            return false
          }
        }
      )
      this.creds.session = (client.session as StringSession).save()
      this.saveCreds()
      await this.onReady()
    } catch (err) {
      if (this.stopped || this.conn === 'setup') return
      logError('tg qr login', err)
      this.loginError = 'Não deu pra entrar: ' + String((err as any)?.errorMessage ?? (err as Error)?.message ?? err)
      setTimeout(() => void this.connect(), 3000)
    }
  }

  private async onReady() {
    const client = this.client!
    try {
      const u = (await client.getMe()) as Api.User
      this.me = { id: 'tg:' + u.id.toString(), name: nameOf(u), phone: u.phone ?? undefined }
      ;(this.store.meta as any).tgMe = this.me
      this.store.markMeta()
      const self = this.chat(this.me.id)
      self.tg = { t: 'self', hash: u.accessHash?.toString() }
    } catch (err) {
      logError('tg getMe', err)
    }
    this.creds.session = (client.session as StringSession).save()
    this.saveCreds()
    this.passwordHint = undefined
    this.loginError = undefined
    this.attachHandlers(client)
    this.setConn('open')
    void this.setOnline(this.focused)
    await this.loadDialogs().catch((err) => logError('tg dialogs', err))
    void this.loadFolders().catch((err) => logError('tg folders', err))
    void this.resyncStickers().catch((err) => logError('tg stickers', err))
    void this.loadBlocked()
    void this.prefetch()
  }

  private attachHandlers(client: TelegramClient) {
    if (this.handlersOn) return
    this.handlersOn = true
    const safe = (fn: (e: any) => void | Promise<void>) => async (e: any) => {
      try {
        await fn(e)
      } catch (err) {
        logError('tg update', err)
      }
    }
    client.addEventHandler(safe((e) => this.ingest(e.message, true)), new NewMessage({}))
    client.addEventHandler(safe((e) => this.ingest(e.message, true, true)), new EditedMessage({}))
    client.addEventHandler(safe((e) => this.onDeleted(e)), new DeletedMessage({}))
    client.addEventHandler(safe((u) => this.onRaw(u)), new Raw({}))
  }

  private onRaw(u: any) {
    if (u instanceof UpdateConnectionState) {
      if (this.stopped || this.conn === 'qr' || this.conn === 'password' || this.conn === 'setup') return
      if (u.state === UpdateConnectionState.connected) {
        if (this.conn !== 'open') {
          this.setConn('open')
          // came back: catch up on what changed while offline
          this.refreshDialogsSoon(500)
          if (this.activeChat) void this.fetchHistory(this.activeChat, 0).catch(() => {})
        }
      } else if (this.conn === 'open') this.setConn('reconnecting')
      return
    }
    if (u instanceof Api.UpdateUserTyping) return this.onTyping('tg:' + u.userId.toString(), undefined, u.action)
    if (u instanceof Api.UpdateChatUserTyping) return this.onTyping('tg:-' + u.chatId.toString(), toId(u.fromId), u.action)
    if (u instanceof Api.UpdateChannelUserTyping) return this.onTyping(toId(new Api.PeerChannel({ channelId: u.channelId })), toId(u.fromId), u.action)
    if (u instanceof Api.UpdateReadHistoryOutbox) return this.onReadOut(toId(u.peer), u.maxId)
    if (u instanceof Api.UpdateReadChannelOutbox) return this.onReadOut(toId(new Api.PeerChannel({ channelId: u.channelId })), u.maxId)
    if (u instanceof Api.UpdateReadHistoryInbox) return this.onReadIn(toId(u.peer), u.stillUnreadCount)
    if (u instanceof Api.UpdateReadChannelInbox) return this.onReadIn(toId(new Api.PeerChannel({ channelId: u.channelId })), u.stillUnreadCount)
    if (u instanceof Api.UpdateMessageReactions) return this.onReactions(toId(u.peer), String(u.msgId), u.reactions)
    if (u instanceof Api.UpdateMessagePoll) return this.onPoll(u)
    if (u instanceof Api.UpdateDialogFilter || u instanceof Api.UpdateDialogFilters || u instanceof Api.UpdateDialogFilterOrder)
      return void this.loadFolders().catch(() => {})
    if (
      u instanceof Api.UpdateDialogPinned ||
      u instanceof Api.UpdatePinnedDialogs ||
      u instanceof Api.UpdateNotifySettings ||
      u instanceof Api.UpdateFolderPeers ||
      u instanceof Api.UpdateDialogUnreadMark ||
      u instanceof Api.UpdateChannel
    )
      return this.refreshDialogsSoon(800)
    if (u instanceof Api.UpdatePeerBlocked) {
      const id = toId(u.peerId)
      u.blocked ? this.blocked.add(id) : this.blocked.delete(id)
      if (this.store.chats.has(id)) this.queueChat(id)
      return
    }
    if (u instanceof Api.UpdatePhoneCall && u.phoneCall instanceof Api.PhoneCallRequested) return this.onCall?.('tg:' + u.phoneCall.adminId.toString())
  }

  // ---------- chats ----------

  private chat(id: string): ChatRec {
    let c = this.store.chats.get(id)
    if (!c) {
      c = { id, ts: 0, unread: 0 }
      this.store.chats.set(id, c)
    }
    return c
  }

  /** remembers names + access hashes of every user/chat Telegram tells us about */
  private remember(e: any): string | undefined {
    if (!e || !(e instanceof Api.User || e instanceof Api.Chat || e instanceof Api.Channel || e instanceof Api.ChatForbidden || e instanceof Api.ChannelForbidden)) return
    const id = toId(e)
    const info = infoOf(e, this.me?.id)
    const name = nameOf(e)
    if (e instanceof Api.User) {
      const prev = this.store.contacts.get(id)
      if (!prev || prev.name !== name || prev.tgHash !== info?.hash) {
        this.store.contacts.set(id, { ...prev, id, name, phoneNumber: e.phone ?? undefined, tgHash: info?.hash })
        this.store.markList()
      }
    }
    const c = this.store.chats.get(id)
    if (c) {
      if (info) c.tg = { ...c.tg, ...info, readOut: c.tg?.readOut }
      if (!(e instanceof Api.User) && name) c.name = name
      else if (name) c.name = name
    }
    return id
  }

  chatName(c: ChatRec): string {
    if (c.alias) return c.alias
    if (c.tg?.t === 'self' || c.id === this.me?.id) return 'Mensagens salvas'
    return c.name || this.store.contacts.get(c.id)?.name || 'Telegram'
  }

  private inFolder(f: TgFolderRec, c: ChatRec): boolean {
    if (f.pinned.includes(c.id) || f.include.includes(c.id)) return true
    if (f.exclude.includes(c.id)) return false
    if (f.excludeArchived && c.archived) return false
    if (f.excludeMuted && isMuted(c)) return false
    if (f.excludeRead && !(c.unread || c.markedUnread)) return false
    const t = c.tg?.t
    if (t === 'user' || t === 'self') return c.tg?.contact || t === 'self' ? !!f.contacts : !!f.nonContacts
    if (t === 'bot') return !!f.bots
    if (t === 'group') return !!f.groups
    if (t === 'channel') return !!f.broadcasts
    return false
  }

  toUiChat(c: ChatRec): UiChat {
    const folders: number[] = []
    const folderPins: number[] = []
    for (const f of this.folderRecs) {
      if (this.inFolder(f, c)) folders.push(f.id)
      if (f.pinned.includes(c.id)) folderPins.push(f.id)
    }
    const t = c.tg?.t
    return {
      id: c.id,
      name: this.chatName(c),
      ts: c.ts,
      unread: c.unread,
      markedUnread: c.markedUnread,
      pinned: c.localPin || c.waPinned || 0,
      section: c.section,
      muted: isMuted(c),
      archived: !!c.archived,
      preview: voicePreview(c.preview, c.lastMsgId && this.store.meta.transcripts?.[c.id + '/' + c.lastMsgId]),
      previewFromMe: c.previewFromMe,
      previewSender: c.previewSender,
      isGroup: t === 'group' || t === 'channel',
      channel: t === 'channel' || undefined,
      blocked: this.blocked.has(c.id) || undefined,
      self: t === 'self' || c.id === this.me?.id || undefined,
      folders: folders.length ? folders : undefined,
      folderPins: folderPins.length ? folderPins : undefined
    }
  }

  allChats(): UiChat[] {
    return [...this.store.chats.values()].filter((c) => c.ts || c.preview || c.localPin || c.waPinned).map((c) => this.toUiChat(c))
  }

  folders(): Folder[] {
    return this.folderRecs.map(({ id, title, emoji }) => ({ id, title, emoji }))
  }

  private async loadDialogs() {
    const client = this.client
    if (!client) return
    this.lastDialogs = Date.now()
    for (const folder of [0, 1]) {
      const list = await client.getDialogs({ folder, limit: folder ? 300 : 600 })
      let pinOrder = 0
      for (const d of list) {
        const id = this.remember(d.entity) ?? (d.id ? 'tg:' + d.id.toString() : undefined)
        if (!id) continue
        const c = this.chat(id)
        const info = infoOf(d.entity, this.me?.id)
        if (info) c.tg = { ...info, readOut: (d.dialog as any)?.readOutboxMaxId ?? c.tg?.readOut }
        c.name = d.title || nameOf(d.entity) || c.name
        c.unread = d.unreadCount ?? 0
        c.markedUnread = !!(d.dialog as any)?.unreadMark || undefined
        c.archived = folder === 1 || undefined
        c.waPinned = d.pinned ? ++pinOrder : undefined
        const mu = (d.dialog as any)?.notifySettings?.muteUntil as number | undefined
        c.muteUntil = mu && mu * 1000 > Date.now() ? (mu >= 2147483647 ? -1 : mu * 1000) : undefined
        const m = d.message
        if (m) {
          c.lastMsgId = String(m.id)
          c.ts = Math.max(c.ts, (m.date ?? 0) * 1000)
          const rec = this.toRec(id, m)
          if (rec) this.setPreview(c, rec)
        } else if (!c.ts && d.date) c.ts = d.date * 1000
        this.queueChat(id)
      }
    }
  }

  private refreshDialogsSoon(ms = 1000) {
    if (this.dialogsTimer) return
    this.dialogsTimer = setTimeout(() => {
      this.dialogsTimer = undefined
      void this.loadDialogs().catch((err) => logError('tg dialogs', err))
    }, ms)
  }

  private async loadFolders() {
    const client = this.client
    if (!client) return
    const res: any = await client.invoke(new Api.messages.GetDialogFilters())
    const list: any[] = Array.isArray(res) ? res : (res?.filters ?? [])
    const ids = (peers: any[] | undefined) => (peers ?? []).map((p) => this.inputPeerId(p)).filter(Boolean) as string[]
    const out: TgFolderRec[] = []
    for (const f of list) {
      if (!(f instanceof Api.DialogFilter) && !(f instanceof Api.DialogFilterChatlist)) continue
      const title = typeof f.title === 'string' ? f.title : ((f.title as any)?.text ?? 'Pasta')
      const x = f as any
      out.push({
        id: f.id,
        title,
        emoji: f.emoticon || undefined,
        include: ids(f.includePeers),
        pinned: ids(f.pinnedPeers),
        exclude: ids(x.excludePeers),
        contacts: x.contacts,
        nonContacts: x.nonContacts,
        groups: x.groups,
        broadcasts: x.broadcasts,
        bots: x.bots,
        excludeMuted: x.excludeMuted,
        excludeRead: x.excludeRead,
        excludeArchived: x.excludeArchived
      })
    }
    ;(this.store.meta as any).tgFolders = out
    this.store.markMeta()
    this.emit({ type: 'folders', folders: this.folders() })
    for (const id of this.store.chats.keys()) this.pendingChats.add(id)
    this.kick()
  }

  private inputPeerId(p: any): string | undefined {
    if (p instanceof Api.InputPeerSelf) return this.me?.id
    if (p instanceof Api.InputPeerUser) return 'tg:' + p.userId.toString()
    if (p instanceof Api.InputPeerChat) return 'tg:-' + p.chatId.toString()
    if (p instanceof Api.InputPeerChannel) return toId(new Api.PeerChannel({ channelId: p.channelId }))
    return undefined
  }

  private async loadBlocked() {
    try {
      const res: any = await this.client!.invoke(new Api.contacts.GetBlocked({ offset: 0, limit: 200 }))
      for (const u of res.users ?? []) this.remember(u)
      this.blocked = new Set((res.blocked ?? []).map((b: any) => toId(b.peerId)))
      for (const id of this.blocked) if (this.store.chats.has(id)) this.queueChat(id)
    } catch (err) {
      logError('tg blocked', err)
    }
  }

  /** the last messages of the top chats, so opening/hovering them is instant */
  private async prefetch() {
    const top = [...this.store.chats.values()]
      .filter((c) => !c.archived)
      .sort((a, b) => (b.waPinned ? 1e15 : b.ts) - (a.waPinned ? 1e15 : a.ts))
      .slice(0, 12)
    for (const c of top) {
      if (this.stopped || this.conn !== 'open') return
      if (this.store.sorted(c.id).length >= 15 && (!c.lastMsgId || this.store.getMessage(c.id, c.lastMsgId))) continue
      await this.fetchHistory(c.id, 0, 25).catch(() => {})
      await new Promise((r) => setTimeout(r, 250))
    }
  }

  /** input peer for any chat id, from what we stored (works before dialogs load) */
  private async peer(chatId: string): Promise<Api.TypeInputPeer> {
    if (chatId === this.me?.id) return new Api.InputPeerSelf()
    const id = rawId(chatId)
    const c = this.store.chats.get(chatId)
    const hash = c?.tg?.hash ?? this.store.contacts.get(chatId)?.tgHash
    if (id.startsWith('-100')) {
      if (hash) return new Api.InputPeerChannel({ channelId: big(id.slice(4)), accessHash: big(hash) })
    } else if (id.startsWith('-')) return new Api.InputPeerChat({ chatId: big(id.slice(1)) })
    else if (hash) return new Api.InputPeerUser({ userId: big(id), accessHash: big(hash) })
    return (await this.requireOpen().getInputEntity(big(id))) as Api.TypeInputPeer
  }

  private requireOpen() {
    if (!this.client || this.conn !== 'open') throw new Error('Sem conexão com o Telegram agora')
    return this.client
  }

  // ---------- messages ----------

  private uiOf(rec: TgRec, fav = this.favIds()): UiMessage {
    const ui = { ...rec.ui }
    if (ui.fromMe && (ui.status ?? 0) >= 2) {
      const ro = this.store.chats.get(rec.key.remoteJid)?.tg?.readOut ?? 0
      ui.status = Number(ui.id) <= ro ? 4 : 2
    }
    const tr = this.store.meta.transcripts?.[rec.key.remoteJid + '/' + ui.id]
    if (tr !== undefined) ui.transcript = tr
    if (ui.kind === 'video' && this.store.hasPoster(rec.key.remoteJid, ui.id)) ui.poster = true
    if (ui.fromMe && ui.kind === 'text' && !rec._deleted && Date.now() - ui.ts < TG_EDIT_WINDOW) ui.editable = true
    if (rec._deleted) {
      if (!this.settings.keepDeleted) return { ...ui, kind: 'deleted', text: '🚫 Mensagem apagada', reactions: undefined }
      ui.revoked = true
    }
    if (rec.media?.docId && ui.kind === 'sticker') ui.stickerFav = fav.has(rec.media.docId) || undefined
    return ui
  }

  private toRec(chatId: string, m: Api.TypeMessage): TgRec | undefined {
    if (m instanceof Api.MessageEmpty) return undefined
    const msg = m as Api.Message | Api.MessageService
    const id = String(msg.id)
    const fromMe = !!msg.out || (chatId === this.me?.id && !msg.fwdFrom)
    const c = this.store.chats.get(chatId)
    const isGroup = c?.tg?.t === 'group' || c?.tg?.t === 'channel'
    let sender: string | undefined
    let senderName: string | undefined
    if (!fromMe && isGroup) {
      const s: any = (msg as any)._sender ?? (msg as any).sender
      if (s) this.remember(s)
      sender = msg.fromId ? toId(msg.fromId) : chatId
      senderName = (s ? nameOf(s) : undefined) || this.store.contacts.get(sender)?.name || (msg as any).postAuthor || (sender === chatId ? c?.name : undefined)
    }
    const ui: UiMessage = { id, chatId, fromMe, ts: (msg.date ?? 0) * 1000, kind: 'text', sender, senderName, status: fromMe ? 2 : undefined }
    const rec: TgRec = { key: { id, remoteJid: chatId, fromMe }, messageTimestamp: (msg.date ?? 0) + (msg.id % 1e6) / 1e7, ui }

    if (msg instanceof Api.MessageService) {
      ui.kind = 'system'
      ui.text = serviceText(msg.action, fromMe ? 'Você' : senderName || this.chatName(c ?? { id: chatId, ts: 0, unread: 0 }))
      return rec
    }

    const mentions: Record<string, { id: string; name: string }> = {}
    ui.text = toMarkup(msg.message ?? '', msg.entities, mentions) || undefined
    if (Object.keys(mentions).length) ui.mentions = mentions
    if (msg.editDate && !msg.editHide) ui.edited = true

    const media: any = msg.media
    if (media instanceof Api.MessageMediaPhoto && media.photo instanceof Api.Photo) {
      ui.kind = 'image'
      ui.hasMedia = true
      const sizes = media.photo.sizes as any[]
      const bigSize = [...sizes].reverse().find((s) => s.w && s.h)
      if (bigSize) {
        ui.w = bigSize.w
        ui.h = bigSize.h
      }
      const strip = sizes.find((s) => s instanceof Api.PhotoStrippedSize)
      if (strip) ui.thumb = 'data:image/jpeg;base64,' + strippedPhotoToJpg(Buffer.from(strip.bytes)).toString('base64')
      rec.media = { mime: 'image/jpeg' }
      ui.size = bigSize?.size || undefined
    } else if (media instanceof Api.MessageMediaDocument && media.document instanceof Api.Document) {
      const doc = media.document
      const attrs = doc.attributes as any[]
      const mime = doc.mimeType
      const sticker = attrs.find((a) => a instanceof Api.DocumentAttributeSticker)
      const audio = attrs.find((a) => a instanceof Api.DocumentAttributeAudio)
      const video = attrs.find((a) => a instanceof Api.DocumentAttributeVideo)
      const gif = attrs.some((a) => a instanceof Api.DocumentAttributeAnimated)
      const fname = attrs.find((a) => a instanceof Api.DocumentAttributeFilename)?.fileName
      const size = attrs.find((a) => a instanceof Api.DocumentAttributeImageSize) ?? video
      ui.hasMedia = true
      ui.mime = mime
      rec.media = { mime, name: fname, size: Number(doc.size), docId: doc.id.toString() }
      ui.size = Number(doc.size) || undefined
      if (size?.w) {
        ui.w = size.w
        ui.h = size.h
      }
      const strip = (doc.thumbs as any[] | undefined)?.find((s) => s instanceof Api.PhotoStrippedSize)
      if (strip) ui.thumb = 'data:image/jpeg;base64,' + strippedPhotoToJpg(Buffer.from(strip.bytes)).toString('base64')
      if (sticker) {
        ui.kind = 'sticker'
        ui.text = undefined
        // animated (.tgs) / video (.webm) stickers: their still thumbnail
        if (mime !== 'image/webp') rec.media.stickerThumb = true
        ui.w = ui.w || 512
        ui.h = ui.h || 512
      } else if (audio) {
        ui.kind = 'audio'
        ui.ptt = !!audio.voice
        ui.seconds = audio.duration
        if (!audio.voice && (audio.title || audio.performer)) ui.fileName = [audio.performer, audio.title].filter(Boolean).join(' — ')
      } else if (video || gif || mime?.startsWith('video/')) {
        ui.kind = 'video'
        ui.seconds = video?.duration ? Math.round(video.duration) : undefined
        if (gif) ui.ptt = true // loops muted, like a GIF
      } else if (mime?.startsWith('image/') && Number(doc.size) < MAX_PHOTO) {
        ui.kind = 'image'
      } else {
        ui.kind = 'document'
        ui.fileName = fname || 'arquivo'
      }
    } else if (media instanceof Api.MessageMediaGeo || media instanceof Api.MessageMediaGeoLive || media instanceof Api.MessageMediaVenue) {
      ui.kind = 'location'
      const g: any = media.geo
      const title = media instanceof Api.MessageMediaVenue ? media.title : ''
      ui.text = `📍 ${title ? title + ' · ' : ''}${g?.lat?.toFixed?.(5) ?? ''}, ${g?.long?.toFixed?.(5) ?? ''}\nhttps://maps.google.com/?q=${g?.lat},${g?.long}`
    } else if (media instanceof Api.MessageMediaContact) {
      ui.kind = 'contact'
      ui.text = `👤 ${[media.firstName, media.lastName].filter(Boolean).join(' ')}${media.phoneNumber ? ' · +' + media.phoneNumber.replace(/^\+/, '') : ''}`
    } else if (media instanceof Api.MessageMediaPoll && media.poll instanceof Api.Poll) {
      ui.kind = 'poll'
      const prev = (this.store.getMessage(chatId, id) as unknown as TgRec | undefined)?.ui.poll
      ui.poll = tgPoll(media.poll, media.results as Api.PollResults, prev)
      ui.text = '📊 ' + ui.poll.name
      rec.poll = { id: media.poll.id.toString(), opts: (media.poll.answers as Api.PollAnswer[]).map((a) => Buffer.from(a.option).toString('base64')) }
      this.pollIndex.set(rec.poll.id, { chatId, msgId: id })
    } else if (media instanceof Api.MessageMediaWebPage && media.webpage instanceof Api.WebPage) {
      const w = media.webpage
      ui.link = { url: w.url, title: w.title ?? w.siteName ?? undefined, description: w.description ?? undefined }
    } else if (media instanceof Api.MessageMediaDice) {
      ui.text = `${media.emoticon} ${media.value}`
    } else if (media && !(media instanceof Api.MessageMediaEmpty) && !(media instanceof Api.MessageMediaWebPage)) {
      ui.kind = 'unknown'
      ui.text = ui.text || 'Mensagem do Telegram que o Zapdesk ainda não mostra'
    }

    const rt: any = msg.replyTo
    // in forum topics every message "replies" to the topic root: only real replies get a quote
    if (rt?.replyToMsgId && !(rt.forumTopic && !rt.replyToTopId)) {
      const q = this.store.getMessage(chatId, String(rt.replyToMsgId)) as unknown as TgRec | undefined
      ui.quoted = {
        id: String(rt.replyToMsgId),
        senderName: q ? (q.ui.fromMe ? 'Você' : q.ui.senderName || this.chatName(c ?? { id: chatId, ts: 0, unread: 0 })) : '',
        text: rt.quoteText || (q ? previewOfUi(q.ui) : 'Mensagem')
      }
    }
    ui.reactions = this.reactionsOf(msg.reactions)
    return rec
  }

  private reactionsOf(r: any): Reaction[] | undefined {
    const results: any[] = r?.results ?? []
    const out: Reaction[] = []
    for (const x of results) {
      const e = x.reaction instanceof Api.ReactionEmoji ? heart(x.reaction.emoticon) : x.reaction instanceof Api.ReactionCustomEmoji ? '⭐' : undefined
      if (!e || !x.count) continue
      const mine = x.chosenOrder !== undefined && x.chosenOrder !== null
      const by: string[] = mine ? ['me'] : []
      while (by.length < x.count) by.push('u' + by.length)
      out.push({ e, by })
    }
    return out.length ? out : undefined
  }

  private setPreview(c: ChatRec, rec: TgRec) {
    const ui = rec.ui
    c.preview = previewOfUi(ui) || c.preview
    c.previewFromMe = ui.fromMe
    c.previewSender = c.tg?.t === 'group' && !ui.fromMe ? ui.senderName?.split(' ')[0] : undefined
    c.lastMsgId = ui.id
  }

  private ingest(m: Api.Message, live: boolean, edit = false) {
    if (!m?.peerId) return
    const chatId = toId(m.peerId)
    const c = this.chat(chatId)
    if (!c.tg) {
      // first message from a chat we don't know yet: learn who it is
      const ent: any = (m as any)._chat ?? (m as any)._sender
      if (ent) this.remember(ent)
      if (!c.tg && this.client) void this.client.getEntity(m.peerId).then((e) => (this.remember(e), this.queueChat(chatId))).catch(() => {})
    }
    const rec = this.toRec(chatId, m)
    if (!rec) return
    const prev = this.store.getMessage(chatId, rec.key.id) as unknown as TgRec | undefined
    if (prev) {
      if (prev._deleted) rec._deleted = true
      if (edit && prev.ui.text !== rec.ui.text) rec.ui.originalText = prev.ui.originalText ?? prev.ui.text
      else if (prev.ui.originalText) rec.ui.originalText = prev.ui.originalText
    }
    this.raw.set(chatId + '/' + rec.key.id, m)
    if (this.raw.size > 600) this.raw.delete(this.raw.keys().next().value!)
    const isNew = this.store.putMessage(chatId, rec as unknown as WAMessage)
    const ts = rec.ui.ts
    if (ts >= c.ts || c.lastMsgId === rec.key.id) {
      c.ts = Math.max(c.ts, ts)
      this.setPreview(c, rec)
    }
    if (live && isNew && !edit) {
      if (rec.ui.fromMe) {
        c.unread = 0
        c.markedUnread = false
      } else if (rec.ui.kind !== 'system') {
        const looking = this.activeChat === chatId && this.focused && !this.screenLocked
        if (looking) void this.read(chatId)
        else c.unread = (c.unread || 0) + 1
        if (!looking && !isMuted(c) && !c.archived) {
          this.onIncoming?.({ chat: c, chatName: this.chatName(c), senderName: c.tg?.t === 'group' ? rec.ui.senderName : undefined, preview: previewOfUi(rec.ui) || 'Nova mensagem' })
        }
        if (rec.ui.kind === 'audio' && rec.ui.ptt && !this.loaded.has(chatId)) this.emit({ type: 'voiceIn', message: this.uiOf(rec) })
      }
    }
    this.queueMsg(chatId, rec)
    this.queueChat(chatId)
  }

  private onDeleted(e: any) {
    const ids: number[] = e.deletedIds ?? []
    if (!ids.length) return
    // channels say which chat; private chats/basic groups only send ids (unique per account)
    const chats = e.peer ? [toId(e.peer)] : [...this.store.chats.keys()].filter((id) => !rawId(id).startsWith('-100'))
    for (const chatId of chats) {
      if (!e.peer && !this.store.buckets.has(chatId) && !this.loaded.has(chatId)) continue
      for (const n of ids) {
        const rec = this.store.getMessage(chatId, String(n)) as unknown as TgRec | undefined
        if (!rec || rec._deleted) continue
        rec._deleted = true
        this.store.putMessage(chatId, rec as unknown as WAMessage)
        this.queueMsg(chatId, rec)
      }
    }
  }

  private onTyping(chatId: string, who: string | undefined, action: any) {
    const on = !(action instanceof Api.SendMessageCancelAction)
    const name = who ? (this.store.contacts.get(who)?.name ?? '').split(' ')[0] || undefined : undefined
    this.emit({ type: 'typing', chatId, who: name, on })
  }

  private onReadOut(chatId: string, maxId: number) {
    const c = this.store.chats.get(chatId)
    if (!c) return
    c.tg = { ...(c.tg ?? { t: 'user' }), readOut: Math.max(c.tg?.readOut ?? 0, maxId) }
    this.store.markList()
    if (!this.loaded.has(chatId)) return
    const recs = this.store.sorted(chatId).slice(-80) as unknown as TgRec[]
    for (const r of recs) if (r.ui.fromMe && Number(r.ui.id) <= maxId) this.queueMsg(chatId, r)
  }

  private onReadIn(chatId: string, still: number) {
    const c = this.store.chats.get(chatId)
    if (!c) return
    c.unread = still
    if (!still) c.markedUnread = false
    this.queueChat(chatId)
  }

  /** where each poll lives: vote updates only carry the poll's id */
  private pollIndex = new Map<string, { chatId: string; msgId: string }>()
  private onPoll(u: Api.UpdateMessagePoll) {
    const id = u.pollId.toString()
    let at = this.pollIndex.get(id)
    if (!at)
      for (const [chatId, b] of this.store.buckets)
        for (const r of b.msgs.values() as Iterable<unknown>) {
          const rec = r as TgRec
          if (rec.poll?.id === id) at = { chatId, msgId: rec.key.id }
        }
    if (!at) return
    const rec = this.store.getMessage(at.chatId, at.msgId) as unknown as TgRec | undefined
    if (!rec?.ui.poll) return
    const prev = rec.ui.poll
    const poll =
      u.poll instanceof Api.Poll
        ? u.poll
        : // no poll in the update: rebuild it from what we know (only names/ids are needed)
          new Api.Poll({
            id: u.pollId,
            question: new Api.TextWithEntities({ text: prev.name, entities: [] }),
            answers: prev.options.map((o, i) => new Api.PollAnswer({ text: new Api.TextWithEntities({ text: o.name, entities: [] }), option: Buffer.from(rec.poll?.opts[i] ?? '', 'base64') })),
            multipleChoice: prev.multi,
            closed: prev.closed
          })
    rec.ui.poll = tgPoll(poll, u.results as Api.PollResults, prev)
    this.store.putMessage(at.chatId, rec as unknown as WAMessage)
    this.queueMsg(at.chatId, rec)
  }

  private onReactions(chatId: string, msgId: string, reactions: any) {
    const rec = this.store.getMessage(chatId, msgId) as unknown as TgRec | undefined
    if (!rec) return
    rec.ui.reactions = this.reactionsOf(reactions)
    this.store.putMessage(chatId, rec as unknown as WAMessage)
    this.queueMsg(chatId, rec)
  }

  private queueChat(id: string) {
    this.pendingChats.add(id)
    this.store.markList()
    this.kick()
  }

  private queueMsg(chatId: string, rec: TgRec) {
    if (!this.loaded.has(chatId)) return
    let map = this.pendingMsgs.get(chatId)
    if (!map) this.pendingMsgs.set(chatId, (map = new Map()))
    map.set(rec.key.id, this.uiOf(rec))
    this.kick()
  }

  private kick() {
    if (this.batchTimer) return
    this.batchTimer = setTimeout(() => {
      this.batchTimer = null
      if (this.pendingChats.size) {
        const chats = [...this.pendingChats].map((id) => this.store.chats.get(id)).filter(Boolean).map((c) => this.toUiChat(c!))
        this.pendingChats.clear()
        this.emit({ type: 'chats', chats })
      }
      for (const [chatId, map] of this.pendingMsgs) this.emit({ type: 'msgs', chatId, messages: [...map.values()] })
      this.pendingMsgs.clear()
    }, BATCH_MS)
  }

  /** older (or the newest, offsetId 0) messages from the server into the local cache */
  private async fetchHistory(chatId: string, offsetId: number, limit = PAGE) {
    const client = this.requireOpen()
    const peer = await this.peer(chatId)
    const list = (await Promise.race([
      client.getMessages(peer, { limit, offsetId }),
      new Promise<never>((_, j) => setTimeout(() => j(new Error('timeout')), 9000))
    ])) as Api.Message[]
    for (const m of list) this.ingest(m, false)
    if (offsetId && list.length < limit) this.historyEnd.add(chatId)
    if (!offsetId && list.length < limit) this.historyEnd.add(chatId)
    return list.length
  }

  private visible(chatId: string): TgRec[] {
    return (this.store.sorted(chatId) as unknown as TgRec[]).filter((r) => r.ui)
  }

  async peek(chatId: string): Promise<UiMessage[]> {
    let list = this.visible(chatId)
    if (list.length < 3 && this.conn === 'open') {
      await Promise.race([this.fetchHistory(chatId, 0, 20).catch(() => 0), new Promise((r) => setTimeout(r, 2500))])
      list = this.visible(chatId)
    }
    const fav = this.favIds()
    return list.slice(-8).map((r) => this.uiOf(r, fav))
  }

  async getMessages(chatId: string, beforeTs?: number) {
    this.loaded.add(chatId)
    this.store.setKeep([...this.loaded].slice(-8))
    const c = this.store.chats.get(chatId)
    const open = this.conn === 'open'
    // back after being offline: the newest messages may be missing locally
    if (!beforeTs && open && c?.lastMsgId && !this.store.getMessage(chatId, c.lastMsgId)) await this.fetchHistory(chatId, 0).catch(() => {})
    const page = () => {
      const all = this.visible(chatId)
      let end = all.length
      if (beforeTs) {
        end = all.findIndex((r) => r.ui.ts >= beforeTs)
        if (end < 0) end = all.length
      }
      const start = Math.max(0, end - PAGE)
      return { all, start, list: all.slice(start, end) }
    }
    let p = page()
    if (p.list.length < PAGE && open && !this.historyEnd.has(chatId)) {
      const oldest = p.all[0]
      await this.fetchHistory(chatId, oldest ? Number(oldest.ui.id) : 0).catch(() => {})
      p = page()
    }
    const fav = this.favIds()
    return { messages: p.list.map((r) => this.uiOf(r, fav)), hasMore: p.start > 0 || !this.historyEnd.has(chatId) }
  }

  /** photos, videos, documents and links stored for this chat, newest first */
  getShared(chatId: string): SharedItems {
    const all = this.visible(chatId)
    const fav = this.favIds()
    const media: UiMessage[] = []
    const docs: UiMessage[] = []
    const links: SharedLink[] = []
    for (let i = all.length - 1; i >= 0; i--) {
      const r = all[i]
      if (r._deleted || r.ui.kind === 'deleted') continue
      const ui = this.uiOf(r, fav)
      if ((ui.kind === 'image' || ui.kind === 'video') && media.length < 600) media.push(ui)
      if (ui.kind === 'document' && docs.length < 400) docs.push(ui)
      const urls = extractUrls(ui.text)
      if (ui.link?.url && !urls.includes(ui.link.url)) urls.unshift(ui.link.url)
      if (urls.length && links.length < 400) {
        for (let u = 0; u < urls.length && links.length < 400; u++) {
          const url = urls[u]
          const match = ui.link && (ui.link.url === url || u === 0) ? ui.link : undefined
          links.push({
            id: ui.id + ':' + u,
            msgId: ui.id,
            url,
            title: match?.title,
            description: match?.description,
            thumb: match?.thumb,
            text: ui.text && ui.text.trim() !== url ? ui.text.slice(0, 180) : undefined,
            senderName: ui.fromMe ? 'Você' : ui.senderName,
            fromMe: ui.fromMe,
            ts: ui.ts
          })
        }
      }
      if (media.length >= 600 && docs.length >= 400 && links.length >= 400) break
    }
    return { media, docs, links, totalMsgs: all.length }
  }

  // ---------- sending ----------

  async send(chatId: string, text: string, quotedId?: string, opts?: { noPreview?: boolean }) {
    const client = this.requireOpen()
    const peer = await this.peer(chatId)
    const { text: t, entities } = fromMarkup(text)
    const sent = await client.sendMessage(peer, {
      message: t,
      formattingEntities: entities,
      replyTo: quotedId ? Number(quotedId) : undefined,
      linkPreview: !opts?.noPreview && this.settings.linkPreviews
    })
    if (sent) this.ingest(sent, true)
  }

  async sendFiles(chatId: string, files: { name: string; mime: string; path?: string; data?: Buffer }[], caption?: string) {
    const client = this.requireOpen()
    const peer = await this.peer(chatId)
    for (let i = 0; i < files.length; i++) {
      const f = files[i]
      const size = f.path ? fs.statSync(f.path).size : (f.data?.length ?? 0)
      if (size > MAX_FILE) throw new Error(`${f.name} passa de 2 GB (limite do Telegram)`)
      const isPhoto = /^image\/(jpeg|png|webp)$/.test(f.mime) && size <= MAX_PHOTO
      const isVideo = f.mime.startsWith('video/')
      const isAudio = f.mime.startsWith('audio/')
      const cap = i === 0 && caption ? fromMarkup(caption) : undefined
      const sent = await client.sendFile(peer, {
        file: f.path ?? new CustomFile(f.name, size, '', f.data!),
        caption: cap?.text,
        formattingEntities: cap?.entities,
        forceDocument: !(isPhoto || isVideo || isAudio),
        supportsStreaming: isVideo,
        workers: 4
      })
      if (sent) this.ingest(sent as Api.Message, true)
    }
  }

  async resend(chatId: string, msgId: string) {
    const rec = this.store.getMessage(chatId, msgId) as unknown as TgRec | undefined
    if (!rec) return
    if (rec.ui.kind === 'text' && rec.ui.text) await this.send(chatId, rec.ui.text)
    else await this.requireOpen().forwardMessages(await this.peer(chatId), { messages: [Number(msgId)], fromPeer: await this.peer(chatId) })
  }

  async person(id: string, pushName?: string): Promise<PersonInfo> {
    const c = this.store.contacts.get(id)
    const digits = c?.phoneNumber?.replace(/\D/g, '')
    return {
      id,
      name: c?.name || this.store.chats.get(id)?.name || pushName || 'Contato',
      savedName: c?.name || undefined,
      phone: digits ? '+' + digits : undefined,
      phoneRaw: digits ? '+' + digits : undefined
    }
  }

  async editMessage(chatId: string, msgId: string, text: string) {
    const client = this.requireOpen()
    const { text: t, entities } = fromMarkup(text.trim())
    if (!t) return
    const res = await client.editMessage(await this.peer(chatId), { message: Number(msgId), text: t, formattingEntities: entities })
    if (res) this.ingest(res, true, true)
  }

  async sendPoll(chatId: string, name: string, options: string[], multi: boolean) {
    const values = [...new Set(options.map((o) => o.trim()).filter(Boolean))].slice(0, 10)
    if (!name.trim() || values.length < 2) throw new Error('A enquete precisa de uma pergunta e 2 opções')
    const client = this.requireOpen()
    const poll = new Api.Poll({
      id: big(Date.now()),
      question: new Api.TextWithEntities({ text: name.trim(), entities: [] }),
      answers: values.map((v, i) => new Api.PollAnswer({ text: new Api.TextWithEntities({ text: v, entities: [] }), option: Buffer.from([i]) })),
      multipleChoice: multi
    })
    const sent = await client.sendMessage(await this.peer(chatId), { message: '', file: new Api.InputMediaPoll({ poll }) })
    if (sent) this.ingest(sent, true)
  }

  async votePoll(chatId: string, msgId: string, picked: number[]) {
    const client = this.requireOpen()
    const rec = this.store.getMessage(chatId, msgId) as unknown as TgRec | undefined
    if (!rec?.poll || !rec.ui.poll) return
    const opts = [...new Set(picked)].filter((i) => i >= 0 && i < rec.poll!.opts.length)
    const res: any = await client.invoke(new Api.messages.SendVote({ peer: await this.peer(chatId), msgId: Number(msgId), options: opts.map((i) => Buffer.from(rec.poll!.opts[i], 'base64')) }))
    for (const u of res?.updates ?? []) if (u instanceof Api.UpdateMessagePoll) this.onPoll(u)
  }

  async react(chatId: string, msgId: string, emoji: string) {
    const client = this.requireOpen()
    const rec = this.store.getMessage(chatId, msgId) as unknown as TgRec | undefined
    if (!rec) return
    const mine = rec.ui.reactions?.find((r) => r.by.includes('me'))?.e
    const remove = mine === emoji
    // optimistic: Telegram keeps one reaction per person (non-premium)
    const list = (rec.ui.reactions ?? []).map((r) => ({ e: r.e, by: r.by.filter((b) => b !== 'me') })).filter((r) => r.by.length)
    if (!remove) {
      const hit = list.find((r) => r.e === emoji)
      hit ? hit.by.unshift('me') : list.push({ e: emoji, by: ['me'] })
    }
    rec.ui.reactions = list.length ? list : undefined
    this.store.putMessage(chatId, rec as unknown as WAMessage)
    this.queueMsg(chatId, rec)
    try {
      await client.invoke(
        new Api.messages.SendReaction({
          peer: await this.peer(chatId),
          msgId: Number(msgId),
          reaction: remove ? [] : [new Api.ReactionEmoji({ emoticon: emoji.replace(/️/g, '') })]
        })
      )
    } catch (err: any) {
      if (/REACTION_INVALID|REACTION_EMPTY/.test(String(err?.errorMessage ?? err))) throw new Error('Essa conversa não aceita essa reação no Telegram')
      throw err
    }
  }

  async read(chatId: string, force = false) {
    const c = this.store.chats.get(chatId)
    if (!c) return
    const unread = c.unread + (force ? (this.heldReads.get(chatId) ?? 0) : 0)
    const wasMarked = c.markedUnread
    if (!unread && !wasMarked && !force) return
    c.unread = 0
    c.markedUnread = false
    this.queueChat(chatId)
    if (this.settings.ghost.noReadReceipts && !force) {
      this.heldReads.set(chatId, (this.heldReads.get(chatId) ?? 0) + unread)
      return
    }
    this.heldReads.delete(chatId)
    const client = this.client
    if (this.conn !== 'open' || !client) return
    const peer = await this.peer(chatId).catch(() => undefined)
    if (!peer) return
    await client.markAsRead(peer).catch(() => {})
    if (wasMarked) await client.invoke(new Api.messages.MarkDialogUnread({ peer: new Api.InputDialogPeer({ peer }), unread: false })).catch(() => {})
  }

  async typing(chatId: string, on: boolean) {
    if (this.conn !== 'open' || this.settings.ghost.noTyping) return
    const peer = await this.peer(chatId).catch(() => undefined)
    if (!peer) return
    await this.client?.invoke(new Api.messages.SetTyping({ peer, action: on ? new Api.SendMessageTypingAction() : new Api.SendMessageCancelAction() })).catch(() => {})
  }

  async setOnline(on: boolean) {
    if (this.conn !== 'open') return
    await this.client?.invoke(new Api.account.UpdateStatus({ offline: !(on && !this.settings.ghost.hideOnline) })).catch(() => {})
  }

  setActive(chatId: string | null) {
    this.activeChat = chatId
    this.store.setKeep([...this.loaded].slice(-8))
  }

  async chatAction(chatId: string, a: ChatAction) {
    if ('delete' in a) return this.deleteChat(chatId)
    if ('block' in a) return this.block(chatId, a.block)
    const c = this.chat(chatId)
    const online = this.conn === 'open'
    const peer = online ? await this.peer(chatId).catch(() => undefined) : undefined
    const client = this.client
    const bg = (p: Promise<unknown> | undefined) => void p?.catch((err) => logError('tg chatAction', err))
    if ('pin' in a) {
      c.localPin = undefined
      c.waPinned = a.pin ? Date.now() : undefined
      if (peer) bg(client?.invoke(new Api.messages.ToggleDialogPin({ peer: new Api.InputDialogPeer({ peer }), pinned: a.pin })))
    } else if ('mute' in a) {
      c.muteUntil = a.mute ? -1 : undefined
      if (peer) bg(client?.invoke(new Api.account.UpdateNotifySettings({ peer: new Api.InputNotifyPeer({ peer }), settings: new Api.InputPeerNotifySettings({ muteUntil: a.mute ? 2147483647 : 0 }) })))
    } else if ('archive' in a) {
      c.archived = a.archive || undefined
      if (peer) bg(client?.invoke(new Api.folders.EditPeerFolders({ folderPeers: [new Api.InputFolderPeer({ peer, folderId: a.archive ? 1 : 0 })] })))
    } else if ('markUnread' in a) {
      c.markedUnread = a.markUnread
      if (!a.markUnread) {
        c.unread = 0
        if (peer) bg(client?.markAsRead(peer))
      }
      if (peer) bg(client?.invoke(new Api.messages.MarkDialogUnread({ peer: new Api.InputDialogPeer({ peer }), unread: a.markUnread })))
    } else if ('section' in a) {
      c.section = a.section ?? undefined
    } else if ('alias' in a) {
      c.alias = a.alias?.trim().slice(0, 60) || undefined
    }
    this.queueChat(chatId)
  }

  /** private chats: deleted for both sides; groups: history cleared for you; channels: you leave */
  async deleteChat(chatId: string) {
    const client = this.requireOpen()
    const peer = await this.peer(chatId)
    const t = this.store.chats.get(chatId)?.tg?.t
    if (peer instanceof Api.InputPeerChannel) {
      const channel = new Api.InputChannel({ channelId: peer.channelId, accessHash: peer.accessHash })
      if (t === 'channel') await client.invoke(new Api.channels.LeaveChannel({ channel }))
      else await client.invoke(new Api.channels.DeleteHistory({ channel, maxId: 0, forEveryone: false }))
    } else {
      await client.invoke(new Api.messages.DeleteHistory({ peer, maxId: 0, revoke: t === 'user' || t === 'bot', justClear: false }))
    }
    this.store.removeChat(chatId)
    this.loaded.delete(chatId)
    this.historyEnd.delete(chatId)
    this.pendingChats.delete(chatId)
    this.pendingMsgs.delete(chatId)
    if (this.activeChat === chatId) this.activeChat = null
    this.store.meta.scheduled = this.store.meta.scheduled.filter((s) => s.chatId !== chatId)
    this.store.meta.reminders = this.store.meta.reminders.filter((r) => r.chatId !== chatId)
    this.store.markMeta()
    this.emitScheduled()
    this.emit({ type: 'chatsRemoved', ids: [chatId] })
  }

  async block(chatId: string, block: boolean) {
    const t = this.store.chats.get(chatId)?.tg?.t
    if (t === 'group' || t === 'channel') throw new Error('Grupos e canais não podem ser bloqueados — saia pelo menu “Apagar conversa”')
    const client = this.requireOpen()
    const id = await this.peer(chatId)
    await client.invoke(block ? new Api.contacts.Block({ id }) : new Api.contacts.Unblock({ id }))
    block ? this.blocked.add(chatId) : this.blocked.delete(chatId)
    this.queueChat(chatId)
  }

  /** "@usuario", "t.me/usuario" or a phone number → chat id */
  async resolveNumber(input: string): Promise<string | null> {
    const client = this.requireOpen()
    const s = input.trim()
    const user = /^(?:@|https?:\/\/t\.me\/|t\.me\/)?([a-zA-Z][\w]{3,31})$/.exec(s)?.[1]
    try {
      let res: any
      if (user) res = await client.invoke(new Api.contacts.ResolveUsername({ username: user }))
      else {
        let digits = s.replace(/\D/g, '')
        if (digits.length === 10 || digits.length === 11) digits = '55' + digits
        if (digits.length < 8) return null
        res = await client.invoke(new Api.contacts.ResolvePhone({ phone: digits }))
      }
      for (const e of [...(res.users ?? []), ...(res.chats ?? [])]) this.remember(e)
      const id = toId(res.peer)
      const c = this.chat(id)
      const ent = [...(res.users ?? []), ...(res.chats ?? [])].find((e: any) => toId(e) === id)
      if (ent) {
        const info = infoOf(ent, this.me?.id)
        if (info) c.tg = info
        c.name = nameOf(ent)
      }
      if (!c.ts) c.ts = Date.now()
      this.queueChat(id)
      return id
    } catch {
      return null
    }
  }

  // ---------- timers: scheduled messages + reminders (same as WhatsApp) ----------

  startTimers() {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.tickTimers().catch((err) => logError('tg timers', err))
      // a cheap resync of unread counts / pins every few minutes (covers missed updates)
      if (this.conn === 'open' && Date.now() - this.lastDialogs > 3 * 60_000) this.refreshDialogsSoon(0)
    }, 10_000)
  }

  emitScheduled() {
    this.emit({ type: 'scheduled', scheduled: this.store.meta.scheduled, reminders: this.store.meta.reminders })
  }

  private async tickTimers() {
    const now = Date.now()
    const meta = this.store.meta
    if (this.conn === 'open') {
      for (const s of meta.scheduled.filter((x) => x.at <= now && !this.sendingScheduled.has(x.id))) {
        this.sendingScheduled.add(s.id)
        try {
          await this.send(s.chatId, s.text)
          meta.scheduled = meta.scheduled.filter((x) => x.id !== s.id)
          this.store.markMeta()
          this.onScheduledSent?.(s, this.chatName(this.chat(s.chatId)))
          this.emitScheduled()
        } catch {
          // stays queued; retried next tick
        } finally {
          this.sendingScheduled.delete(s.id)
        }
      }
    }
    const due = meta.reminders.filter((r) => r.at <= now)
    if (due.length) {
      meta.reminders = meta.reminders.filter((r) => r.at > now)
      this.store.markMeta()
      for (const r of due) this.onReminder?.(r, this.chatName(this.chat(r.chatId)))
      this.emitScheduled()
    }
  }

  schedule(chatId: string, text: string, at: number) {
    if (!text.trim()) throw new Error('Mensagem vazia')
    if (at < Date.now() + 30_000) throw new Error('Escolha um horário no futuro')
    this.store.meta.scheduled.push({ id: Math.random().toString(36).slice(2), chatId, text, at })
    this.store.meta.scheduled.sort((a, b) => a.at - b.at)
    this.store.markMeta()
    this.emitScheduled()
  }

  cancelScheduled(id: string) {
    this.store.meta.scheduled = this.store.meta.scheduled.filter((s) => s.id !== id)
    this.store.markMeta()
    this.emitScheduled()
  }

  remind(chatId: string, msgId: string, at: number) {
    const rec = this.store.getMessage(chatId, msgId) as unknown as TgRec | undefined
    const text = rec ? previewOfUi(rec.ui) || 'Mensagem' : 'Mensagem'
    this.store.meta.reminders.push({ id: Math.random().toString(36).slice(2), chatId, msgId, text, at })
    this.store.meta.reminders.sort((a, b) => a.at - b.at)
    this.store.markMeta()
    this.emitScheduled()
  }

  cancelReminder(id: string) {
    this.store.meta.reminders = this.store.meta.reminders.filter((r) => r.id !== id)
    this.store.markMeta()
    this.emitScheduled()
  }

  exportText(chatId: string): string {
    const chat = this.chat(chatId)
    const fmt = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
    const lines = [`Conversa: ${this.chatName(chat)} (Telegram)`, `Exportada pelo Zapdesk em ${fmt.format(Date.now())}`, '']
    for (const r of this.visible(chatId)) {
      const ui = this.uiOf(r)
      const who = ui.fromMe ? 'Você' : ui.senderName || this.chatName(chat)
      let body = ui.kind === 'text' || ui.kind === 'system' ? (ui.text ?? '') : previewOfUi(ui)
      if (ui.quoted) body = `(respondendo "${ui.quoted.text.slice(0, 60)}") ` + body
      if (ui.revoked) body += ' [apagada]'
      if (ui.edited) body += ' [editada]'
      const reacts = ui.reactions?.map((x) => x.e + (x.by.length > 1 ? x.by.length : '')).join(' ')
      lines.push(`[${fmt.format(ui.ts)}] ${who}: ${body.trim()}${reacts ? '  ' + reacts : ''}`)
    }
    return lines.join('\r\n')
  }

  setTranscript(msgId: string, text: string, chatId?: string) {
    const t = (this.store.meta.transcripts ??= {})
    const key = (chatId ?? '') + '/' + msgId
    delete t[key]
    t[key] = text
    const keys = Object.keys(t)
    for (const k of keys.slice(0, Math.max(0, keys.length - 3000))) delete t[k]
    this.store.markMeta()
    if (chatId && this.store.chats.get(chatId)?.lastMsgId === msgId) this.queueChat(chatId)
  }

  // ---------- media ----------

  private async rawMsg(chatId: string, msgId: string): Promise<Api.Message> {
    const hit = this.raw.get(chatId + '/' + msgId)
    if (hit) return hit
    const client = this.requireOpen()
    const [m] = (await client.getMessages(await this.peer(chatId), { ids: [Number(msgId)] })) as Api.Message[]
    if (!m) throw new Error('not found')
    this.raw.set(chatId + '/' + msgId, m)
    return m
  }

  private mediaFile(chatId: string, msgId: string, rec: TgRec) {
    const ext = rec.media?.stickerThumb ? 'webp' : extOfMime(rec.media?.mime, rec.media?.name)
    return path.join(this.store.dir, 'media', sha('tg/' + chatId + '/' + msgId) + '.' + ext)
  }

  /** documents (videos, voice notes, files): parallel download that can be played while it arrives */
  private docFile(chatId: string, msgId: string): TgFile | string | null {
    const rec = this.store.getMessage(chatId, msgId) as unknown as TgRec | undefined
    if (!rec?.media?.docId || rec.media.stickerThumb || !rec.media.size) return null
    const file = this.mediaFile(chatId, msgId, rec)
    if (fs.existsSync(file)) return file
    const key = chatId + '/' + msgId
    const running = this.files.get(key)
    if (running) return running
    const client = this.requireOpen()
    let calls = 0
    const locate = async () => {
      // the first try may use the cached message; later ones (expired file reference) fetch it fresh
      if (calls++) this.raw.delete(key)
      const msg = await this.rawMsg(chatId, msgId)
      const d = (msg.media as any)?.document as Api.Document | undefined
      if (!(d instanceof Api.Document)) throw new Error('not a document')
      return { location: new Api.InputDocumentFileLocation({ id: d.id, accessHash: d.accessHash, fileReference: d.fileReference, thumbSize: '' }), dcId: d.dcId }
    }
    const f = new TgFile(client, locate, rec.media.size, file)
    this.files.set(key, f)
    f.complete.catch((err) => logError('tg download', err)).finally(() => this.files.delete(key))
    return f
  }

  /** for the zap:// protocol: a finished file, or a download to stream from */
  async mediaStream(chatId: string, msgId: string): Promise<{ file: string } | { tg: TgFile } | null> {
    const d = this.docFile(chatId, msgId)
    if (!d) return null
    return typeof d === 'string' ? { file: d } : { tg: d }
  }

  async media(chatId: string, msgId: string): Promise<string> {
    const key = chatId + '/' + msgId
    const job = this.mediaJobs.get(key)
    if (job) return job
    const doc = this.docFile(chatId, msgId)
    if (typeof doc === 'string') return doc
    if (doc) return doc.complete
    const p = (async () => {
      const rec = this.store.getMessage(chatId, msgId) as unknown as TgRec | undefined
      if (!rec) throw new Error('not found')
      const ext = rec.media?.stickerThumb ? 'webp' : extOfMime(rec.media?.mime, rec.media?.name)
      const file = path.join(this.store.dir, 'media', sha('tg/' + key) + '.' + ext)
      if (fs.existsSync(file)) return file
      const msg = await this.rawMsg(chatId, msgId)
      const part = file + '.part'
      const thumbs = (msg.media as any)?.document?.thumbs as any[] | undefined
      const out = await this.client!.downloadMedia(msg, {
        outputFile: part,
        thumb: rec.media?.stickerThumb && thumbs?.length ? thumbs.length - 1 : undefined
      })
      if (Buffer.isBuffer(out)) fs.writeFileSync(part, out)
      if (!fs.existsSync(part)) throw new Error('download failed')
      fs.renameSync(part, file)
      return file
    })()
    this.mediaJobs.set(key, p)
    p.catch(() => {}).finally(() => setTimeout(() => this.mediaJobs.delete(key), 1000))
    return p
  }

  private posterJobs = new Map<string, Promise<string | null>>()
  /** sharp still for a video: the first frame the renderer grabbed, or the thumbnail the sender's app made (~15 KB) */
  async poster(chatId: string, msgId: string): Promise<string | null> {
    if (this.store.hasPoster(chatId, msgId)) return this.store.posterFile(chatId, msgId)
    const key = chatId + '/' + msgId
    const job = this.posterJobs.get(key)
    if (job) return job
    const p = (async () => {
      if (!this.client) return null
      const msg = await this.rawMsg(chatId, msgId)
      const thumbs = ((msg.media as any)?.document?.thumbs as any[] | undefined) ?? []
      // biggest real picture (not the blurry inline one, not the vector outline)
      let best = -1
      let area = 0
      thumbs.forEach((t, i) => {
        const a = (t?.w ?? 0) * (t?.h ?? 0)
        if ((t instanceof Api.PhotoSize || t instanceof Api.PhotoSizeProgressive) && a > area) {
          best = i
          area = a
        }
      })
      if (best < 0) return null
      const buf = await this.client.downloadMedia(msg, { thumb: best })
      if (!Buffer.isBuffer(buf) || !buf.length) return null
      this.store.savePoster(chatId, msgId, buf)
      return this.store.hasPoster(chatId, msgId) ? this.store.posterFile(chatId, msgId) : null
    })()
    this.posterJobs.set(key, p)
    p.catch(() => {}).finally(() => setTimeout(() => this.posterJobs.delete(key), 1000))
    return p
  }

  mimeOf(chatId: string, msgId: string) {
    const rec = this.store.getMessage(chatId, msgId) as unknown as TgRec | undefined
    if (rec?.media?.stickerThumb) return 'image/webp'
    return rec?.media?.mime?.split(';')[0]
  }

  fileNameOf(chatId: string, msgId: string) {
    return (this.store.getMessage(chatId, msgId) as unknown as TgRec | undefined)?.media?.name
  }

  private avatarFile(id: string, bigPic = false) {
    return path.join(this.store.dir, 'avatars', id.replace(/[^a-zA-Z0-9@._-]/g, '_') + (bigPic ? '.big' : '') + '.jpg')
  }

  async avatar(raw: string, bigPic = false): Promise<string | null> {
    const file = this.avatarFile(raw, bigPic)
    try {
      const st = fs.statSync(file)
      if (Date.now() - st.mtimeMs < 3 * 86400_000 || this.conn !== 'open') return st.size ? file : null
    } catch {}
    if (this.conn !== 'open' || !raw.startsWith('tg:')) return null
    const jobKey = raw + (bigPic ? '#big' : '')
    const job = this.avatarJobs.get(jobKey)
    if (job) return job
    const p = new Promise<string | null>((resolve) => {
      const run = async () => {
        this.avatarActive++
        try {
          const ent = await this.peer(raw)
          const buf = (await this.client!.downloadProfilePhoto(ent, { isBig: bigPic })) as Buffer | undefined
          fs.writeFileSync(file, buf && buf.length ? buf : Buffer.alloc(0))
          resolve(buf && buf.length ? file : null)
        } catch {
          resolve(null)
        } finally {
          this.avatarActive--
          this.avatarJobs.delete(jobKey)
          this.avatarQueue.shift()?.()
        }
      }
      if (this.avatarActive < 3) void run()
      else this.avatarQueue.push(() => void run())
    })
    this.avatarJobs.set(jobKey, p)
    return p
  }

  avatarCached(id: string): string | undefined {
    const file = this.avatarFile(id)
    try {
      return fs.statSync(file).size ? file : undefined
    } catch {
      return undefined
    }
  }

  // ---------- favorite stickers (Telegram's "faved stickers") ----------

  private favIds() {
    return new Set(this.store.meta.stickers.map((s) => s.id))
  }

  stickers(): FavSticker[] {
    return this.store.meta.stickers
      .slice()
      .sort((a, b) => b.ts - a.ts)
      .map((s) => ({ id: s.id, ready: fs.existsSync(this.stickerPath(s.id)), w: s.width, h: s.height, source: s.source }))
  }

  stickerPath(id: string) {
    return path.join(this.store.dir, 'stickers', id.replace(/[^a-z0-9]/gi, '') + '.webp')
  }

  async resyncStickers() {
    const client = this.requireOpen()
    const res: any = await client.invoke(new Api.messages.GetFavedStickers({ hash: bigInt(0) }))
    if (!(res instanceof Api.messages.FavedStickers)) return
    const now = Date.now()
    const list: StickerRec[] = []
    res.stickers.forEach((d: any, i: number) => {
      if (!(d instanceof Api.Document)) return
      const id = d.id.toString()
      this.stickerDocs.set(id, d)
      const size: any = (d.attributes as any[]).find((a) => a instanceof Api.DocumentAttributeImageSize || a instanceof Api.DocumentAttributeVideo)
      const prev = this.store.meta.stickers.find((s) => s.id === id)
      list.push({ id, source: 'account', mimetype: d.mimeType, width: size?.w ?? 512, height: size?.h ?? 512, ts: prev?.ts ?? now - i })
    })
    this.store.meta.stickers = list
    this.store.markMeta()
    this.emit({ type: 'stickers', stickers: this.stickers() })
    for (const d of res.stickers as Api.Document[]) {
      if (!(d instanceof Api.Document)) continue
      const file = this.stickerPath(d.id.toString())
      if (fs.existsSync(file)) continue
      try {
        const media = new Api.MessageMediaDocument({ document: d })
        const thumbs = d.thumbs as any[] | undefined
        const buf = await client.downloadMedia(media, { thumb: d.mimeType !== 'image/webp' && thumbs?.length ? thumbs.length - 1 : undefined })
        if (Buffer.isBuffer(buf) && buf.length) fs.writeFileSync(file, buf)
      } catch (err) {
        logError('tg sticker', err)
      }
    }
    this.emit({ type: 'stickers', stickers: this.stickers() })
  }

  private async stickerDoc(id: string): Promise<Api.Document> {
    let d = this.stickerDocs.get(id)
    if (!d) {
      await this.resyncStickers()
      d = this.stickerDocs.get(id)
    }
    if (!d) throw new Error('Figurinha não encontrada')
    return d
  }

  async sendSticker(chatId: string, stickerId: string) {
    const client = this.requireOpen()
    const peer = await this.peer(chatId)
    const go = async () => {
      const d = await this.stickerDoc(stickerId)
      const sent = await client.sendFile(peer, { file: new Api.InputMediaDocument({ id: new Api.InputDocument({ id: d.id, accessHash: d.accessHash, fileReference: d.fileReference }) }) })
      if (sent) this.ingest(sent as Api.Message, true)
    }
    try {
      await go()
    } catch (err: any) {
      // file references expire: refresh and try once more
      if (!/FILE_REFERENCE/.test(String(err?.errorMessage ?? err))) throw err
      this.stickerDocs.delete(stickerId)
      await go()
    }
    const rec = this.store.meta.stickers.find((s) => s.id === stickerId)
    if (rec) {
      rec.ts = Date.now()
      this.store.markMeta()
    }
  }

  async favSticker(chatId: string, msgId: string, fav: boolean) {
    const client = this.requireOpen()
    const msg = await this.rawMsg(chatId, msgId)
    const d = (msg.media as any)?.document as Api.Document | undefined
    if (!(d instanceof Api.Document)) throw new Error('Não é figurinha')
    await client.invoke(new Api.messages.FaveSticker({ id: new Api.InputDocument({ id: d.id, accessHash: d.accessHash, fileReference: d.fileReference }), unfave: !fav }))
    await this.resyncStickers()
  }

  async removeSticker(id: string) {
    const client = this.requireOpen()
    const d = await this.stickerDoc(id)
    await client.invoke(new Api.messages.FaveSticker({ id: new Api.InputDocument({ id: d.id, accessHash: d.accessHash, fileReference: d.fileReference }), unfave: true }))
    fs.rmSync(this.stickerPath(id), { force: true })
    await this.resyncStickers()
  }

  // ---------- lifecycle ----------

  nudge() {
    if (this.conn === 'reconnecting' && this.client && !this.client.connected) void this.client.connect().catch(() => {})
    else if (this.conn === 'open') this.refreshDialogsSoon(1500)
  }

  async pairingCode(): Promise<string> {
    throw new Error('No Telegram a conexão é pelo QR code')
  }

  async logout() {
    try {
      await this.client?.invoke(new Api.auth.LogOut())
    } catch {}
    await this.client?.destroy().catch(() => {})
    this.client = undefined
    this.me = undefined
    this.creds.session = undefined
    this.saveCreds()
    ;(this.store.meta as any).tgMe = undefined
    ;(this.store.meta as any).tgFolders = []
    this.store.wipe()
    this.loaded.clear()
    this.historyEnd.clear()
    this.emit({ type: 'chatsRemoved', ids: ['*'] })
    this.emit({ type: 'stickers', stickers: [] })
    this.emit({ type: 'folders', folders: [] })
    await this.connect()
  }

  async destroy(logout: boolean) {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    if (logout) await this.client?.invoke(new Api.auth.LogOut()).catch(() => {})
    await this.client?.destroy().catch(() => {})
    this.client = undefined
    this.store.dispose()
  }

  shutdown() {
    this.stopped = true
    this.store.flush()
    void this.client?.disconnect().catch(() => {})
  }
}

function extOfMime(mime?: string, name?: string): string {
  const fromName = name && /\.([a-z0-9]{1,6})$/i.exec(name)?.[1]
  if (fromName) return fromName.toLowerCase()
  const m = (mime ?? '').split(';')[0]
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'application/pdf': 'pdf',
    'application/x-tgsticker': 'tgs'
  }
  return map[m] ?? (m.split('/')[1]?.replace(/[^a-z0-9]/gi, '').slice(0, 6) || 'bin')
}
