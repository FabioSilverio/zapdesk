import { getContentType, normalizeMessageContent, proto, type WAMessage } from 'baileys'
import type { MsgKind, Reaction, UiMessage } from '@shared/types'
import { tsOf } from './store'

export type NameFn = (jid: string, pushName?: string | null) => string

const num = (v: any): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v?.toNumber === 'function' ? v.toNumber() : Number(v)
  return Number.isFinite(n) && n > 0 ? n : undefined
}
const toB64 = (b?: Uint8Array | null) => (b && b.length ? Buffer.from(b).toString('base64') : undefined)

/**
 * What an edit really says, whatever wrapper it arrived in: Baileys hands the same edit over as
 * {editedMessage:{message:X}}, {protocolMessage:{editedMessage:X}} or {message:X}. Keeping a wrapper made
 * the bubble show "Mensagem não suportada" (and older stored edits still have one: unwrapped on read).
 */
export function unwrapEdit(e: any): proto.IMessage | undefined {
  for (let i = 0; i < 6 && e && typeof e === 'object'; i++) {
    if (e.editedMessage) e = e.editedMessage
    else if (e.protocolMessage?.editedMessage) e = e.protocolMessage.editedMessage
    else if (e.message && typeof e.message === 'object' && !getContentType(e)) e = e.message
    else break
  }
  return e ?? undefined
}

const MEDIA_TYPES = new Set(['imageMessage', 'videoMessage', 'documentMessage', 'audioMessage', 'ptvMessage'])

/** the message as it reads now: the original, with an edit applied on top */
export function contentOf(m: WAMessage): proto.IMessage | undefined {
  const orig = normalizeMessageContent(m.message ?? undefined)
  const raw = (m as any)._edit
  if (!raw) return orig
  const ed = normalizeMessageContent(unwrapEdit(raw))
  const et = ed ? getContentType(ed) : undefined
  if (!ed || !et) return orig
  const ot = orig ? getContentType(orig) : undefined
  // a caption edit on a photo/video/document: keep the media, swap the caption
  if (orig && ot && MEDIA_TYPES.has(ot)) {
    const caption = (ed as any)[et]?.caption ?? ed.conversation ?? ed.extendedTextMessage?.text
    return caption != null ? ({ ...orig, [ot]: { ...(orig as any)[ot], caption } } as proto.IMessage) : orig
  }
  return ed
}

