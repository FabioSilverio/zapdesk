import { pipeline } from 'node:stream/promises'
import type { ChatService, IncomingInfo } from './service'
import fs from 'node:fs'
import path from 'node:path'
import { createDecipheriv, createHash, hkdfSync } from 'node:crypto'
import { nativeImage } from 'electron'
import QRCode from 'qrcode'
import makeWASocket, {
  ALL_WA_PATCH_NAMES,
  Browsers,
  DisconnectReason,
  decryptPollVote,
  generateWAMessageFromContent,
  downloadContentFromMessage,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  getContentType,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  jidNormalizedUser,
  normalizeMessageContent,
  makeCacheableSignalKeyStore,
  proto,
  type AnyMessageContent,
  type Chat,
  type Contact,
  type GroupMetadata,
  type SignalKeyStore,
  type WAMessage,
  type WAMessageKey,
  type WASocket
} from 'baileys'
import type { ChatAction, ConnState, FavSticker, MainEvent, PersonInfo, Reminder, ScheduledMsg, SharedItems, SharedLink, UiChat, UiMessage } from '@shared/types'
import { Store, tsOf, type ChatRec, type StickerRec } from './store'
import { contentOf, encryptPollVote, extractUrls, isCiphertext, isInvisible, isRevokeStub, pollCreationOf, pollOptionHash, previewOf, putPollVote, stickerIdOf, stubTextOf, toUi, unwrapEdit, voicePreview } from './normalize'
import { getLinkMeta } from './links'
import { useAtomicAuthState } from './auth'

const BATCH_MS = 40
const PAGE = 60
const MAX_FILE = 2 * 1024 ** 3
const MAX_IMAGE = 16 * 1024 ** 2
const MAX_VIDEO = 100 * 1024 ** 2

type Emit = (ev: MainEvent) => void

export interface Incoming {
  chat: ChatRec
  chatName: string
  senderName?: string
  preview: string
  msg: WAMessage
}

const isMuted = (c: ChatRec) => {
  const m = c.muteUntil
  if (!m) return false
  if (m < 0) return true
  return (m < 1e12 ? m * 1000 : m) > Date.now()
}

/**
 * Normalizes a Baileys muteEndTime value.
 * In app-state sync actions (chats.update), muted=true with no muteEndTimestamp produces 0 (unmuted produces null);
 * in history snapshots (proto.Conversation), 0 means not muted.
 */
const parseMute = (val: unknown, fromSyncAction: boolean): number | undefined => {
  if (val == null) return undefined
  const n = typeof val === 'object' && val && 'toNumber' in (val as any) ? (val as any).toNumber() : Number(val)
  if (!Number.isFinite(n)) return undefined
  if (n === 0) return fromSyncAction ? -1 : undefined
  return n < 0 ? -1 : n
}

const extOf = (mime?: string) => {
  if (!mime) return 'bin'
  const sub = mime.split(';')[0].split('/')[1] ?? 'bin'
  return ({ jpeg: 'jpg', 'x-matroska': 'mkv', quicktime: 'mov', mpeg: 'mp3', 'vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx', 'vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx' } as Record<string, string>)[sub] ?? sub.slice(0, 8)
}

const b64 = (b?: Uint8Array | null) => (b?.length ? Buffer.from(b).toString('base64') : undefined)

export class WaService implements ChatService {
  readonly kind = 'wa' as const
  sock?: WASocket
  conn: ConnState = 'loading'
  qr?: string
  me?: { id: string; lid?: string; name?: string }
  activeChat: string | null = null
  focused = false
  /** the PIN screen is covering the app */
  screenLocked = false
  onIncoming?: (i: IncomingInfo) => void
  onCall?: (from: string) => void

  private loaded = new Set<string>()
  private pendingChats = new Set<string>()
  private pendingMsgs = new Map<string, Map<string, UiMessage>>()
  private batchTimer: NodeJS.Timeout | null = null
  private groups = new Map<string, GroupMetadata>()
  private retry = 0
  private reconnectTimer: NodeJS.Timeout | null = null
  private mediaJobs = new Map<string, Promise<string>>()
  private avatarJobs = new Map<string, Promise<string | null>>()
  private avatarMiss = new Map<string, number>()
  private avatarQueue: (() => void)[] = []
  private avatarActive = 0
  private historyAsked = new Map<string, number>()
  private stopped = false
  private authDir: string
  private keyCache?: SignalKeyStore

  constructor(
    private store: Store,
    dataDir: string,
    private emit: Emit
  ) {
    this.authDir = path.join(dataDir, 'auth')
  }

  // ---------- identity helpers ----------

  private mapLid(lid?: string | null, pn?: string | null) {
    if (!lid || !pn || !lid.endsWith('@lid') || !pn.endsWith('@s.whatsapp.net')) return
    const l = jidNormalizedUser(lid)
    const p = jidNormalizedUser(pn)
    if (this.store.meta.lidToPn[l] === p) return
    this.store.meta.lidToPn[l] = p
    this.store.markMeta()
  }

  canon(jid?: string | null): string {
    if (!jid) return ''
    const j = jidNormalizedUser(jid) || jid
    if (j.endsWith('@lid')) return this.store.meta.lidToPn[j] ?? j
    return j
  }

  private chatIdOf(key: WAMessageKey): string {
    const k = key as WAMessageKey & { remoteJidAlt?: string; participantAlt?: string }
    this.mapLid(k.remoteJid, k.remoteJidAlt)
    this.mapLid(k.participant, k.participantAlt)
    return this.canon(k.remoteJid)
  }

  private skip(jid: string) {
    return !jid || isJidBroadcast(jid) || isJidNewsletter(jid) || jid === 'status@broadcast'
  }

  private isMe(jid: string) {
    if (!this.me) return false
    return jid === this.me.id || (!!this.me.lid && jid === this.me.lid)
  }

  name = (jid: string, push?: string | null): string => {
    const id = this.canon(jid)
    if (this.isMe(id)) return 'Você'
    const c = this.store.contacts.get(id) ?? this.store.contacts.get(jidNormalizedUser(jid))
    const chat = this.store.chats.get(id)
    return c?.name || c?.verifiedName || chat?.name || c?.notify || push || formatPhone(id)
  }

  chatName(c: ChatRec): string {
    if (c.alias) return c.alias
    if (isJidGroup(c.id)) return c.name || this.groups.get(c.id)?.subject || 'Grupo'
    if (this.isMe(c.id)) return 'Eu (Anotações)'
    return this.name(c.id)
  }

