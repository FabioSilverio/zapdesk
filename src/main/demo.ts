// Dev-only: seeds fake chats so the UI can be checked without a WhatsApp login (ZAP_DEMO=1).
import fs from 'node:fs'
import path from 'node:path'
import { createCipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto'
import { proto } from 'baileys'
import type { WAMessage } from 'baileys'
import type { Store } from './store'

const NOW = Math.floor(Date.now() / 1000)
let n = 0
const id = () => 'DEMO' + (n++).toString().padStart(6, '0')

function msg(chat: string, fromMe: boolean, text: string, ago: number, extra: Partial<WAMessage> = {}, participant?: string, pushName?: string): WAMessage {
  return {
    key: { remoteJid: chat, fromMe, id: id(), participant },
    message: { conversation: text },
    messageTimestamp: NOW - ago,
    pushName,
    status: fromMe ? 4 : undefined,
    ...extra
  } as WAMessage
}

export function seedDemo(store: Store) {
  store.meta.settings.sections = ['pessoal', 'trabalho']
  const chats: [string, string, string | undefined, number, number?][] = [
    ['5511900000001@s.whatsapp.net', 'Bu', 'pessoal', 0, 1],
    ['5511900000002@s.whatsapp.net', 'Manchete', 'pessoal', 4, 2],
    ['5511900000003@s.whatsapp.net', 'Writer', 'pessoal', 0],
    ['5511900000004@s.whatsapp.net', 'Sas', 'pessoal', 1],
    ['5511900000005@s.whatsapp.net', 'Trello', 'trabalho', 0],
    ['120363000000000001@g.us', 'Reuniões', 'trabalho', 8],
    ['5511900000007@s.whatsapp.net', 'Wpp Pandora', 'trabalho', 0],
    ['5511900000008@s.whatsapp.net', 'Chefe de Design', undefined, 0],
    ['5511900000009@s.whatsapp.net', 'Assistente de Design', undefined, 0]
  ]
  chats.forEach(([jid, name, section, unread, pin], i) => {
    store.contacts.set(jid, { id: jid, name })
    store.chats.set(jid, { id: jid, name: jid.endsWith('@g.us') ? name : undefined, ts: 0, unread, section, localPin: pin ? 1000 + pin : undefined })
    void i
  })
  const bu = chats[0][0]
  const list: WAMessage[] = [
    msg(bu, false, 'Bom dia! Conseguiu ver os leads de ontem?', 26 * 3600),
    msg(bu, true, 'Vi sim, tá tudo no *SisWeb* já 👍', 25.9 * 3600),
    msg(bu, false, 'Cadastrei no SisWeb os dois leads que o Wpp Pandora mandou: a Léia Petineli e um contato sem nome, (32) 99987-9402. O do contato sem nome teve confirmação de sucesso. O da Léia salvou do mesmo jeito, mas a mensagem de confirmação não foi registrada.', 3 * 3600),
    msg(bu, false, 'Também não deu pra checar duplicados, porque a _Lista de Leads_ continua abrindo em branco. Se puder dar uma olhada, me ajuda.', 3 * 3600 - 20),
    msg(bu, true, 'Valeu pelo print! A Léia está lá, sem duplicata, e os quatro do Wpp Pandora apareceram certinhos com o telefone completo.', 2 * 3600),
    msg(bu, true, 'Na próxima eu checo duplicados pelo botão Leads da Lista de Pré-Cadastro', 2 * 3600 - 15),
    msg(bu, false, '😂😂', 1800),
    msg(bu, false, 'Fechado então. Amanhã cedo te mando o relatório ~antigo~ novo: https://exemplo.com/relatorio', 600)
  ]
  const first = list[2]
  list.push({
    key: { remoteJid: bu, fromMe: true, id: id() },
    message: {
      extendedTextMessage: {
        text: 'Perfeito, pode mandar `aqui mesmo`',
        contextInfo: { stanzaId: first.key.id, participant: bu, quotedMessage: first.message }
      }
    },
    messageTimestamp: NOW - 300,
    status: 3
  } as WAMessage)
  // media + anti-apagar + edit samples (media files come from ZAP_DEMO_MEDIA, pre-placed in the cache)
  const vid = { key: { remoteJid: bu, fromMe: false, id: 'DEMOVIDEO1' }, message: { videoMessage: { mimetype: 'video/mp4', width: 1280, height: 720, seconds: 20, caption: 'vídeo de teste 🎬', url: 'x', mediaKey: Buffer.alloc(32) } }, messageTimestamp: NOW - 250 } as unknown as WAMessage
  const aud = { key: { remoteJid: bu, fromMe: false, id: 'DEMOAUDIO1' }, message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus', seconds: 12, ptt: true, url: 'x', mediaKey: Buffer.alloc(32) } }, messageTimestamp: NOW - 240 } as unknown as WAMessage
  const gone = msg(bu, false, 'essa aqui eu apaguei pra todo mundo 🙊', 230)
  ;(gone as any)._deleted = true
  const edited = msg(bu, false, 'reuniao amanha as 10', 220)
  ;(edited as any)._edit = { conversation: 'Reunião amanhã às 10h, beleza?' }
  const fmt = msg(
    bu,
    false,
    '*Pauta de amanhã:*\n- revisar os _leads_ novos\n- ligar pro ~João~ Pedro\n1. orçamento\n2. contrato\n> não esquecer do `SisWeb`\nlink do projeto: https://github.com/WhiskeySockets/Baileys',
    200
  )
  // an edit in WhatsApp's encrypted format (secretEncryptedMessage), stored before it was opened
  const secret = randomBytes(32)
  const orig = msg(bu, false, 'texto original com erro de digitaçao', 215)
  ;(orig.message as any).messageContextInfo = { messageSecret: secret }
  const inner = proto.Message.encode({ protocolMessage: { key: { remoteJid: bu, fromMe: true, id: orig.key.id }, type: 14, editedMessage: { conversation: 'texto corrigido pela edição criptografada ✅' } } }).finish()
  const ekey = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(32), Buffer.concat([Buffer.from(orig.key.id!), Buffer.from(bu), Buffer.from(bu), Buffer.from('Message Edit')]), 32))
  const iv = randomBytes(16)
  const c = createCipheriv('aes-256-gcm', ekey, iv)
  const encPayload = Buffer.concat([c.update(inner), c.final(), c.getAuthTag()])
  const secretEdit = { key: { remoteJid: bu, fromMe: false, id: 'DEMOSECRETEDIT' }, message: { secretEncryptedMessage: { targetMessageKey: { remoteJid: bu, fromMe: true, id: orig.key.id }, encPayload, encIv: iv, secretEncType: 2 } }, messageTimestamp: NOW - 205 } as unknown as WAMessage
  list.push(vid, aud, gone, edited, orig, secretEdit, fmt)
  const mediaDir = process.env.ZAP_DEMO_MEDIA
  if (mediaDir) {
    const target = path.join(store.dir, 'media')
    const name = (id: string, ext: string) => createHash('sha1').update(bu + '/' + id).digest('hex') + '.' + ext
    fs.copyFileSync(path.join(mediaDir, 'video.mp4'), path.join(target, name('DEMOVIDEO1', 'mp4')))
    fs.copyFileSync(path.join(mediaDir, 'audio.ogg'), path.join(target, name('DEMOAUDIO1', 'ogg')))
  }
  store.meta.scheduled = [{ id: 'demo1', chatId: bu, text: 'Bom dia! Já mandei o relatório 📊', at: Date.now() + 15 * 3600_000 }]
  store.meta.reminders = [{ id: 'demo2', chatId: bu, msgId: list[2].key.id!, text: 'Cadastrei no SisWeb os dois leads…', at: Date.now() + 2 * 3600_000 }]

  for (const m of list) store.putMessage(bu, m)
  const b = store.bucket(bu)
  b.reactions.set(list[4].key.id!, { [bu]: '❤️', me: '❤️' })
  b.reactions.set(list[7].key.id!, { [bu]: '🙏' })

  const grp = chats[5][0]
  const gmsgs = [
    msg(grp, false, 'Pessoal, reunião às 15h confirmada?', 5000, {}, '5511911110001@s.whatsapp.net', 'Carla'),
    msg(grp, false, 'Confirmado pra mim', 4800, {}, '5511911110002@s.whatsapp.net', 'Rafa'),
    msg(grp, true, 'Tô dentro, levo a pauta', 4700)
  ]
  for (let i = 0; i < 40; i++) {
    const who = i % 3
    gmsgs.push(
      who === 2
        ? msg(grp, true, `Minha msg ${i} ` + 'bla '.repeat((i * 7) % 23), 40000 - i * 800)
        : msg(grp, false, `Mensagem ${i} do grupo ` + 'texto '.repeat((i * 5) % 30), 40000 - i * 800, {}, `55119111100${who}@s.whatsapp.net`, who ? 'Rafa' : 'Carla')
    )
  }
  for (const m of gmsgs) store.putMessage(grp, m)

  const previews: Record<string, [string, number, boolean?]> = {
    [chats[1][0]]: ['Hoje o relatório veio do jeito certo', 3600],
    [chats[2][0]]: ['O post de hoje no Threads tá pronto', 7200, true],
    [chats[3][0]]: ['Consegui, sim! O "PRODUTO" já saiu', 9000],
    [chats[4][0]]: ['pronto, coloquei na sua lista', 20000, true],
    [chats[6][0]]: ['Pronto. Agora a rotina checa tudo sozinha', 30000],
    [chats[7][0]]: ['A cena nova é um balcão de loja', 90000],
    [chats[8][0]]: ['A v3 da nota fiscal está pronta', 200000]
  }
  for (const [jid, [p, ago, me]] of Object.entries(previews)) {
    const c = store.chats.get(jid)!
    c.preview = p
    c.ts = (NOW - ago) * 1000
    c.previewFromMe = !!me
  }
  for (const jid of [bu, grp]) {
    const c = store.chats.get(jid)!
    const last = store.sorted(jid).at(-1)!
    c.ts = Number(last.messageTimestamp) * 1000
    c.preview = last.message?.conversation ?? last.message?.extendedTextMessage?.text ?? ''
    c.previewFromMe = !!last.key.fromMe
  }
  store.meta.stickers = []

  // your own number (demo me = 5511999999999) + a pinned "wrong 9" ghost copy of it
  const self = '5511999999999@s.whatsapp.net'
  const ghost = '551199999999@s.whatsapp.net'
  store.chats.set(self, { id: self, ts: (NOW - 5000) * 1000, unread: 0, preview: 'ideia: vídeo sobre IA', previewFromMe: true })
  store.putMessage(self, msg(self, true, 'ideia: vídeo sobre IA', 5000))
  store.chats.set(ghost, { id: ghost, ts: (NOW - 100) * 1000, unread: 0, preview: 'Teste', previewFromMe: true, localPin: 1003 })
  store.putMessage(ghost, { ...msg(ghost, true, 'Teste', 100), status: 1 } as WAMessage)
  // archived-old: an archived chat the phone never sent history for (used to be invisible)
  store.contacts.set('5511900000099@s.whatsapp.net', { id: '5511900000099@s.whatsapp.net', name: 'Grupo antigo arquivado' })
  store.chats.set('5511900000099@s.whatsapp.net', { id: '5511900000099@s.whatsapp.net', ts: 0, unread: 0, archived: true })
}