/** previews/notifications show text, not WhatsApp markup: "*oi* _tudo_\n- bem" → "oi tudo · bem" */
export function plain(text: string): string {
  // previews are one short line anyway; never run the regexes over a huge message
  return text
    .slice(0, 800)
    .replace(/```([\s\S]*?)```/g, '$1')
    .replace(/(^|[\s(])([*_~`])(?!\s)([^\n]*?\S)\2(?=$|[\s.,!?;:)])/g, '$1$3')
    .replace(/^\s*(?:>|[-*•]|\d{1,3}[.)])\s+/gm, '')
    .replace(/\s*\n+\s*/g, ' · ')
    .trim()
}

/** short text used for previews, quotes and notifications */
export function previewOf(content: proto.IMessage | undefined | null): string {
  return plain(rawPreviewOf(content))
}

function rawPreviewOf(content: proto.IMessage | undefined | null): string {
  const c = normalizeMessageContent(content ?? undefined)
  if (!c) return ''
  const type = getContentType(c)
  switch (type) {
    case 'conversation':
      return c.conversation ?? ''
    case 'extendedTextMessage':
      return c.extendedTextMessage?.text ?? ''
    case 'imageMessage':
      return '📷 ' + (c.imageMessage?.caption || 'Foto')
    case 'videoMessage':
      return (c.videoMessage?.gifPlayback ? '🎞️ ' : '🎥 ') + (c.videoMessage?.caption || (c.videoMessage?.gifPlayback ? 'GIF' : 'Vídeo'))
    case 'ptvMessage':
      return '🎥 Vídeo'
    case 'audioMessage':
      return c.audioMessage?.ptt ? '🎤 Mensagem de voz' : '🎵 Áudio'
    case 'documentMessage':
      return '📄 ' + (c.documentMessage?.fileName || 'Documento')
    case 'stickerMessage':
      return '💟 Figurinha'
    case 'locationMessage':
    case 'liveLocationMessage':
      return '📍 Localização'
    case 'contactMessage':
      return '👤 ' + (c.contactMessage?.displayName || 'Contato')
    case 'contactsArrayMessage':
      return '👥 Contatos'
    case 'pollCreationMessage':
    case 'pollCreationMessageV2':
    case 'pollCreationMessageV3':
      return '📊 ' + ((c as any)[type!]?.name || 'Enquete')
    case 'eventMessage':
      return '📅 ' + (c.eventMessage?.name || 'Evento')
    case 'buttonsResponseMessage':
      return c.buttonsResponseMessage?.selectedDisplayText ?? ''
    case 'listResponseMessage':
      return c.listResponseMessage?.title ?? ''
    case 'templateButtonReplyMessage':
      return c.templateButtonReplyMessage?.selectedDisplayText ?? ''
    case 'buttonsMessage':
      return c.buttonsMessage?.contentText ?? ''
    case 'templateMessage':
      return c.templateMessage?.hydratedTemplate?.hydratedContentText ?? ''
    case 'interactiveMessage':
      return c.interactiveMessage?.body?.text ?? ''
    default:
      return ''
  }
}

const STUB = proto.WebMessageInfo.StubType

/** numeric WebMessageInfo.StubType (history sync sometimes stores the enum name as a string) */
export function stubTypeOf(m: WAMessage): number | undefined {
  const raw = (m as any).messageStubType
  if (typeof raw === 'number') return raw
  if (typeof raw === 'string' && typeof (STUB as any)[raw] === 'number') return (STUB as any)[raw]
  return undefined
}

export function isCiphertext(m: WAMessage): boolean {
  return !normalizeMessageContent(m.message ?? undefined) && stubTypeOf(m) === STUB.CIPHERTEXT
}

export function isRevokeStub(m: WAMessage): boolean {
  const s = stubTypeOf(m)
  return s === STUB.REVOKE || s === STUB.ADMIN_REVOKE
}

const STUB_TEXT: Record<number, string> = {
  [STUB.REVOKE]: 'Mensagem apagada',
  [STUB.ADMIN_REVOKE]: 'Mensagem apagada por um admin',
  [STUB.GROUP_CREATE]: 'Grupo criado',
  [STUB.GROUP_CHANGE_SUBJECT]: 'Assunto do grupo alterado',
  [STUB.GROUP_CHANGE_ICON]: 'Ícone do grupo alterado',
  [STUB.GROUP_PARTICIPANT_ADD]: 'Participante adicionado',
  [STUB.GROUP_PARTICIPANT_REMOVE]: 'Participante removido',
  [STUB.GROUP_PARTICIPANT_PROMOTE]: 'Participante promovido a admin',
  [STUB.GROUP_PARTICIPANT_DEMOTE]: 'Admin removido',
  [STUB.GROUP_PARTICIPANT_INVITE]: 'Participante convidado',
  [STUB.GROUP_PARTICIPANT_LEAVE]: 'Participante saiu',
  [STUB.CHANGE_EPHEMERAL_SETTING]: 'Mensagens temporárias alteradas',
  [STUB.DISAPPEARING_MODE]: 'Mensagens temporárias alteradas'
}

export function stubTextOf(m: WAMessage): string {
  const s = stubTypeOf(m)
  if (s == null) return ''
  if (s === STUB.GROUP_CHANGE_SUBJECT && m.messageStubParameters?.[0]) return `Assunto alterado para "${m.messageStubParameters[0]}"`
  return STUB_TEXT[s] ?? ''
}

/** messages we never show as bubbles */
export function isInvisible(m: WAMessage): boolean {
  const c = normalizeMessageContent(m.message ?? undefined)
  if (!c) {
    if ((m as any)._deleted) return false
    const s = stubTypeOf(m)
    return !(s != null && (s === STUB.CIPHERTEXT || s in STUB_TEXT))
  }
  const type = getContentType(c)
  return (
    type === 'protocolMessage' ||
    type === 'reactionMessage' ||
    type === 'senderKeyDistributionMessage' ||
    type === 'messageContextInfo' ||
    type === 'pollUpdateMessage' ||
    type === 'encReactionMessage' ||
    type === 'keepInChatMessage' ||
    type === 'encEventResponseMessage' ||
    type === 'secretEncryptedMessage' ||
    type === undefined
  )
}

export interface UiCtx {
  name: NameFn
  canon: (jid: string) => string
  reactions: Record<string, string> | undefined
  favIds: Set<string>
  keepDeleted: boolean
}

export function toUi(chatId: string, m: WAMessage, { name, canon, reactions, favIds, keepDeleted }: UiCtx): UiMessage {
  const fromMe = !!m.key.fromMe
  const rawSender = fromMe ? undefined : m.key.participant || m.participant || m.key.remoteJid || undefined
  const sender = rawSender ? canon(rawSender) || rawSender : undefined
  const ui: UiMessage = {
    id: m.key.id!,
    chatId,
    fromMe,
    sender: sender ?? undefined,
    senderName: sender ? name(sender, m.pushName) : undefined,
    ts: tsOf(m),
    kind: 'unknown',
    status: m.status ?? undefined,
    edited: !!(m as any)._edit
  }
  if (ui.edited) ui.originalText = previewOf(m.message) || undefined

  if ((m as any)._deleted || isRevokeStub(m)) {
    // anti-apagar: we already received the content before the revoke arrived
    const hasContent = !!m.message && !!previewOf(m.message)
    if (!keepDeleted || !hasContent) {
      ui.kind = 'deleted'
      ui.text = fromMe ? 'Você apagou esta mensagem' : stubTypeOf(m) === STUB.ADMIN_REVOKE ? 'Mensagem apagada por um admin' : 'Mensagem apagada'
      return ui
    }
    ui.revoked = true
  }

  const c = contentOf(m)
  if (!c) {
    if (stubTypeOf(m) === STUB.CIPHERTEXT) {
      // couldn't decrypt yet (missing Signal session / key): show as a real bubble from the sender until retry/resend arrives
      ui.kind = 'unknown'
      ui.text = '🔒 Aguardando esta mensagem… (se não carregar, abra no celular)'
      return ui
    }
    const st = stubTextOf(m)
    if (st) {
      ui.kind = 'system'
      ui.text = st
    }
    return ui
  }

  const type = getContentType(c)
  let ctx: proto.IContextInfo | null | undefined
  const set = (kind: MsgKind) => (ui.kind = kind)

  switch (type) {
    case 'conversation':
      set('text')
      ui.text = c.conversation ?? ''
      break
    case 'extendedTextMessage': {
      const et = c.extendedTextMessage!
      set('text')
      ui.text = et.text ?? ''
      ctx = et.contextInfo
      const url = (et as any).canonicalUrl || et.matchedText
      if (url && (et.title || et.description || et.jpegThumbnail?.length)) {
        const t = toB64(et.jpegThumbnail)
        ui.link = {
          url: /^https?:\/\//i.test(url) ? url : 'https://' + url,
          title: et.title ?? undefined,
          description: et.description ?? undefined,
          thumb: t ? 'data:image/jpeg;base64,' + t : undefined
        }
      }
      break
    }
    case 'imageMessage': {
      const im = c.imageMessage!
      set('image')
      ui.text = im.caption ?? undefined
      ui.w = im.width ?? undefined
      ui.h = im.height ?? undefined
      ui.mime = im.mimetype ?? 'image/jpeg'
      ui.hasMedia = true
      ui.size = num(im.fileLength)
      const t = toB64(im.jpegThumbnail)
      if (t) ui.thumb = 'data:image/jpeg;base64,' + t
      ctx = im.contextInfo
      break
    }
    case 'videoMessage':
    case 'ptvMessage': {
      const vm = (type === 'ptvMessage' ? c.ptvMessage : c.videoMessage)!
      set('video')
      ui.text = vm.caption ?? undefined
      ui.w = vm.width ?? undefined
      ui.h = vm.height ?? undefined
      ui.seconds = vm.seconds ?? undefined
      ui.mime = vm.mimetype ?? 'video/mp4'
      ui.ptt = !!vm.gifPlayback
      ui.hasMedia = true
      ui.size = num(vm.fileLength)
      const t = toB64(vm.jpegThumbnail)
      if (t) ui.thumb = 'data:image/jpeg;base64,' + t
      ctx = vm.contextInfo
      break
    }
    case 'audioMessage': {
      const am = c.audioMessage!
      set('audio')
      ui.seconds = am.seconds ?? undefined
      ui.ptt = !!am.ptt
      ui.mime = am.mimetype ?? 'audio/ogg'
      ui.hasMedia = true
      ctx = am.contextInfo
      break
    }
    case 'documentMessage': {
      const dm = c.documentMessage!
      set('document')
      ui.fileName = dm.fileName || dm.title || 'Documento'
      ui.mime = dm.mimetype ?? undefined
      ui.text = dm.caption ?? undefined
      ui.hasMedia = true
      ui.size = num(dm.fileLength)
      const t = toB64(dm.jpegThumbnail)
      if (t) ui.thumb = 'data:image/jpeg;base64,' + t
      ctx = dm.contextInfo
      break
    }
    case 'stickerMessage': {
      const sm = c.stickerMessage!
      set('sticker')
      ui.w = sm.width ?? 160
      ui.h = sm.height ?? 160
      ui.mime = sm.mimetype ?? 'image/webp'
      ui.hasMedia = !sm.isLottie
      ui.stickerFav = favIds.has(stickerIdOf(sm))
      ctx = sm.contextInfo
      break
    }
    case 'locationMessage':
    case 'liveLocationMessage': {
      const lm: any = (c as any)[type]
      set('location')
      ui.text = [lm?.name, lm?.address].filter(Boolean).join(' — ') || 'Localização'
      ui.fileName = `https://maps.google.com/?q=${lm?.degreesLatitude},${lm?.degreesLongitude}`
      const t = toB64(lm?.jpegThumbnail)
      if (t) ui.thumb = 'data:image/jpeg;base64,' + t
      break
    }
    default: {
      const p = previewOf(c)
      if (p) {
        set(type?.startsWith('poll') ? 'poll' : type?.startsWith('contact') ? 'contact' : 'text')
        ui.text = p
      } else {
        set('unknown')
        ui.text = 'Mensagem não suportada — abra no celular'
      }
      ctx = (c as any)[type!]?.contextInfo
    }
  }

  if (ctx?.quotedMessage && ctx.stanzaId) {
    const qSender = ctx.participant ?? ''
    ui.quoted = {
      id: ctx.stanzaId,
      senderName: qSender ? name(qSender) : '',
      text: previewOf(ctx.quotedMessage) || 'Mensagem'
    }
  }

  // "@265802808832103": WhatsApp puts the account id in the text; keep who it is so it shows as @Name
  const mj = (ctx?.mentionedJid ?? []).filter(Boolean) as string[]
  if (mj.length) {
    ui.mentions = {}
    for (const j of mj.slice(0, 50)) {
      const id = canon(j) || j
      const nm = name(id)
      ui.mentions[j.split('@')[0]] = { id, name: /^\+?[\d\s()-]+$/.test(nm) && id.endsWith('@lid') ? 'Contato' : nm }
    }
  }

  const all: Record<string, string> = { ...(reactions ?? {}) }
  for (const r of m.reactions ?? []) {
    const who = r.key?.fromMe ? 'me' : r.key?.participant || r.key?.remoteJid || ''
    if (!who || who in all) continue
    if (r.text) all[who] = r.text
  }
  const grouped = new Map<string, string[]>()
  for (const [who, e] of Object.entries(all)) {
    if (!e) continue
    const list = grouped.get(e) ?? []
    list.push(who)
    grouped.set(e, list)
  }
  if (grouped.size) ui.reactions = [...grouped].map(([e, by]): Reaction => ({ e, by }))
  return ui
}

export function stickerIdOf(sm: { fileSha256?: Uint8Array | null; fileEncSha256?: Uint8Array | null; directPath?: string | null }): string {
  const h = sm.fileSha256?.length ? sm.fileSha256 : sm.fileEncSha256
  if (h?.length) return Buffer.from(h).toString('hex').slice(0, 32)
  return Buffer.from(sm.directPath ?? 'x').toString('hex').slice(-32)
}

/** chat-list line for a voice note that was already transcribed: 🎤 "what it says" */
export function voicePreview(preview: string | undefined, transcript: string | false | undefined | null | 0 | '') {
  if (!transcript || !preview?.startsWith('🎤')) return preview
  const t = transcript.length > 140 ? transcript.slice(0, 140) + '…' : transcript
  return '🎤 “' + t + '”'
}

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<]+[^\s<.,:;"')\]!?]/gi

/** extracts unique normalized http(s) URLs from a message's text */
export function extractUrls(text?: string): string[] {
  if (!text || !/https?:\/\/|www\./i.test(text)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const m of text.matchAll(URL_RE)) {
    const raw = m[0]
    const url = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw
    if (seen.has(url)) continue
    seen.add(url)
    out.push(url)
  }
  return out
}