  toUiChat(c: ChatRec): UiChat {
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
      preview: voicePreview(c.preview, c.lastMsgId && this.store.meta.transcripts?.[c.lastMsgId]),
      previewFromMe: c.previewFromMe,
      previewSender: c.previewSender,
      isGroup: isJidGroup(c.id) ?? false,
      blocked: this.blocked.has(c.id) || undefined,
      self: this.isMe(c.id) || undefined
    }
  }

  // ---------- real account behind a phone number ----------

  /** Brazilian mobiles exist with and without the extra 9: 55 43 9 9645-0404 ↔ 55 43 9645-0404 */
  private brAlt(jid: string): string | undefined {
    const m = /^55(\d{2})(\d+)@s\.whatsapp\.net$/.exec(jid)
    if (!m) return undefined
    const [, ddd, rest] = m
    if (rest.length === 9 && rest[0] === '9') return `55${ddd}${rest.slice(1)}@s.whatsapp.net`
    if (rest.length === 8) return `55${ddd}9${rest}@s.whatsapp.net`
    return undefined
  }

  /** jid → the account WhatsApp really has for it (null = number without WhatsApp) */
  private verified = new Map<string, string | null>()

  /**
   * Before sending to a 1:1 chat, ask WhatsApp which account that number is.
   * A chat typed/saved with the wrong 9 used to swallow messages forever (server accepts, nobody gets them).
   */
  async resolveTarget(chatId: string): Promise<string> {
    if (!chatId.endsWith('@s.whatsapp.net') || this.isMe(chatId)) return chatId
    const alt = this.brAlt(chatId)
    if (alt && this.isMe(alt)) return this.redirect(chatId, alt)
    if (this.verified.has(chatId)) {
      const v = this.verified.get(chatId)
      if (v === null) throw new Error('Esse número não tem WhatsApp')
      return v === chatId ? chatId : this.redirect(chatId, v!)
    }
    const sock = this.requireOpen()
    const res = await Promise.race([sock.onWhatsApp(chatId).catch(() => undefined), new Promise<undefined>((r) => setTimeout(() => r(undefined), 6000))])
    // lookup failed (network hiccup): don't block the send
    if (!res) return chatId
    const hit = res.find((r) => r.exists)
    const real = hit ? jidNormalizedUser(hit.jid) : null
    this.verified.set(chatId, real)
    if (!real) throw new Error('Esse número não tem WhatsApp')
    return real === chatId ? chatId : this.redirect(chatId, real)
  }

  async resolveNumber(phone: string): Promise<string | null> {
    let digits = phone.replace(/\D/g, '')
    if (digits.length === 10 || digits.length === 11) digits = '55' + digits
    if (digits.length < 10) return null
    const jid = digits + '@s.whatsapp.net'
    try {
      return await this.resolveTarget(jid)
    } catch {
      return null
    }
  }

  /** the wrong-9 chat hands its pin/section/name over to the real one, and the window follows */
  private redirect(from: string, to: string): string {
    const a = this.store.chats.get(from)
    const b = this.chat(to)
    if (a) {
      if (a.localPin && !b.localPin) b.localPin = a.localPin
      if (a.section && !b.section) b.section = a.section
      if (a.alias && !b.alias) b.alias = a.alias
      a.localPin = undefined
      a.waPinned = undefined
      this.queueChat(from)
    }
    this.queueChat(to)
    this.verified.set(from, to)
    if (this.activeChat === from) this.emit({ type: 'openChat', chatId: to })
    this.emit({ type: 'toast', text: `Esse número no WhatsApp é ${this.isMe(to) ? 'o seu' : formatPhone(to)} — mandei na conversa certa` })
    return to
  }

  /** one-time cleanup: a pinned "wrong 9" copy of your own number gives the pin back to the real self-chat */
  private fixSelfChat() {
    if (!this.me) return
    const self = this.chat(this.me.id)
    for (const c of [...this.store.chats.values()]) {
      if (c.id === this.me.id || this.brAlt(c.id) !== this.me.id) continue
      if (c.localPin || c.waPinned) {
        if (!self.localPin) self.localPin = c.localPin || Date.now()
        c.localPin = undefined
        c.waPinned = undefined
        this.queueChat(c.id)
      }
      this.verified.set(c.id, this.me.id)
    }
    if (!self.ts) self.ts = Date.now()
    this.queueChat(self.id)
  }

  /** blocked contacts (canonical jids), mirrored from the account */
  private blocked = new Set<string>()
  private setBlocked(list: string[], mode: 'set' | 'add' | 'remove') {
    const ids = list.map((j) => this.canon(j)).filter(Boolean)
    const before = new Set(this.blocked)
    if (mode === 'set') this.blocked = new Set(ids)
    else for (const id of ids) mode === 'add' ? this.blocked.add(id) : this.blocked.delete(id)
    for (const id of new Set([...before, ...this.blocked])) if (before.has(id) !== this.blocked.has(id) && this.store.chats.has(id)) this.queueChat(id)
  }

  allChats(): UiChat[] {
    // archived chats show up even without local messages (old ones the phone never sent history for)
    return [...this.store.chats.values()].filter((c) => c.ts || c.preview || c.localPin || c.waPinned || c.archived).map((c) => this.toUiChat(c))
  }

  private favIds() {
    return new Set(this.store.meta.stickers.map((s) => s.id))
  }

  uiMsg(chatId: string, m: WAMessage, fav = this.favIds()): UiMessage {
    const b = this.store.bucket(chatId)
    const ui = toUi(chatId, m, {
      name: this.name,
      canon: (j) => this.canon(j),
      reactions: b.reactions.get(m.key.id!),
      favIds: fav,
      keepDeleted: this.store.meta.settings.keepDeleted
    })
    const tr = this.store.meta.transcripts?.[ui.id]
    if (tr !== undefined) ui.transcript = tr
    if (ui.kind === 'video' && this.store.hasPoster(chatId, ui.id)) ui.poster = true
    if (ui.fromMe && ui.kind === 'text' && !ui.revoked && Date.now() - ui.ts < EDIT_WINDOW) ui.editable = true
    // sent ones still on "pending" after a while (sent before this fix, or history without a status) did go out:
    // a failed send never gets stored, so show ✓ instead of a clock forever
    if (ui.fromMe && (ui.status ?? 0) <= 1 && Date.now() - ui.ts > 60_000 && ui.kind !== 'deleted') ui.status = proto.WebMessageInfo.Status.SERVER_ACK
    return ui
  }

  /** first frame of a video, if the renderer already grabbed it */
  async poster(chatId: string, msgId: string): Promise<string | null> {
    return this.store.hasPoster(chatId, msgId) ? this.store.posterFile(chatId, msgId) : null
  }

  folders() {
    return []
  }

  /** remembers a voice note's transcription (capped, oldest dropped first) */
  setTranscript(msgId: string, text: string, chatId?: string) {
    const t = (this.store.meta.transcripts ??= {})
    delete t[msgId]
    t[msgId] = text
    const keys = Object.keys(t)
    for (const k of keys.slice(0, Math.max(0, keys.length - 3000))) delete t[k]
    this.store.markMeta()
    // the chat list shows what the voice note says when it's the last message
    if (chatId && this.store.chats.get(chatId)?.lastMsgId === msgId) this.queueChat(chatId)
  }

  private get ghost() {
    return this.store.meta.settings.ghost
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

  // ---------- batching to the renderer ----------

  private queueChat(id: string) {
    this.pendingChats.add(id)
    this.store.markList()
    this.kick()
  }

  private queueMsg(chatId: string, m: WAMessage) {
    if (!this.loaded.has(chatId)) return
    let map = this.pendingMsgs.get(chatId)
    if (!map) this.pendingMsgs.set(chatId, (map = new Map()))
    map.set(m.key.id!, this.uiMsg(chatId, m))
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

  // ---------- ingest ----------

  private chat(id: string): ChatRec {
    let c = this.store.chats.get(id)
    if (!c) {
      c = { id, ts: 0, unread: 0 }
      this.store.chats.set(id, c)
    }
    return c
  }

  private ingest(m: WAMessage, source: boolean | 'notify' | 'append' | 'history') {
    const mode = source === true ? 'notify' : source === false ? 'history' : source
    const live = mode === 'notify'
    const incoming = mode !== 'history'
    if (!m.key?.id || !m.key.remoteJid) return
    const chatId = this.chatIdOf(m.key)
    if (this.skip(chatId)) return
    const content = normalizeMessageContent(m.message ?? undefined)
    const type = content ? getContentType(content) : undefined

    if (type === 'reactionMessage') {
      const r = content!.reactionMessage!
      const who = m.key.fromMe ? 'me' : this.canon(m.key.participant || m.key.remoteJid)
      if (r.key?.id) this.applyReaction(chatId, r.key.id, who, r.text ?? '')
      return
    }
    // edits now come end-to-end encrypted with the original message's secret: open them here
    if (type === 'secretEncryptedMessage') {
      if (!this.openSecretEdit(chatId, m)) this.store.putMessage(chatId, m) // original not here yet: retried when the chat opens
      return
    }
    // a vote: encrypted with the poll's secret, counted on the poll itself
    if (type === 'pollUpdateMessage') {
      if (!this.openPollVote(chatId, m)) this.store.putMessage(chatId, m) // poll not here yet: retried when the chat opens
      return
    }
    if (type === 'protocolMessage') {
      const pm = content!.protocolMessage!
      if (pm.type === proto.Message.ProtocolMessage.Type.REVOKE && pm.key?.id) this.markDeleted(chatId, pm.key.id)
      if (pm.type === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT && pm.key?.id && pm.editedMessage)
        this.applyEdit(chatId, pm.key.id, pm.editedMessage)
      return
    }
    if (isInvisible(m)) return

    const sender = m.key.fromMe ? undefined : this.canon(m.key.participant || m.participant || m.key.remoteJid)
    if (sender && m.pushName && !this.isMe(sender)) {
      const c = this.store.contacts.get(sender)
      if (!c) this.store.contacts.set(sender, { id: sender, notify: m.pushName })
      else if (c.notify !== m.pushName) c.notify = m.pushName
    }

    const prev = this.store.getMessage(chatId, m.key.id)
    const resolvedPlaceholder = !!prev && isCiphertext(prev) && !!content
    const isCipher = isCiphertext(m)
    const isNew = this.store.putMessage(chatId, m)
    const chat = this.chat(chatId)
    const ts = tsOf(m)
    if (ts >= chat.ts || chat.lastMsgId === m.key.id) this.setPreview(chat, m)
    const alreadyRead = (m.status ?? 0) >= proto.WebMessageInfo.Status.READ
    if (incoming && (isNew || resolvedPlaceholder) && !m.key.fromMe && !alreadyRead) {
      const looking = this.activeChat === chatId && this.focused && !this.screenLocked
      if (!isCipher) {
        // count first so read() sees unread >= 1 even when the chat was already open (otherwise it returned early and never sent the read receipt!)
        if (isNew || (resolvedPlaceholder && !chat.unread)) chat.unread = (chat.unread || 0) + 1
        if (looking) void this.read(chatId)
        // don't pop a late desktop toast for offline catch-up ('append'), old placeholders, muted or archived chats
        const fresh = !resolvedPlaceholder || Date.now() - ts < 5 * 60_000
        if (live && !looking && fresh && !isMuted(chat) && !chat.archived && this.onIncoming) {
          this.onIncoming({
            chat,
            chatName: this.chatName(chat),
            senderName: isJidGroup(chatId) && sender ? this.name(sender, m.pushName) : undefined,
            preview: previewOf(content) || 'Nova mensagem',
            msg: m
          })
        }
        // a voice note in a chat that isn't open: the renderer transcribes it now (open chats get it via 'msgs')
        if (live && !this.loaded.has(chatId)) {
          const ui = this.uiMsg(chatId, m)
          if (ui.kind === 'audio' && ui.ptt) this.emit({ type: 'voiceIn', message: ui })
        }
      } else if (!looking && isNew) {
        chat.unread = (chat.unread || 0) + 1
      }
    }
    if (m.key.fromMe && incoming) {
      chat.unread = 0
      chat.markedUnread = false
    }
    this.queueChat(chatId)
    this.queueMsg(chatId, m)
  }

  private setPreview(chat: ChatRec, m: WAMessage) {
    chat.ts = Math.max(chat.ts, tsOf(m))
    chat.lastMsgId = m.key.id!
    const deleted = !!(m as any)._deleted || isRevokeStub(m)
    const cipher = isCiphertext(m)
    const content = contentOf(m)
    const s = m.key.participant || m.participant
    const senderLabel = isJidGroup(chat.id) && s && !m.key.fromMe ? this.name(s, m.pushName).split(' ')[0] : undefined
    if (deleted) {
      chat.preview = '🚫 Mensagem apagada'
      chat.previewFromMe = !!m.key.fromMe
      chat.previewSender = senderLabel
    } else if (cipher) {
      chat.preview = '🔒 Aguardando mensagem…'
      chat.previewFromMe = !!m.key.fromMe
      chat.previewSender = senderLabel
    } else if (content) {
      chat.preview = previewOf(content) || 'Mensagem'
      chat.previewFromMe = !!m.key.fromMe
      chat.previewSender = senderLabel
    } else {
      // system event (group renamed, participant joined/left…): never inherit the previous message's preview or sender
      const st = stubTextOf(m)
      chat.preview = st || undefined
      chat.previewFromMe = false
      chat.previewSender = undefined
    }
  }

  /** keeps the sidebar preview honest when a chat's newest message is a stub or was repaired */
  private syncPreview(chatId: string) {
    const chat = this.store.chats.get(chatId)
    if (!chat) return
    const all = this.store.sorted(chatId)
    let latest: WAMessage | undefined
    for (let i = all.length - 1; i >= 0; i--) {
      if (!isInvisible(all[i])) {
        latest = all[i]
        break
      }
    }
    const prev = { p: chat.preview, s: chat.previewSender, f: chat.previewFromMe, id: chat.lastMsgId }
    if (latest) {
      this.setPreview(chat, latest)
    } else if (!chat.preview && chat.previewSender) {
      chat.previewSender = undefined
      chat.previewFromMe = false
    }
    if (chat.preview !== prev.p || chat.previewSender !== prev.s || chat.previewFromMe !== prev.f || chat.lastMsgId !== prev.id) {
      this.queueChat(chatId)
    }
  }

  /** one-time cleanup: fixes previews corrupted by undecrypted/system stubs keeping the previous message's text */
  private repairPreviews() {
    const done = new Set(this.store.meta.migrations ?? [])
    if (done.has('preview-stub-fix-v1')) return
    const recent = [...this.store.chats.values()]
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 60)
      .map((c) => c.id)
    const broken = [...this.store.chats.values()].filter((c) => !c.preview && c.previewSender).map((c) => c.id)
    const ids = new Set([...recent, ...broken])
    for (const id of ids) {
      this.safe(() => {
        this.syncPreview(id)
        const last = this.store.sorted(id).slice(-5)
        this.retryPlaceholders(id, last)
      })
    }
    done.add('preview-stub-fix-v1')
    this.store.meta.migrations = [...done]
    this.store.markMeta()
  }

  /** asks our own phone to resend recent undecrypted (CIPHERTEXT) messages via PDO */
  private placeholderAsked = new Map<string, number>()
  private retryPlaceholders(_chatId: string, list: WAMessage[]) {
    if (this.conn !== 'open' || !this.sock) return
    const now = Date.now()
    const recent = now - 14 * 86400_000
    for (const m of list.slice(-30)) {
      if (!m.key.id || !isCiphertext(m) || tsOf(m) < recent) continue
      const last = this.placeholderAsked.get(m.key.id) ?? 0
      if (now - last < 60_000) continue
      this.placeholderAsked.set(m.key.id, now)
      const cleanKey: WAMessageKey = {
        remoteJid: m.key.remoteJid,
        fromMe: m.key.fromMe,
        id: m.key.id,
        participant: m.key.participant
      }
      this.sock
        .requestPlaceholderResend(cleanKey, {
          key: m.key,
          messageTimestamp: m.messageTimestamp,
          pushName: m.pushName,
          participant: m.participant
        })
        .catch(() => {})
    }
  }

  private applyReaction(chatId: string, msgId: string, who: string, text: string) {
    const b = this.store.bucket(chatId)
    const cur = { ...(b.reactions.get(msgId) ?? {}) }
    if (text) cur[who] = text
    else delete cur[who]
    b.reactions.set(msgId, cur)
    this.store.markChat(chatId)
    const target = b.msgs.get(msgId)
    if (target) this.queueMsg(chatId, target)
  }

  /** who already read each of your group messages (blue ticks only when everyone has, like WhatsApp) */
  private groupReaders = new Map<string, Set<string>>()
  private groupReceipt(chatId: string, msgId: string, who: string, read: boolean, delivered: boolean) {
    const target = this.store.getMessage(chatId, msgId)
    if (!target?.key.fromMe || (!read && !delivered)) return
    let status = proto.WebMessageInfo.Status.DELIVERY_ACK
    if (read) {
      const k = chatId + '/' + msgId
      const set = this.groupReaders.get(k) ?? new Set<string>()
      set.add(who)
      this.groupReaders.set(k, set)
      if (this.groupReaders.size > 2000) this.groupReaders.delete(this.groupReaders.keys().next().value!)
      const others = (this.groups.get(chatId)?.participants.length ?? 0) - 1
      if (others > 0 && set.size >= others) status = proto.WebMessageInfo.Status.READ
    }
    if ((target.status ?? 0) >= status) return
    target.status = status
    this.store.markChat(chatId)
    this.queueMsg(chatId, target)
  }

  /**
   * You read this chat on the phone (or WhatsApp Web somewhere else): the phone sends a read receipt to
   * your other devices. Everything up to the newest message it read stops counting as unread here.
   */
  private readElsewhere(chatId: string, ids: string[]) {
    const chat = this.store.chats.get(chatId)
    if (!chat || (!chat.unread && !chat.markedUnread)) return
    let upTo = 0
    for (const id of ids) {
      const m = this.store.getMessage(chatId, id)
      if (m) upTo = Math.max(upTo, tsOf(m))
    }
    // what arrived after the newest message the phone read is still unread (unknown message: all read)
    let left = 0
    if (upTo) for (const m of this.store.sorted(chatId)) if (!m.key.fromMe && tsOf(m) > upTo && !isInvisible(m)) left++
    chat.unread = Math.min(chat.unread || 0, left)
    if (!left) chat.markedUnread = false
    this.queueChat(chatId)
  }

  private markDeleted(chatId: string, msgId: string) {
    const target = this.store.getMessage(chatId, msgId)
    if (!target) return
    ;(target as any)._deleted = true
    this.store.markChat(chatId)
    const chat = this.store.chats.get(chatId)
    if (chat?.lastMsgId === msgId) {
      chat.preview = '🚫 Mensagem apagada'
      this.queueChat(chatId)
    }
    this.queueMsg(chatId, target)
  }

  /**
   * WhatsApp's new edit format (secretEncryptedMessage, MESSAGE_EDIT): AES-GCM with a key derived from the
   * edited message's messageSecret — same scheme as poll votes, label "Message Edit". Inside is the usual
   * protocolMessage edit. Returns false when the original isn't stored (yet) or nothing decrypts.
   */
  private openSecretEdit(chatId: string, m: WAMessage): boolean {
    const se = normalizeMessageContent(m.message ?? undefined)?.secretEncryptedMessage
    if (!se) return true
    if (se.secretEncType !== proto.Message.SecretEncryptedMessage.SecretEncType.MESSAGE_EDIT) return true // event edits: nothing to show
    const targetId = se.targetMessageKey?.id
    if (!targetId || !se.encPayload || !se.encIv) return true
    const target = this.store.getMessage(chatId, targetId)
    if (!target) return false
    const ctx = target.message?.messageContextInfo ?? normalizeMessageContent(target.message ?? undefined)?.messageContextInfo
    const secret = toBuf(ctx?.messageSecret)
    if (!secret?.length) return true
    const payload = toBuf(se.encPayload)!
    const iv = toBuf(se.encIv)!
    if (payload.length <= 16) return true
    // who wrote it, in every form WhatsApp might have used (LID / phone number)
    for (const sender of this.authorForms(m)) {
      try {
        const key = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(32), Buffer.concat([Buffer.from(targetId), Buffer.from(sender), Buffer.from(sender), Buffer.from('Message Edit')]), 32))
        const d = createDecipheriv('aes-256-gcm', key, iv)
        d.setAuthTag(payload.subarray(payload.length - 16))
        const plain = Buffer.concat([d.update(payload.subarray(0, payload.length - 16)), d.final()])
        const inner = proto.Message.decode(plain)
        this.applyEdit(chatId, targetId, inner)
        return true
      } catch {
        // wrong form of the sender (auth tag mismatch): try the next one
      }
    }
    return true
  }

  /** encrypted edits that arrived before their original (stored): applied when the chat is opened */
  private secretDone = new Set<string>()
  private applyStoredEdits(chatId: string) {
    for (const m of this.store.sorted(chatId)) {
      if (!m.key.id || this.secretDone.has(m.key.id)) continue
      const c = normalizeMessageContent(m.message ?? undefined)
      if (c?.secretEncryptedMessage) {
        if (this.openSecretEdit(chatId, m)) this.secretDone.add(m.key.id)
      } else if (c?.pollUpdateMessage) {
        if (this.openPollVote(chatId, m)) this.secretDone.add(m.key.id)
      }
    }
  }

  /** the forms a person's id may take inside WhatsApp's encryption labels (LID and phone number) */
  private authorForms(m: WAMessage): string[] {
    const k: any = m.key
    const who = m.key.fromMe ? [this.me?.lid, this.me?.id] : [k.participant, k.participantAlt, m.participant, k.remoteJid, k.remoteJidAlt]
    return [...new Set(who.filter((j): j is string => !!j && !isJidGroup(j)).map((j) => jidNormalizedUser(j)))]
  }

  /**
   * A poll vote (pollUpdateMessage): AES-GCM with a key from the poll's messageSecret, labelled with the poll id,
   * the poll's author and the voter. Returns false when the poll isn't stored (yet).
   */
  private openPollVote(chatId: string, m: WAMessage): boolean {
    const pu = normalizeMessageContent(m.message ?? undefined)?.pollUpdateMessage
    const pollId = pu?.pollCreationMessageKey?.id
    if (!pollId || !pu?.vote?.encPayload || !pu.vote.encIv) return true
    const poll = this.store.getMessage(chatId, pollId)
    if (!poll) return false
    const secret = toBuf((poll.message?.messageContextInfo ?? normalizeMessageContent(poll.message ?? undefined)?.messageContextInfo)?.messageSecret)
    if (!secret?.length) return true
    for (const pollCreatorJid of this.authorForms(poll))
      for (const voterJid of this.authorForms(m)) {
        try {
          const vote = decryptPollVote(pu.vote as any, { pollCreatorJid, pollMsgId: pollId, pollEncKey: secret, voterJid })
          putPollVote(poll, { pollUpdateMessageKey: m.key, vote, senderTimestampMs: pu.senderTimestampMs ?? tsOf(m) }, (j) => this.canon(j))
          this.store.markChat(chatId)
          this.queueMsg(chatId, poll)
          return true
        } catch {
          // another form of the ids: try the next pair
        }
      }
    return true
  }

  private applyEdit(chatId: string, msgId: string, edited: proto.IMessage) {
    const target = this.store.getMessage(chatId, msgId)
    if (!target) return
    const inner = unwrapEdit(edited)
    if (!inner || !getContentType(normalizeMessageContent(inner) ?? {})) return
    ;(target as any)._edit = inner
    this.store.markChat(chatId)
    const chat = this.store.chats.get(chatId)
    if (chat?.lastMsgId === msgId) {
      chat.preview = previewOf(contentOf(target)) || chat.preview
      this.queueChat(chatId)
    }
    this.queueMsg(chatId, target)
  }

  private upsertContacts(list: Partial<Contact>[]) {
    for (const c of list) {
      if (!c.id) continue
      this.mapLid((c as any).lid, (c as any).phoneNumber)
      this.mapLid(c.id, (c as any).phoneNumber)
      const id = this.canon(c.id)
      const prev = this.store.contacts.get(id) ?? { id }
      this.store.contacts.set(id, {
        ...prev,
        name: c.name ?? prev.name,
        notify: c.notify ?? prev.notify,
        verifiedName: c.verifiedName ?? prev.verifiedName
      })
      if (this.store.chats.has(id)) this.pendingChats.add(id)
    }
    this.store.markList()
    this.kick()
  }

  /**
   * history = absolute numbers from the phone's sync. Live chats.update/upsert carry unreadCount as a
   * *delta* (+1 per new message) — ingest() already counts those, so a positive live value is ignored
   * (it used to be stored as the total and then +1'd again: every new message showed as 2).
   */
  private pendingArchive = new Map<string, { archived: boolean; conditional: (data: any) => boolean | undefined }>()
  private pendingMute = new Map<string, unknown>()
  private pendingPin = new Map<string, unknown>()
  private archiveTimer?: NodeJS.Timeout
  private flushArchiveSoon() {
    if (this.archiveTimer) clearTimeout(this.archiveTimer)
    // wait for the history that lands alongside: the "new messages since archiving" check & LID maps need it
    this.archiveTimer = setTimeout(() => this.safe(() => this.flushArchive()), 6000)
  }
  private flushArchive() {
    for (const [raw, u] of this.pendingArchive) {
      const id = this.canon(raw)
      if (this.skip(id)) continue
      const rec = this.chat(id)
      let ok: boolean | undefined = true
      try {
        // Baileys' own rule ("keep archived" off → a message after archiving unarchives it), fed with our data
        ok = u.conditional({ historySets: { chats: { [raw]: { id: raw, lastMessageRecvTimestamp: Math.floor(rec.ts / 1000) } } }, chatUpserts: {} })
      } catch {}
      rec.archived = ok === false ? undefined : u.archived || undefined
      this.queueChat(id)
    }
    this.pendingArchive.clear()
    for (const [raw, muteEndTime] of this.pendingMute) {
      const id = this.canon(raw)
      if (this.skip(id)) continue
      const rec = this.chat(id)
      rec.muteUntil = parseMute(muteEndTime, true)
      this.queueChat(id)
    }
    this.pendingMute.clear()
    for (const [raw, pinned] of this.pendingPin) {
      const id = this.canon(raw)
      if (this.skip(id)) continue
      const rec = this.chat(id)
      rec.waPinned = pinned ? Number(pinned) : undefined
      this.queueChat(id)
    }
    this.pendingPin.clear()
  }

  /** one time: archive + mute lists that got dropped by Baileys' conditional buffer in the first sync are fetched again */
  private async resyncArchives(sock: WASocket) {
    const done = new Set(this.store.meta.migrations ?? [])
    const need: ('regular_low' | 'regular_high')[] = []
    if (!done.has('archive-resync-v2')) need.push('regular_low')
    if (!done.has('mute-resync-v2')) need.push('regular_high')
    if (!need.length) return
    await new Promise((r) => setTimeout(r, 8000))
    if (sock !== this.sock || this.conn !== 'open') return
    try {
      const keys = (sock as any)._authState?.keys
      // forget the saved version → WhatsApp sends the full snapshot again (archive+pins in regular_low, mutes in regular_high)
      await keys?.set({ 'app-state-sync-version': Object.fromEntries(need.map((n) => [n, null])) })
      await sock.resyncAppState(need, true)
      if (need.includes('regular_low')) done.add('archive-resync-v2')
      if (need.includes('regular_high')) done.add('mute-resync-v2')
      this.store.meta.migrations = [...done]
      this.store.markMeta()
    } catch (err) {
      logError('archive resync', err)
    }
  }

  private applyChat(c: Partial<Chat> & { id?: string | null }, history = false, fromUpdate = false) {
    if (!c.id) return
    this.mapLid(c.id, (c as any).pnJid)
    this.mapLid((c as any).lidJid, c.id)
    const id = this.canon(c.id)
    if (this.skip(id)) return
    const rec = this.chat(id)
    if (c.name) rec.name = c.name
    if (typeof c.unreadCount === 'number') {
      if (c.unreadCount < 0) rec.markedUnread = true
      else if (c.unreadCount === 0) {
        // read on the phone / another device
        rec.unread = 0
        rec.markedUnread = false
      } else if (history) rec.unread = c.unreadCount
    }
    const conditional = !!(c as any).conditional
    // History chats are decoded protobuf objects: pinned/archived/muteEndTime exist on the PROTOTYPE as null
    // even when the phone said nothing, so `'pinned' in c` used to unpin (and unmute) every chat of every
    // history batch — a new install, or just scrolling up in a chat. History may only turn things ON;
    // turning them off comes from real app-state actions (live chats.update, own properties).
    const own = (k: string) => Object.prototype.hasOwnProperty.call(c, k)
    // conditional flags from initial app-state sync are handled via pending* in flushArchive()
    if (!conditional) {
      if (history) {
        if (c.pinned) rec.waPinned = Number(c.pinned)
        if (c.archived) rec.archived = true
        if (c.muteEndTime) rec.muteUntil = parseMute(c.muteEndTime, fromUpdate)
      } else {
        if (own('pinned')) rec.waPinned = c.pinned ? Number(c.pinned) : undefined
        if (own('archived') && c.archived != null) rec.archived = !!c.archived || undefined
        if (own('muteEndTime')) rec.muteUntil = parseMute(c.muteEndTime, fromUpdate)
      }
    }
    if (c.conversationTimestamp) rec.ts = Math.max(rec.ts, Number(c.conversationTimestamp) * 1000)
    if ((c as any).markedAsUnread) rec.markedUnread = true
    this.queueChat(id)
  }

  // ---------- connection ----------

  async start() {
    this.stopped = false
    if (this.conn === 'loading') this.setConn('connecting')
    await this.connect()
  }

  private connSince = Date.now()
  private setConn(conn: ConnState, qr?: string) {
    if (conn !== this.conn) this.connSince = Date.now()
    this.conn = conn
    this.qr = qr
    this.emit({ type: 'conn', conn, qr, me: this.me })
  }

  private logger() {
    const self = this
    const noop = () => {}
    const make = (): any => ({
      level: 'info',
      child: () => make(),
      trace: noop,
      info: noop,
      debug(obj: any, msg?: string) {
        if (msg === 'unprocessable update') self.onSyncAction(obj)
      },
      warn: noop,
      error(obj: any, msg?: string) {
        if (process.env.ZAP_DEBUG) console.error('[wa]', msg ?? '', obj?.err?.message ?? obj?.message ?? '')
      },
      fatal(obj: any, msg?: string) {
        console.error('[wa:fatal]', msg ?? '', obj?.err?.message ?? '')
      }
    })
    return make()
  }

  private async connect() {
    if (this.stopped) return
    try {
      await this.connectInner()
    } catch (err) {
      // auth folder locked, network down, DNS… → never give up, retry with backoff
      logError("connect", err)
      this.setConn("reconnecting")
      const delay = Math.min(30_000, 2000 * 2 ** Math.min(this.retry, 4))
      this.retry++
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
      this.reconnectTimer = setTimeout(() => void this.connect(), delay)
    }
  }

  private async connectInner() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    const disk = await useAtomicAuthState(this.authDir)
    // keys in memory too: decrypting a day of messages read the same session files from disk thousands of
    // times (catching up after the PC was off took minutes). Writes still go straight to disk. One cache for
    // the whole run (reconnects reuse it); forgotten when the login is reset.
    this.keyCache ??= makeCacheableSignalKeyStore(disk.state.keys)
    const state = { creds: disk.state.creds, keys: this.keyCache }
    const saveCreds = disk.saveCreds
    // WhatsApp now rejects "Desktop" companions (428) and stale protocol versions, so: Chrome + freshest version
    // reconnects reuse the version we already know: no network round-trip before reconnecting
    const latest = this.retry > 0 && this.store.meta.waVersion ? undefined : await fetchLatestBaileysVersion().catch(() => undefined)
    if (latest?.isLatest && latest.version) {
      this.store.meta.waVersion = latest.version
      this.store.markMeta()
    }
    const sock = makeWASocket({
      auth: state,
      version: latest?.isLatest ? latest.version : (this.store.meta.waVersion ?? latest?.version),
      logger: this.logger(),
      browser: Browsers.windows('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: true,
      generateHighQualityLinkPreview: false,
      shouldIgnoreJid: (jid) => isJidBroadcast(jid) || isJidNewsletter(jid),
      getMessage: async (key) => {
        const found = key.remoteJid ? this.store.getMessage(this.canon(key.remoteJid), key.id!) : undefined
        return (found ?? (key.id ? this.store.findMessage(key.id)?.msg : undefined))?.message ?? undefined
      },
      cachedGroupMetadata: async (jid) => this.groups.get(jid)
    })
    this.sock = sock
    ;(sock as any)._authState = state
    // WhatsApp's own clock at login: a PC whose clock is off stamped what you sent in the past/future and it
    // landed above the messages you were answering (received ones carry the server's time)
    ;(sock.ws as any).on?.('CB:success', (node: any) => this.setServerTime(Number(node?.attrs?.t)))
    // after hours/days off, WhatsApp first says how much is waiting, then delivers it one by one (slow):
    // show "Recebendo mensagens… 340 de 1200" instead of a frozen-looking list
    ;(sock.ws as any).on?.('CB:ib,,offline_preview', (node: any) => sock === this.sock && this.safe(() => this.startCatchup(node)))
    ;(sock.ws as any).on?.('CB:ib,,offline', () => sock === this.sock && this.safe(() => this.catchupDelivered()))
    // Archive/mute/pin flags of the first app-state sync (and resyncs) come as "conditional" chat updates that
    // Baileys keeps buffered forever when the chat isn't in the same history batch. Catch them at the source.
    const rawEmit = sock.ev.emit.bind(sock.ev)
    ;(sock.ev as any).emit = (event: string, data: any) => {
      if (event === 'chats.update' && Array.isArray(data)) {
        for (const u of data) {
          if (!u?.id || typeof u.conditional !== 'function') continue
          if (typeof u.archived === 'boolean') {
            this.pendingArchive.set(u.id, { archived: u.archived, conditional: u.conditional })
            this.flushArchiveSoon()
          }
          if ('muteEndTime' in u) {
            if (!String(u.id).endsWith('@lid')) {
              const id = this.canon(u.id)
              if (!this.skip(id)) {
                this.chat(id).muteUntil = parseMute(u.muteEndTime, true)
                this.queueChat(id)
              }
            } else {
              this.pendingMute.set(u.id, u.muteEndTime ?? null)
              this.flushArchiveSoon()
            }
          }
          if ('pinned' in u) {
            this.pendingPin.set(u.id, u.pinned ?? null)
            this.flushArchiveSoon()
          }
        }
      }
      return rawEmit(event as any, data)
    }

    sock.ev.on('creds.update', saveCreds)
    sock.ev.process(async (events) => {
      if (sock !== this.sock) return
      try {
        await this.handleEvents(events, sock)
      } catch (err) {
        logError("events", err)
      }
    })
  }

  /** one bad message must never stop the rest of the batch */
  private safe(fn: () => void) {
    try {
      fn()
    } catch (err) {
      logError("ingest", err)
    }
  }

  private async handleEvents(events: Partial<import("baileys").BaileysEventMap>, sock: WASocket) {
    {
      const cu = events['connection.update']
      if (cu) await this.onConnection(cu, sock)

      const hist = events['messaging-history.set']
      if (hist) {
        for (const m of hist.lidPnMappings ?? []) this.mapLid(m.lid, m.pn)
        this.upsertContacts(hist.contacts)
        for (const c of hist.chats) this.applyChat(c, true)
        for (const m of hist.messages) this.safe(() => this.ingest(m, false))
        this.emit({ type: 'sync', progress: hist.progress ?? null, done: !!hist.isLatest || hist.progress === 100 })
      }
      if (events['messaging-history.status']?.status === 'complete') this.emit({ type: 'sync', progress: 100, done: true })
      if (events['lid-mapping.update']) this.mapLid(events['lid-mapping.update'].lid, events['lid-mapping.update'].pn)
      if (events['contacts.upsert']) this.upsertContacts(events['contacts.upsert'])
      if (events['contacts.update']) this.upsertContacts(events['contacts.update'])
      if (events['chats.upsert']) for (const c of events['chats.upsert']) this.applyChat(c)
      if (events['chats.update']) for (const c of events['chats.update']) this.applyChat(c as any, false, true)
      if (events['chats.delete']) {
        const ids = events['chats.delete'].map((j) => this.canon(j))
        for (const id of ids) this.store.removeChat(id)
        this.store.markList()
        this.emit({ type: 'chatsRemoved', ids })
      }
      const up = events['messages.upsert']
      if (up) for (const m of up.messages) this.safe(() => this.ingest(m, up.type === 'notify' ? 'notify' : 'append'))
      if (up && up.type !== 'notify' && this.catchup) this.catchupGot(up.messages.length)
      const readByChat = new Map<string, string[]>()
      const readHere = (chatId: string, id: string) => readByChat.set(chatId, [...(readByChat.get(chatId) ?? []), id])
      if (events['messages.update']) {
        for (const { key, update } of events['messages.update']) {
          if (!key.id || !key.remoteJid) continue
          const chatId = this.chatIdOf(key)
          const target = this.store.getMessage(chatId, key.id)
          if (target && update.pollUpdates?.length) {
            for (const u of update.pollUpdates) putPollVote(target, u, (j) => this.canon(j))
            this.store.markChat(chatId)
            this.queueMsg(chatId, target)
          }
          if (update.message?.editedMessage) this.applyEdit(chatId, key.id, update.message.editedMessage as any)
          else if (target && isCiphertext(target) && update.message) {
            this.safe(() => this.ingest({ ...target, ...update, message: update.message } as WAMessage, true))
            continue
          }
          if (
            update.messageStubType === proto.WebMessageInfo.StubType.REVOKE ||
            update.messageStubType === proto.WebMessageInfo.StubType.ADMIN_REVOKE ||
            (update.message === null && update.messageStubType && update.messageStubType !== proto.WebMessageInfo.StubType.CIPHERTEXT)
          ) {
            this.markDeleted(chatId, key.id)
            continue
          }
          if (target && typeof update.status === 'number' && update.status > (target.status ?? 0)) {
            target.status = update.status
            this.store.markChat(chatId)
            this.queueMsg(chatId, target)
          }
          // "read" on a message *to* you = another device of yours (the phone) read it
          if (!key.fromMe && typeof update.status === 'number' && update.status >= proto.WebMessageInfo.Status.READ) readHere(chatId, key.id)
        }
      }
      // groups: receipts come one per person (WhatsApp doesn't send a combined status for group messages)
      if (events['message-receipt.update']) {
        for (const { key, receipt } of events['message-receipt.update']) {
          if (!key.id || !key.remoteJid || !receipt.userJid) continue
          const chatId = this.chatIdOf(key)
          const who = this.canon(receipt.userJid)
          // the phone read it → read here too
          if (this.isMe(who)) {
            if (receipt.readTimestamp) readHere(chatId, key.id)
            continue
          }
          this.groupReceipt(chatId, key.id, who, !!(receipt.readTimestamp || (receipt as any).playedTimestamp), !!receipt.receiptTimestamp)
        }
      }
      for (const [chatId, ids] of readByChat) this.readElsewhere(chatId, ids)
      if (events['messages.reaction']) {
        for (const { key, reaction } of events['messages.reaction']) {
          if (!key.id || !key.remoteJid) continue
          const chatId = this.chatIdOf(key)
          const rk = reaction.key
          const who = rk?.fromMe ? 'me' : this.canon(rk?.participant || rk?.remoteJid)
          this.applyReaction(chatId, key.id, who, reaction.text ?? '')
        }
      }
      if (events['messages.delete']) {
        const d = events['messages.delete']
        if ('keys' in d) {
          const byChat = new Map<string, string[]>()
          for (const k of d.keys) {
            if (!k.remoteJid || !k.id) continue
            const chatId = this.chatIdOf(k)
            this.store.bucket(chatId).msgs.delete(k.id)
            this.store.bucket(chatId).sorted = undefined
            this.store.markChat(chatId)
            byChat.set(chatId, [...(byChat.get(chatId) ?? []), k.id])
          }
          for (const [chatId, ids] of byChat) this.emit({ type: 'msgsRemoved', chatId, ids })
        }
      }
      if (events['presence.update']) {
        const { id, presences } = events['presence.update']
        const chatId = this.canon(id)
        for (const [who, p] of Object.entries(presences)) {
          const on = p.lastKnownPresence === 'composing' || p.lastKnownPresence === 'recording'
          this.emit({ type: 'typing', chatId, who: isJidGroup(chatId) ? this.name(who).split(' ')[0] : undefined, on })
        }
      }
      for (const g of [...(events['groups.upsert'] ?? []), ...(events['groups.update'] ?? [])]) {
        if (!g.id) continue
        const prev = this.groups.get(g.id)
        this.groups.set(g.id, { ...(prev as any), ...g })
        if (g.subject) {
          this.chat(g.id).name = g.subject
          this.queueChat(g.id)
        }
      }
      if (events['blocklist.set']) this.setBlocked(events['blocklist.set'].blocklist, 'set')
      if (events['blocklist.update']) this.setBlocked(events['blocklist.update'].blocklist, events['blocklist.update'].type)
      if (events.call) {
        for (const c of events.call) if (c.status === 'offer' && !c.isGroup) this.onCall?.(this.name(c.from))
      }
    }
  }

  // ---------- catching up after being offline ----------

  private catchup?: { total: number; got: number; delivered: boolean; last: number; shown: number; timer?: NodeJS.Timeout }

  private startCatchup(node: any) {
    const child = Array.isArray(node?.content) ? node.content.find((c: any) => c?.tag === 'offline_preview') : undefined
    const a = child?.attrs ?? node?.attrs ?? {}
    const total = Number(a.message) || 0
    this.endCatchup()
    // a handful of messages arrives in a blink: no bar for that
    if (total < 40) return
    this.catchup = { total, got: 0, delivered: false, last: Date.now(), shown: 0 }
    this.catchupTick()
  }

  private catchupGot(n: number) {
    const c = this.catchup!
    c.got += n
    c.last = Date.now()
    if (Date.now() - c.shown > 300) this.catchupTick()
  }

  /** WhatsApp sent everything (Baileys may still be decrypting the tail) */
  private catchupDelivered() {
    if (this.catchup) this.catchup.delivered = true
  }

  private catchupTick() {
    const c = this.catchup
    if (!c) return
    if (c.timer) clearTimeout(c.timer)
    const idle = Date.now() - c.last
    // finished: all counted, or delivered and quiet for a bit, or nothing at all for a long while
    if (c.got >= c.total || (c.delivered && idle > 4000) || idle > 30_000) return this.endCatchup()
    c.shown = Date.now()
    const got = Math.min(c.got, c.total)
    this.emit({
      type: 'sync',
      progress: Math.max(3, Math.min(99, (got / c.total) * 100)),
      done: false,
      label: `Recebendo mensagens · ${got.toLocaleString('pt-BR')} de ${c.total.toLocaleString('pt-BR')}`
    })
    c.timer = setTimeout(() => this.catchupTick(), 1000)
  }

  private stopCatchupTimer() {
    if (this.catchup?.timer) clearTimeout(this.catchup.timer)
    this.catchup = undefined
  }

  private endCatchup() {
    const c = this.catchup
    if (!c) return
    if (c.timer) clearTimeout(c.timer)
    this.catchup = undefined
    this.emit({ type: 'sync', progress: 100, done: true })
  }

  /** a connection stuck in "connecting" (half-open socket, sleep/wake, VPN switch) gets kicked */
  private watchdog() {
    if (this.stopped) return
    const stuck = (this.conn === 'connecting' || this.conn === 'reconnecting') && Date.now() - this.connSince > 90_000
    if (!stuck) return
    logError('watchdog', new Error('connection stuck for 90s, restarting socket'))
    this.connSince = Date.now()
    try {
      this.sock?.end(undefined)
    } catch {}
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    void this.connect()
  }

  /** account removed: stop everything, keep files untouched until the caller deletes them */
  async destroy(logout: boolean) {
    this.stopped = true
    this.stopCatchupTimer()
    if (this.timer) clearInterval(this.timer)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    for (const t of this.markReadTimers.values()) clearTimeout(t)
    this.markReadTimers.clear()
    if (logout) await this.sock?.logout().catch(() => {})
    try {
      this.sock?.end(undefined)
    } catch {}
    this.sock = undefined
    this.store.dispose()
  }

  private async onConnection(cu: Partial<import('baileys').ConnectionState>, sock: WASocket) {
    if (cu.qr) {
      const qr = await QRCode.toDataURL(cu.qr, { margin: 1, width: 280, color: { dark: '#0b0b0b', light: '#ffffff' } })
      this.setConn('qr', qr)
    }
    if (cu.connection === 'open') {
      this.retry = 0
      const u = sock.user
      this.me = u ? { id: jidNormalizedUser(u.id), lid: u.lid ? jidNormalizedUser(u.lid) : undefined, name: u.name ?? u.notify ?? undefined } : undefined
      if (this.me?.lid) this.mapLid(this.me.lid, this.me.id)
      this.fixSelfChat()
      this.setConn('open')
      this.repairPreviews()
      this.flushPendingReads()
      void this.resyncArchives(sock)
      void this.setOnline(this.focused)
      sock
        .groupFetchAllParticipating()
        .then((all) => {
          for (const g of Object.values(all)) {
            this.groups.set(g.id, g)
            for (const p of g.participants ?? []) {
              this.mapLid(p.id, (p as any).phoneNumber)
              this.mapLid((p as any).lid, p.id)
            }
            if (g.subject) {
              this.chat(g.id).name = g.subject
              this.queueChat(g.id)
            }
          }
        })
        .catch(() => {})
      void this.retryStickerDownloads()
      sock
        .fetchBlocklist()
        .then((list) => this.setBlocked(list.filter(Boolean) as string[], 'set'))
        .catch(() => {})
    }
    if (cu.connection === 'close') {
      this.endCatchup()
      const code = (cu.lastDisconnect?.error as any)?.output?.statusCode
      if (process.env.ZAP_DEBUG) console.error('[wa] closed', code, cu.lastDisconnect?.error?.message)
      if (this.stopped) return
      if (code === DisconnectReason.loggedOut) {
        await this.resetSession()
        return
      }
      this.setConn('reconnecting')
      const delay = code === DisconnectReason.restartRequired ? 0 : Math.min(30_000, [800, 2000, 4000, 8000, 15000][this.retry] ?? 30_000)
      this.retry++
      this.reconnectTimer = setTimeout(() => void this.connect(), delay)
    }
  }

  /** used after power resume / network change */
  nudge() {
    if (this.conn === 'reconnecting' && this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      void this.connect()
    }
  }

  private async resetSession() {
    try {
      this.sock?.end(undefined)
    } catch {}
    this.sock = undefined
    this.me = undefined
    this.keyCache = undefined
    fs.rmSync(this.authDir, { recursive: true, force: true })
    this.store.wipe()
    this.loaded.clear()
    this.emit({ type: 'chatsRemoved', ids: ['*'] })
    this.emit({ type: 'stickers', stickers: [] })
    this.setConn('connecting')
    await this.connect()
  }

  async logout() {
    this.stopped = true
    try {
      await this.sock?.logout()
    } catch {}
    this.stopped = false
    await this.resetSession()
  }

  async pairingCode(phone: string) {
    if (!this.sock) throw new Error('Sem conexão')
    return this.sock.requestPairingCode(phone.replace(/\D/g, ''))
  }

  async setOnline(on: boolean) {
    if (this.conn !== 'open') return
    // modo fantasma: never announce "online"
    const available = on && !this.ghost.hideOnline
    await this.sock?.sendPresenceUpdate(available ? 'available' : 'unavailable').catch(() => {})
  }

  shutdown() {
    this.stopped = true
    this.stopCatchupTimer()
    for (const t of this.markReadTimers.values()) clearTimeout(t)
    this.markReadTimers.clear()
    this.store.flush()
    try {
      this.sock?.end(undefined)
    } catch {}
  }

  // ---------- renderer API ----------

  setActive(chatId: string | null) {
    this.activeChat = chatId
    this.store.setKeep([...this.loaded].slice(-8))
    if (chatId && this.conn === 'open' && !isJidGroup(chatId)) void this.sock?.presenceSubscribe(chatId).catch(() => {})
  }

  /** hover preview: the last few messages, without opening the chat (no read receipt, no history fetch, no keep-in-memory) */
  peek(chatId: string, n = 8) {
    const fav = this.favIds()
    const all = this.store.sorted(chatId)
    const out: WAMessage[] = []
    for (let i = all.length - 1; i >= 0 && out.length < n; i--) {
      const m = all[i]
      if (!isInvisible(m) || (m as any)._deleted) out.push(m)
    }
    return out.reverse().map((m) => this.uiMsg(chatId, m, fav))
  }

  getMessages(chatId: string, beforeTs?: number) {
    this.loaded.add(chatId)
    if (!beforeTs) {
      this.safe(() => this.applyStoredEdits(chatId))
      this.safe(() => this.syncPreview(chatId))
    }
    const fav = this.favIds()
    const all = this.store.sorted(chatId).filter((m) => !isInvisible(m) || (m as any)._deleted)
    if (!beforeTs) this.safe(() => this.retryPlaceholders(chatId, all))
    let end = all.length
    if (beforeTs) {
      end = all.findIndex((m) => tsOf(m) >= beforeTs)
      if (end < 0) end = all.length
    }
    const start = Math.max(0, end - PAGE)
    const page = all.slice(start, end)
    let hasMore = start > 0
    if (!hasMore && this.conn === 'open' && all.length) {
      const last = this.historyAsked.get(chatId) ?? 0
      if (Date.now() - last > 8000) {
        this.historyAsked.set(chatId, Date.now())
        const oldest = all[0]
        this.sock?.fetchMessageHistory(50, oldest.key, tsOf(oldest)).catch(() => {})
        hasMore = true
      }
    }
    return { messages: page.map((m) => this.uiMsg(chatId, m, fav)), hasMore }
  }

  /** photos, videos, documents and links stored for this chat, newest first */
  getShared(chatId: string): SharedItems {
    const all = this.store.sorted(chatId)
    const fav = this.favIds()
    const media: UiMessage[] = []
    const docs: UiMessage[] = []
    const links: SharedLink[] = []
    for (let i = all.length - 1; i >= 0; i--) {
      const m = all[i]
      if (!m.key?.id || (m as any)._deleted || isRevokeStub(m) || isCiphertext(m) || isInvisible(m)) continue
      const c = contentOf(m)
      if (!c) continue
      const type = getContentType(c)
      const isMedia = type === 'imageMessage' || type === 'videoMessage' || type === 'ptvMessage'
      const isDoc = type === 'documentMessage'
      const rawText =
        type === 'conversation'
          ? c.conversation
          : type === 'extendedTextMessage'
            ? c.extendedTextMessage?.text
            : type === 'imageMessage'
              ? c.imageMessage?.caption
              : type === 'videoMessage'
                ? c.videoMessage?.caption
                : type === 'documentMessage'
                  ? c.documentMessage?.caption
                  : undefined
      const embeddedUrl = type === 'extendedTextMessage' ? ((c.extendedTextMessage as any)?.canonicalUrl || c.extendedTextMessage?.matchedText) : undefined
      const urls = extractUrls(rawText ?? undefined)
      if (embeddedUrl) {
        const norm = /^https?:\/\//i.test(embeddedUrl) ? embeddedUrl : 'https://' + embeddedUrl
        if (!urls.includes(norm)) urls.unshift(norm)
      }
      if (!isMedia && !isDoc && !urls.length) continue
      const ui = this.uiMsg(chatId, m, fav)
      if (isMedia && media.length < 600) media.push(ui)
      if (isDoc && docs.length < 400) docs.push(ui)
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

  private requireOpen() {
    if (!this.sock || this.conn !== 'open') throw new Error('Sem conexão com o WhatsApp agora')
    return this.sock
  }

  /** server time − this PC's clock (ms) */
  private clockOffset = 0
  private clockWarned = false
  private setServerTime(t: number) {
    if (!Number.isFinite(t) || t <= 0) return
    this.clockOffset = t * 1000 - Date.now()
    const min = Math.round(this.clockOffset / 60_000)
    if (Math.abs(this.clockOffset) > 2 * 60_000) {
      logError('clock', new Error(`PC clock is off by ${-min} min (server ${new Date(t * 1000).toISOString()})`))
      if (!this.clockWarned) {
        this.clockWarned = true
        const how = Math.abs(min) >= 120 ? Math.round(Math.abs(min) / 60) + ' h' : Math.abs(min) + ' min'
        this.emit({
          type: 'toast',
          text: `O relógio deste PC está ${how} ${min > 0 ? 'atrasado' : 'adiantado'}. O Zapdesk corrige a hora das suas mensagens, mas acerte em Configurações do Windows → Hora → Sincronizar agora.`
        })
      }
    }
  }

  /** when a message you send is stamped: WhatsApp's time, never before the last message in the chat */
  private sendStamp(chatId: string) {
    let at = Date.now() + this.clockOffset
    const last = this.store.chats.get(chatId)?.ts ?? 0
    if (last && last >= at && last - at < 6 * 3600_000) at = last + 1000
    return new Date(at)
  }

  private async sendContent(chatId: string, content: AnyMessageContent, quotedId?: string) {
    const sock = this.requireOpen()
    const quoted = quotedId ? this.store.getMessage(chatId, quotedId) : undefined
    const target = await this.resolveTarget(chatId)
    const sent = await sock.sendMessage(target, content, { ...(quoted ? { quoted } : {}), timestamp: this.sendStamp(chatId) } as any)
    if (sent) this.ingest(markSent(sent), true)
  }

  /** a message stuck with the clock: send it again (to the right account) and drop the stuck copy */
  async resend(chatId: string, msgId: string) {
    const m = this.store.getMessage(chatId, msgId)
    if (!m?.key.fromMe) return
    const c = contentOf(m)
    const text = c?.conversation ?? c?.extendedTextMessage?.text
    const sock = this.requireOpen()
    const target = await this.resolveTarget(chatId)
    const stamp = { timestamp: this.sendStamp(chatId) } as any
    const sent = text ? await sock.sendMessage(target, { text }, stamp) : await sock.sendMessage(target, { forward: m } as AnyMessageContent, stamp)
    if (sent) this.ingest(markSent(sent), true)
    const b = this.store.bucket(chatId)
    b.msgs.delete(msgId)
    b.sorted = undefined
    this.store.markChat(chatId)
    this.emit({ type: 'msgsRemoved', chatId, ids: [msgId] })
  }

  async send(chatId: string, text: string, quotedId?: string, opts?: { noPreview?: boolean }) {
    const content: any = { text }
    const m = firstUrl(text)
    if (m && this.store.meta.settings.linkPreviews && !opts?.noPreview) {
      // like the official app: attach title/description/thumbnail so the other side sees a card
      // (usually already cached because the composer prefetches while you type; never wait long)
      const meta = await Promise.race([getLinkMeta(m.url), new Promise<null>((r) => setTimeout(() => r(null), 2500))])
      if (meta?.title) {
        content.linkPreview = {
          'canonical-url': m.url,
          'matched-text': m.matched,
          title: meta.title,
          description: meta.description,
          jpegThumbnail: meta.jpeg ? Buffer.from(meta.jpeg, 'base64') : undefined
        }
      }
    }
    await this.sendContent(chatId, content, quotedId)
  }

  /**
   * Files on disk are streamed straight from the path (no 2 GB buffer in memory).
   * WhatsApp's own limits: 2 GB per file. Very large photos/videos go as documents so they arrive untouched.
   */
  async sendFiles(chatId: string, files: { name: string; mime: string; path?: string; data?: Buffer }[], caption?: string) {
    this.requireOpen()
    for (const f of files) {
      const size = f.path ? fs.statSync(f.path).size : (f.data?.length ?? 0)
      if (size > MAX_FILE) throw new Error(`"${f.name}" tem ${(size / 1024 ** 3).toFixed(1)} GB — o WhatsApp aceita até 2 GB por arquivo`)
      if (!size) throw new Error(`"${f.name}" está vazio`)
    }
    for (const [i, f] of files.entries()) {
      const cap = i === 0 ? caption || undefined : undefined
      const size = f.path ? fs.statSync(f.path).size : f.data!.length
      const src: any = f.path ? { url: f.path } : f.data!
      const mime = f.mime || 'application/octet-stream'
      let content: AnyMessageContent
      if (mime.startsWith('image/') && !mime.includes('gif') && !mime.includes('svg') && size <= MAX_IMAGE) {
        const img = f.path ? nativeImage.createFromPath(f.path) : nativeImage.createFromBuffer(f.data!)
        const dim = img.getSize()
        const thumb = img.isEmpty() ? undefined : img.resize({ width: 48, quality: 'good' }).toJPEG(60).toString('base64')
        content = { image: src, caption: cap, mimetype: mime, jpegThumbnail: thumb, width: dim.width || undefined, height: dim.height || undefined } as any
      } else if (mime.startsWith('video/') && size <= MAX_VIDEO) {
        content = { video: src, caption: cap, mimetype: mime }
      } else if (mime.startsWith('audio/') && size <= MAX_VIDEO) {
        content = { audio: src, mimetype: mime }
      } else {
        content = { document: src, mimetype: mime, fileName: f.name, caption: cap }
      }
      await this.sendContent(chatId, content)
    }
  }

  // ---------- agendadas & lembretes ----------

  onReminder?: (r: Reminder, chatName: string) => void
  onScheduledSent?: (s: ScheduledMsg, chatName: string) => void
  private timer?: NodeJS.Timeout

  startTimers() {
    this.timer = setInterval(() => {
      void this.tickTimers().catch((err) => logError("timers", err))
      this.watchdog()
    }, 10_000)
  }

  emitScheduled() {
    this.emit({ type: 'scheduled', scheduled: this.store.meta.scheduled, reminders: this.store.meta.reminders })
  }

  private sendingScheduled = new Set<string>()
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
    const m = this.store.getMessage(chatId, msgId)
    const text = m ? previewOf(contentOf(m)) || 'Mensagem' : 'Mensagem'
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

  /** plain-text transcript of everything stored for a chat */
  exportText(chatId: string): string {
    const chat = this.chat(chatId)
    const fmt = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
    const lines = [`Conversa: ${this.chatName(chat)}`, `Exportada pelo Zapdesk em ${fmt.format(Date.now())}`, '']
    for (const m of this.store.sorted(chatId)) {
      if (isInvisible(m) && !(m as any)._deleted) continue
      const ui = this.uiMsg(chatId, m)
      const who = ui.fromMe ? 'Você' : ui.senderName || this.chatName(chat)
      let body = ui.text ?? ''
      if (ui.kind === 'image') body = '[foto] ' + body
      else if (ui.kind === 'video') body = '[vídeo] ' + body
      else if (ui.kind === 'audio') body = ui.ptt ? '[mensagem de voz]' : '[áudio]'
      else if (ui.kind === 'sticker') body = '[figurinha]'
      else if (ui.kind === 'document') body = `[arquivo: ${ui.fileName}] ` + body
      if (ui.quoted) body = `(respondendo "${ui.quoted.text.slice(0, 60)}") ` + body
      if (ui.revoked) body += ' [apagada]'
      if (ui.edited) body += ' [editada]'
      const reacts = ui.reactions?.map((r) => r.e + (r.by.length > 1 ? r.by.length : '')).join(' ')
      lines.push(`[${fmt.format(ui.ts)}] ${who}: ${body.trim()}${reacts ? '  ' + reacts : ''}`)
    }
    return lines.join('\r\n')
  }

  async sendSticker(chatId: string, stickerId: string) {
    const file = this.stickerPath(stickerId)
    if (!fs.existsSync(file)) throw new Error('Figurinha ainda não baixou')
    const rec = this.store.meta.stickers.find((s) => s.id === stickerId)
    if (rec) {
      rec.ts = Date.now()
      this.store.markMeta()
    }
    await this.sendContent(chatId, { sticker: fs.readFileSync(file) } as AnyMessageContent)
  }

  /** contact card: the hidden id (LID) becomes the real number when WhatsApp knows it */
  async person(raw: string, pushName?: string): Promise<PersonInfo> {
    let id = this.canon(raw)
    if (id.endsWith('@lid') && this.sock) {
      const pn = await (this.sock as any).signalRepository?.lidMapping?.getPNForLID?.(id).catch(() => null)
      if (pn) {
        this.mapLid(id, pn)
        id = this.canon(id)
      }
    }
    const c = this.store.contacts.get(id) ?? this.store.contacts.get(raw)
    const digits = id.endsWith('@s.whatsapp.net') ? id.split('@')[0].split(':')[0] : c?.phoneNumber?.replace(/\D/g, '')
    return {
      id,
      name: this.name(id, pushName),
      savedName: c?.name || c?.verifiedName || undefined,
      pushName: c?.notify || pushName || undefined,
      phone: digits ? formatPhone(digits + '@s.whatsapp.net') : undefined,
      phoneRaw: digits ? '+' + digits : undefined
    }
  }

  /** changes the text of a message you sent (WhatsApp allows 15 minutes) */
  async editMessage(chatId: string, msgId: string, text: string) {
    const sock = this.requireOpen()
    const target = this.store.getMessage(chatId, msgId)
    const t = text.trim()
    if (!target?.key.fromMe || !t) return
    if (Date.now() - tsOf(target) > EDIT_WINDOW) throw new Error('Só dá pra editar até 15 minutos depois de enviar')
    await sock.sendMessage(target.key.remoteJid!, { text: t, edit: target.key })
    this.applyEdit(chatId, msgId, { conversation: t })
  }

  async sendPoll(chatId: string, name: string, options: string[], multi: boolean) {
    const values = [...new Set(options.map((o) => o.trim()).filter(Boolean))].slice(0, 12)
    if (!name.trim() || values.length < 2) throw new Error('A enquete precisa de uma pergunta e 2 opções')
    await this.sendContent(chatId, { poll: { name: name.trim(), values, selectableCount: multi ? 0 : 1 } } as AnyMessageContent)
  }

  /**
   * Your vote: the option names' SHA-256, encrypted the way openPollVote reads it, sent as a pollUpdateMessage.
   * Shows right away here; [] takes the vote back.
   */
  async votePoll(chatId: string, msgId: string, picked: number[]) {
    const sock = this.requireOpen()
    const poll = this.store.getMessage(chatId, msgId)
    const pc = pollCreationOf(normalizeMessageContent(poll?.message ?? undefined))
    if (!poll || !pc) return
    const secret = toBuf((poll.message?.messageContextInfo ?? normalizeMessageContent(poll.message ?? undefined)?.messageContextInfo)?.messageSecret)
    if (!secret?.length) throw new Error('Essa enquete não aceita voto por aqui — vote no celular')
    const names = (pc.options ?? []).map((o) => o.optionName || '')
    const selectedOptions = [...new Set(picked)].filter((i) => i >= 0 && i < names.length).map((i) => pollOptionHash(names[i]))
    // ids in the form this chat uses (groups and contacts moved to LIDs; older ones still use the number)
    const k: any = poll.key
    const lid = isJidGroup(chatId) ? this.groups.get(chatId)?.addressingMode === 'lid' || !!k.participant?.endsWith('@lid') : chatId.endsWith('@lid') || !!k.remoteJid?.endsWith('@lid')
    const meJid = jidNormalizedUser((lid && this.me?.lid) || this.me!.id)
    const creator = poll.key.fromMe ? meJid : jidNormalizedUser(k.participant || poll.participant || k.remoteJid)
    const vote = encryptPollVote({ selectedOptions }, { pollCreatorJid: creator, pollMsgId: msgId, pollEncKey: secret, voterJid: meJid })
    const at = Date.now()
    const msg = generateWAMessageFromContent(
      poll.key.remoteJid!,
      {
        pollUpdateMessage: {
          pollCreationMessageKey: { remoteJid: poll.key.remoteJid, fromMe: poll.key.fromMe, id: msgId, participant: poll.key.participant },
          vote,
          senderTimestampMs: at
        }
      },
      { userJid: sock.user!.id }
    )
    await sock.relayMessage(poll.key.remoteJid!, msg.message!, { messageId: msg.key.id! })
    putPollVote(poll, { pollUpdateMessageKey: { remoteJid: poll.key.remoteJid, fromMe: true, id: msg.key.id }, vote: { selectedOptions }, senderTimestampMs: at })
    this.store.markChat(chatId)
    this.queueMsg(chatId, poll)
  }

  async react(chatId: string, msgId: string, emoji: string) {
    const sock = this.requireOpen()
    const target = this.store.getMessage(chatId, msgId)
    if (!target) return
    const mine = this.store.bucket(chatId).reactions.get(msgId)?.me
    const text = mine === emoji ? '' : emoji
    this.applyReaction(chatId, msgId, 'me', text)
    await sock.sendMessage(chatId, { react: { text, key: target.key } })
  }

  /** pending read receipts held back by modo fantasma, sent on "Enviar visto agora" */
  private heldReads = new Map<string, number>()
  /** chats read while offline/reconnecting (or whose receipt failed): retried as soon as the socket opens */
  private pendingReads = new Map<string, number>()
  private markReadTimers = new Map<string, NodeJS.Timeout>()

  private flushPendingReads() {
    if (!this.pendingReads.size || this.ghost.noReadReceipts) return
    setTimeout(() => {
      if (this.conn !== 'open' || this.ghost.noReadReceipts) return
      for (const chatId of [...this.pendingReads.keys()]) void this.read(chatId)
    }, 1500)
  }

  /** syncs the chat's read state to the phone (clears the unread badge on mobile, debounced per chat) */
  private scheduleMarkRead(chatId: string, immediate = false) {
    const prev = this.markReadTimers.get(chatId)
    if (prev) clearTimeout(prev)
    const run = () => {
      this.markReadTimers.delete(chatId)
      if (!this.sock || this.conn !== 'open') return
      const last = this.lastMsg(chatId)
      if (!last) return
      void this.sock.chatModify({ markRead: true, lastMessages: [last] }, chatId).catch((err) => logError('markRead', err))
    }
    if (immediate) run()
    else this.markReadTimers.set(chatId, setTimeout(run, 1200))
  }

  async read(chatId: string, force = false) {
    const chat = this.store.chats.get(chatId)
    if (!chat) return
    const pending = this.pendingReads.get(chatId) ?? 0
    const unread = chat.unread + pending + (force ? (this.heldReads.get(chatId) ?? 0) : 0)
    const wasMarked = chat.markedUnread
    if (!unread && !wasMarked && !force) return
    chat.unread = 0
    chat.markedUnread = false
    this.queueChat(chatId)
    if (this.ghost.noReadReceipts && !force) {
      // read locally only: the sender keeps seeing grey ticks
      this.heldReads.set(chatId, (this.heldReads.get(chatId) ?? 0) + unread)
      return
    }
    this.heldReads.delete(chatId)
    if (!this.sock || this.conn !== 'open') {
      this.pendingReads.set(chatId, Math.max(pending, unread || 1))
      return
    }
    this.pendingReads.delete(chatId)
    const incoming = this.store
      .sorted(chatId)
      .filter((m) => !m.key.fromMe && !isInvisible(m) && !isCiphertext(m))
      .slice(-Math.max(1, Math.min(unread || 1, 100)))
    if (incoming.length) {
      const keys: WAMessageKey[] = incoming.map((m) => ({
        ...m.key,
        remoteJid: m.key.remoteJid || chatId,
        participant: isJidGroup(chatId) ? m.key.participant || m.participant || undefined : m.key.participant || undefined
      }))
      try {
        await this.sock.readMessages(keys)
      } catch (err) {
        logError('readMessages', err)
        this.pendingReads.set(chatId, Math.max(this.pendingReads.get(chatId) ?? 0, unread || 1))
      }
    }
    // always sync markChatAsRead to the phone (clears the phone's unread badge for groups, LIDs and 1:1 chats)
    this.scheduleMarkRead(chatId, !!wasMarked)
  }

  async typing(chatId: string, on: boolean) {
    if (this.conn !== 'open' || this.ghost.noTyping) return
    await this.sock?.sendPresenceUpdate(on ? 'composing' : 'paused', chatId).catch(() => {})
  }

  private lastMsg(chatId: string) {
    const list = this.store.sorted(chatId)
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i]
      if (!m.key?.id || !m.messageTimestamp) continue
      const participant = isJidGroup(chatId) && !m.key.fromMe ? m.key.participant || m.participant || undefined : undefined
      if (isJidGroup(chatId) && !m.key.fromMe && !participant) continue
      return {
        key: {
          remoteJid: chatId,
          id: m.key.id,
          fromMe: !!m.key.fromMe,
          ...(participant ? { participant } : {})
        },
        messageTimestamp: m.messageTimestamp
      }
    }
    return undefined
  }

  async chatAction(chatId: string, a: ChatAction) {
    if ('delete' in a) return this.deleteChat(chatId)
    if ('block' in a) return this.block(chatId, a.block)
    const chat = this.chat(chatId)
    const sock = this.conn === 'open' ? this.sock : undefined
    const last = this.lastMsg(chatId)
    if ('pin' in a) {
      chat.localPin = a.pin ? Date.now() : undefined
      if (!a.pin) chat.waPinned = undefined
      sock?.chatModify({ pin: a.pin }, chatId).catch(() => {})
    } else if ('mute' in a) {
      chat.muteUntil = a.mute ? -1 : undefined
      sock?.chatModify({ mute: a.mute ? -1 : null }, chatId).catch(() => {})
    } else if ('archive' in a) {
      chat.archived = a.archive
      if (last) sock?.chatModify({ archive: a.archive, lastMessages: [last] }, chatId).catch(() => {})
    } else if ('markUnread' in a) {
      chat.markedUnread = a.markUnread
      if (!a.markUnread) chat.unread = 0
      if (last) sock?.chatModify({ markRead: !a.markUnread, lastMessages: [last] }, chatId).catch(() => {})
    } else if ('section' in a) {
      chat.section = a.section ?? undefined
    } else if ('alias' in a) {
      chat.alias = a.alias?.trim().slice(0, 60) || undefined
    }
    this.queueChat(chatId)
  }

  /** deletes the chat on the account (phone + every linked device) and here */
  async deleteChat(chatId: string) {
    const sock = this.requireOpen()
    const list = this.store.sorted(chatId)
    const last = list[list.length - 1]
    // WhatsApp wants the newest message as the range anchor; group messages need their author
    const lastMessages = last
      ? [{ key: { ...last.key, participant: last.key.fromMe ? undefined : last.key.participant || last.participant || undefined }, messageTimestamp: last.messageTimestamp }]
      : []
    await sock.chatModify(
      lastMessages.length ? { delete: true, lastMessages } : ({ delete: true, lastMessages: [] } as any),
      chatId
    )
    this.store.removeChat(chatId)
    this.loaded.delete(chatId)
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
    if (isJidGroup(chatId)) throw new Error('Grupos não podem ser bloqueados — saia do grupo pelo celular')
    const sock = this.requireOpen()
    await sock.updateBlockStatus(chatId, block ? 'block' : 'unblock')
    this.setBlocked([chatId], block ? 'add' : 'remove')
    this.queueChat(chatId)
  }

  // ---------- media ----------

  async media(chatId: string, msgId: string): Promise<string> {
    const key = chatId + '/' + msgId
    const job = this.mediaJobs.get(key)
    if (job) return job
    const p = (async () => {
      const m = this.store.getMessage(chatId, msgId) ?? this.store.findMessage(msgId)?.msg
      if (!m) throw new Error('not found')
      const c = normalizeMessageContent(m.message ?? undefined)
      const type = c ? getContentType(c) : undefined
      const media: any = type ? (c as any)[type] : undefined
      const file = path.join(this.store.dir, 'media', createHash('sha1').update(key).digest('hex') + '.' + extOf(media?.mimetype))
      if (fs.existsSync(file)) return file
      // straight to disk (a 100 MB video never sits in memory), renamed only when complete
      const stream = (await downloadMediaMessage(m, 'stream', {}, {
        logger: this.logger(),
        reuploadRequest: (msg) => this.requireOpen().updateMediaMessage(msg)
      })) as NodeJS.ReadableStream
      const part = file + '.part'
      try {
        await pipeline(stream, fs.createWriteStream(part))
        fs.renameSync(part, file)
      } catch (err) {
        fs.rmSync(part, { force: true })
        throw err
      }
      return file
    })()
    this.mediaJobs.set(key, p)
    p.catch(() => {}).finally(() => setTimeout(() => this.mediaJobs.delete(key), 1000))
    return p
  }

  mimeOf(chatId: string, msgId: string) {
    const m = this.store.getMessage(chatId, msgId)
    const c = normalizeMessageContent(m?.message ?? undefined)
    const type = c ? getContentType(c) : undefined
    return ((type && (c as any)[type]?.mimetype) as string | undefined)?.split(';')[0]
  }

  fileNameOf(chatId: string, msgId: string) {
    const m = this.store.getMessage(chatId, msgId)
    const c = normalizeMessageContent(m?.message ?? undefined)
    return c?.documentMessage?.fileName ?? undefined
  }

  async avatar(raw: string, big = false): Promise<string | null> {
    // group members often come as LIDs: ask with the phone-number id when we know it
    const jid = this.canon(raw) || raw
    const file = path.join(this.store.dir, 'avatars', jid.replace(/[^a-zA-Z0-9@._-]/g, '_') + (big ? '.big' : '') + '.jpg')
    try {
      const st = fs.statSync(file)
      if (Date.now() - st.mtimeMs < 3 * 86400_000 || this.conn !== 'open') return st.size ? file : null
    } catch {}
    if (this.conn !== 'open') return null
    const miss = this.avatarMiss.get(jid)
    if (miss && Date.now() - miss < 6 * 3600_000) return big ? this.avatar(raw) : null
    const jobKey = jid + (big ? '#big' : '')
    const job = this.avatarJobs.get(jobKey)
    if (job) return job
    const p = new Promise<string | null>((resolve) => {
      const run = async () => {
        this.avatarActive++
        try {
          const url = await this.sock!.profilePictureUrl(jid, big ? 'image' : 'preview', 8000)
          if (!url) throw new Error('none')
          const res = await fetch(url)
          if (!res.ok) throw new Error('http ' + res.status)
          fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()))
          resolve(file)
        } catch {
          if (big) return resolve(await this.avatar(raw))
          this.avatarMiss.set(jid, Date.now())
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

  avatarCached(jid: string): string | undefined {
    const file = path.join(this.store.dir, 'avatars', jid.replace(/[^a-zA-Z0-9@._-]/g, '_') + '.jpg')
    return fs.existsSync(file) ? file : undefined
  }

  // ---------- favorite stickers ----------

  /** WhatsApp syncs favorite stickers through app-state; Baileys hands those to the logger as "unprocessable" */
  private onSyncAction(obj: any) {
    const sa = obj?.syncAction
    const st: proto.SyncActionValue.IStickerAction | undefined = sa?.value?.stickerAction
    if (!st) return
    const index: string[] = Array.isArray(sa?.index) ? sa.index : []
    const id = (index[1] && /^[\w+/=-]+$/.test(index[1]) ? createHash('sha1').update(index[1]).digest('hex').slice(0, 32) : undefined) ?? stickerIdOf(st as any)
    const list = this.store.meta.stickers
    const i = list.findIndex((s) => s.id === id)
    if (st.isFavorite === false) {
      if (i >= 0 && list[i].source === 'account') {
        list.splice(i, 1)
        fs.rmSync(this.stickerPath(id), { force: true })
      }
    } else if (!st.isLottie && !this.store.meta.removedStickers.includes(id)) {
      const rec: StickerRec = {
        id,
        source: 'account',
        url: st.url ?? undefined,
        directPath: st.directPath ?? undefined,
        mediaKey: b64(st.mediaKey),
        mimetype: st.mimetype ?? 'image/webp',
        width: st.width ?? undefined,
        height: st.height ?? undefined,
        fileLength: st.fileLength ? Number(st.fileLength) : undefined,
        ts: Number(sa?.value?.timestamp ?? Date.now()) || Date.now()
      }
      if (i >= 0) list[i] = { ...list[i], ...rec }
      else list.push(rec)
      void this.downloadSticker(rec)
    }
    this.store.markMeta()
    this.emitStickers()
  }

  private stickerTimer: NodeJS.Timeout | null = null
  private emitStickers() {
    if (this.stickerTimer) return
    this.stickerTimer = setTimeout(() => {
      this.stickerTimer = null
      this.emit({ type: 'stickers', stickers: this.stickers() })
    }, 300)
  }

  private async downloadSticker(rec: StickerRec) {
    const file = this.stickerPath(rec.id)
    if (fs.existsSync(file) || !rec.mediaKey || !rec.directPath) return
    try {
      const stream = await downloadContentFromMessage(
        { mediaKey: Buffer.from(rec.mediaKey, 'base64'), directPath: rec.directPath, url: rec.url },
        'sticker'
      )
      const chunks: Buffer[] = []
      for await (const ch of stream) chunks.push(ch as Buffer)
      fs.writeFileSync(file, Buffer.concat(chunks))
      rec.failed = undefined
    } catch {
      rec.failed = Date.now()
    }
    this.store.markMeta()
    this.emitStickers()
  }

  private async retryStickerDownloads() {
    for (const s of this.store.meta.stickers) if (!fs.existsSync(this.stickerPath(s.id))) await this.downloadSticker(s)
  }

  async resyncStickers() {
    const sock = this.requireOpen()
    const state = (sock as any)._authState
    await state.keys.set({ 'app-state-sync-version': Object.fromEntries(ALL_WA_PATCH_NAMES.map((n) => [n, null])) })
    await sock.resyncAppState(ALL_WA_PATCH_NAMES, true)
    await this.retryStickerDownloads()
    this.emitStickers()
  }

  async favSticker(chatId: string, msgId: string, fav: boolean) {
    const m = this.store.getMessage(chatId, msgId)
    const sm = normalizeMessageContent(m?.message ?? undefined)?.stickerMessage
    if (!m || !sm) return
    const id = stickerIdOf(sm)
    const list = this.store.meta.stickers
    if (fav) {
      const src = await this.media(chatId, msgId)
      fs.copyFileSync(src, this.stickerPath(id))
      if (!list.some((s) => s.id === id))
        list.push({ id, source: 'local', width: sm.width ?? undefined, height: sm.height ?? undefined, ts: Date.now() })
      this.store.meta.removedStickers = this.store.meta.removedStickers.filter((x) => x !== id)
    } else {
      this.removeSticker(id)
    }
    this.store.markMeta()
    this.emitStickers()
    this.queueMsg(chatId, m)
  }

  removeSticker(id: string) {
    this.store.meta.stickers = this.store.meta.stickers.filter((s) => s.id !== id)
    if (!this.store.meta.removedStickers.includes(id)) this.store.meta.removedStickers.push(id)
    fs.rmSync(this.stickerPath(id), { force: true })
    this.store.markMeta()
    this.emitStickers()
  }
}

/** errors go to the log file (wired in main) instead of crashing anything */
export let logError = (where: string, err: unknown) => console.error(`[wa:${where}]`, (err as Error)?.message ?? err)
export function setErrorLogger(fn: typeof logError) {
  logError = fn
}

/** first link in a text, as typed (matched) and normalized (url) */
export function firstUrl(text: string): { url: string; matched: string } | null {
  const m = /\b(?:https?:\/\/|www\.)[^\s<]+[^\s<.,:;"')\]!?]/i.exec(text)
  if (!m) return null
  return { matched: m[0], url: /^https?:\/\//i.test(m[0]) ? m[0] : 'https://' + m[0] }
}

export function formatPhone(jid: string): string {
  const num = jid.split('@')[0].split(':')[0]
  if (jid.endsWith('@lid')) return '~' + num.slice(-4)
  if (num.startsWith('55') && (num.length === 12 || num.length === 13)) {
    const ddd = num.slice(2, 4)
    const rest = num.slice(4)
    const a = rest.length === 9 ? rest.slice(0, 5) : rest.slice(0, 4)
    const b = rest.slice(a.length)
    return `+55 ${ddd} ${a}-${b}`
  }
  return '+' + num
}

/** bytes as stored: Uint8Array live, base64 string or {type:'Buffer', data} once read back from disk */
function toBuf(x: unknown): Buffer | undefined {
  if (x == null) return undefined
  if (typeof x === 'string') return Buffer.from(x, 'base64')
  if (x instanceof Uint8Array) return Buffer.from(x)
  if (Array.isArray(x)) return Buffer.from(x)
  const d = (x as any).data
  return d != null ? toBuf(d) : undefined
}

/** sendMessage only resolves once WhatsApp's server took the message: that's the ✓ (Baileys leaves it "pending") */
/** WhatsApp lets you edit a sent message for 15 minutes */
const EDIT_WINDOW = 15 * 60_000

function markSent(m: WAMessage): WAMessage {
  if ((m.status ?? 0) < proto.WebMessageInfo.Status.SERVER_ACK) m.status = proto.WebMessageInfo.Status.SERVER_ACK
  return m
}