/** simulates what a real account does while a chat is open: history landing mid-thread + live messages */
export function demoLive(ingest: (m: WAMessage, live: boolean) => void, dir?: string) {
  const grp = '120363000000000001@g.us'
  // voice notes landing in chats (ZAP_DEMO_MEDIA/voice-short.ogg + voice-long.ogg): automatic transcription
  const media = process.env.ZAP_DEMO_MEDIA
  if (dir && media && fs.existsSync(path.join(media, 'voice-short.ogg')))
    setTimeout(() => {
      const notes: [string, string, string, number][] = [
        ['5511900000004@s.whatsapp.net', 'DEMOVOICELONG', 'voice-long.ogg', 73],
        ['5511900000003@s.whatsapp.net', 'DEMOVOICESHORT', 'voice-short.ogg', 18]
      ]
      for (const [chat, id, file, seconds] of notes) {
        const name = createHash('sha1').update(chat + '/' + id).digest('hex') + '.ogg'
        fs.copyFileSync(path.join(media, file), path.join(dir, 'media', name))
        const m = { key: { remoteJid: chat, fromMe: false, id }, message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus', seconds, ptt: true, url: 'x', mediaKey: Buffer.alloc(32) } }, messageTimestamp: Math.floor(Date.now() / 1000) }
        ingest(m as unknown as WAMessage, true)
      }
    }, 2500)
  setTimeout(() => {
    for (let i = 0; i < 25; i++)
      ingest(msg(grp, false, `HISTÓRICO inserido no meio ${i} ` + 'xx '.repeat((i * 11) % 40), 39000 - i * 1100, {}, '5511911110009@s.whatsapp.net', 'Miguel'), false)
    ingest(msg(grp, false, 'mensagem nova ao vivo no grupo 👋', 1, {}, '5511911110002@s.whatsapp.net', 'Rafa'), true)
    ingest(msg('5511900000002@s.whatsapp.net', false, 'Chegou o relatório novo, dá uma olhada quando puder!', 0), true)
  }, 1800)
}

/** Telegram demo account (ZAP_DEMO + accounts.json kind "tg"): folders, a group, a channel, mentions */
export function seedTgDemo(store: Store) {
  const now = Date.now()
  const meta = store.meta as any
  meta.tgMe = { id: 'tg:777', name: 'Fabio', phone: '5511988887777' }
  const chats: [string, string, 'user' | 'group' | 'channel' | 'bot', number, boolean?][] = [
    ['tg:101', 'Marina Costa', 'user', 2, true],
    ['tg:-1001', 'Dev Brasil', 'group', 5],
    ['tg:-1002', 'Notícias Tech', 'channel', 12],
    ['tg:102', 'Pedro', 'user', 0, true],
    ['tg:103', 'BotFather', 'bot', 0],
    ['tg:-1003', 'Família', 'group', 0]
  ]
  let k = 0
  for (const [id, name, t, unread, contact] of chats) {
    store.chats.set(id, { id, name, ts: now - (k + 1) * 3600_000, unread, tg: { t, contact, readOut: 1000 } } as any)
    store.contacts.set(id, { id, name })
    k++
  }
  store.chats.get('tg:101')!.waPinned = 1
  meta.tgFolders = [
    { id: 2, title: 'Pessoal', include: ['tg:-1003'], pinned: ['tg:101'], exclude: [], contacts: true },
    { id: 3, title: 'Trabalho', emoji: '💼', include: ['tg:-1001'], pinned: [], exclude: [], bots: true },
    { id: 4, title: 'Canais', include: [], pinned: [], exclude: [], broadcasts: true }
  ]
  const rec = (chatId: string, id: number, fromMe: boolean, text: string, ago: number, extra: Record<string, unknown> = {}) => {
    const ts = now - ago * 1000
    const ui = { id: String(id), chatId, fromMe, ts, kind: 'text', text, status: fromMe ? 2 : undefined, ...extra }
    store.putMessage(chatId, { key: { id: String(id), remoteJid: chatId, fromMe }, messageTimestamp: ts / 1000, ui } as any)
    const c = store.chats.get(chatId)!
    if (ts >= c.ts) {
      c.ts = ts
      c.preview = text.replace(/[*_~`]/g, '')
      c.previewFromMe = fromMe
      c.lastMsgId = String(id)
    }
  }
  rec('tg:101', 1, false, 'Oi! Viu o *novo* app?', 7200)
  rec('tg:101', 2, true, 'Vi sim, tá _muito_ bom 😄', 7100)
  rec('tg:101', 3, false, 'Me manda o link depois: https://telegram.org', 600)
  const g = 'tg:-1001'
  rec(g, 10, false, 'Alguém usa `GramJS` aí?', 5000, { sender: 'tg:201', senderName: 'Lucas' })
  rec(g, 11, false, '@202 você que tinha falado disso né?', 4800, { sender: 'tg:203', senderName: 'Ana', mentions: { '202': { id: 'tg:202', name: 'Rafael' } } })
  rec(g, 12, true, 'Eu uso! Tô fazendo um cliente com ele', 4700)
  rec(g, 13, false, 'Show 🚀', 300, { sender: 'tg:202', senderName: 'Rafael', reactions: [{ e: '🔥', by: ['me', 'u1', 'u2'] }] })
  rec('tg:-1002', 20, false, '*Lançamento:* nova versão do Electron com suporte a ~vidro~ materiais nativos no Windows 11', 1800)
  rec('tg:102', 30, false, 'Bora jogar hoje?', 90000)
  rec('tg:103', 40, false, 'I can help you create and manage Telegram bots.', 200000)
  rec('tg:-1003', 50, false, 'Almoço domingo na vó 🍝', 40000, { sender: 'tg:204', senderName: 'Mãe' })
}
