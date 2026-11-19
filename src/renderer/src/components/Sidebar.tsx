import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useAnimationControls } from 'motion/react'
import type { UiChat } from '@shared/types'
import { getState, openChat, orderedChats, setState, toast, useStore, zap } from '../state'
import { colorOf, initials, listTime } from '../format'
import { Avatar } from './Avatar'
import { HoverPeek, peekEnter, peekLeave } from './HoverPeek'
import { askConfirm, askText, showMenu, type MenuItem } from './overlays'
import { DownloadIcon, PlaneIcon, Archive, Bell, BellOff, BlockIcon, Check, Chevron, ExportIcon, Gear, Ghost, LockIcon, PinIcon, Plus, Search, Trash, X } from './icons'

type Row = { kind: 'pinned'; chats: UiChat[] } | { kind: 'head'; label: string } | { kind: 'chat'; chat: UiChat; n?: number } | { kind: 'arch'; count: number; open: boolean }

export function chatMenu(chat: UiChat): MenuItem[] {
  const sections = getState().settings?.sections ?? []
  const act = (a: Parameters<typeof zap.chatAction>[1]) => void zap.chatAction(chat.id, a).catch((e) => toast(String(e.message ?? e)))
  return [
    { label: chat.pinned ? 'Desafixar' : 'Fixar no topo', icon: <PinIcon size={15} />, onClick: () => act({ pin: !chat.pinned }) },
    {
      label: 'Renomear…',
      icon: <span style={{ fontSize: 13 }}>✎</span>,
      onClick: async () => {
        const name = await askText('Nome desta conversa (só aqui no Zapdesk)', 'ex: Eu (Anotações), Mãe, Chefe…', chat.name)
        if (name === null) return
        act({ alias: name })
      }
    },
    {
      label: 'Mover para seção',
      icon: <Chevron size={15} />,
      sub: [
        ...sections.map((s) => ({ label: s, checked: chat.section === s, onClick: () => act({ section: s }) })),
        { label: 'Nova seção…', icon: <Plus size={15} />, onClick: () => void newSection(chat.id) },
        ...(chat.section ? [{ divider: true, label: '' }, { label: 'Tirar da seção', onClick: () => act({ section: null }) }] : [])
      ]
    },
    { label: chat.muted ? 'Reativar notificações' : 'Silenciar', icon: <BellOff size={15} />, onClick: () => act({ mute: !chat.muted }) },
    {
      label: chat.unread || chat.markedUnread ? 'Marcar como lida' : 'Marcar como não lida',
      icon: <Check size={13} />,
      onClick: () => act({ markUnread: !(chat.unread || chat.markedUnread) })
    },
    { label: chat.archived ? 'Desarquivar' : 'Arquivar', icon: <Archive size={15} />, onClick: () => act({ archive: !chat.archived }) },
    ...(getState().settings?.ghost.noReadReceipts
      ? [{ label: 'Enviar visto agora', icon: <Ghost size={15} />, onClick: () => void zap.readNow(chat.id).then(() => toast('Visto enviado ✓✓')) }]
      : []),
    { divider: true, label: '' },
    {
      label: 'Exportar conversa (.txt)',
      icon: <ExportIcon size={15} />,
      onClick: () => void zap.exportChat(chat.id).then((p) => p && toast('Conversa exportada'))
    },
    ...(!chat.isGroup
      ? [
          {
            label: chat.blocked ? 'Desbloquear contato' : 'Bloquear contato',
            icon: <BlockIcon size={15} />,
            danger: !chat.blocked,
            onClick: () => void toggleBlock(chat)
          }
        ]
      : []),
    { label: 'Apagar conversa', icon: <Trash size={15} />, danger: true, onClick: () => void deleteChat(chat) }
  ]
}

/** footer identity: click to switch WhatsApp account or add another */
function AccountButton({ name }: { name?: string }) {
  const accounts = useStore((s) => s.accounts)
  const current = accounts.find((a) => a.active)
  const label = name || current?.label || 'Você'
  const others = accounts.filter((a) => !a.active)
  const otherUnread = others.reduce((n, a) => n + a.unread, 0)
  const open = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    showMenu({ clientX: r.left, clientY: r.top - 8 - 44 * (accounts.length + 3) }, [
      ...accounts.map((a) => ({
        label:
          a.label +
          (a.kind === 'tg' ? '  ·  Telegram' : '') +
          (a.unread ? `  ·  ${a.unread > 99 ? '99+' : a.unread}` : '') +
          (a.conn === 'qr' || a.conn === 'setup' || a.conn === 'password' ? '  ·  aguardando login' : a.conn !== 'open' && a.conn !== 'loading' ? '  ·  conectando…' : ''),
        checked: a.active,
        icon: <span className="acc-dot" style={{ background: colorOf(a.id) }} />,
        onClick: () => !a.active && void zap.switchAccount(a.id)
      })),
      { divider: true, label: '' },
      { label: 'Adicionar WhatsApp', icon: <Plus size={15} />, onClick: () => void zap.addAccount('wa') },
      { label: 'Adicionar Telegram', icon: <PlaneIcon size={15} />, onClick: () => void zap.addAccount('tg') },
      { label: 'Gerenciar contas…', icon: <Gear size={15} />, onClick: () => setState({ settingsOpen: true, settingsTab: 'geral' }) }
    ])
  }
  return (
    <button className="account-btn" title={accounts.length > 1 ? 'Trocar de conta' : 'Contas — adicionar outro WhatsApp'} onClick={open}>
      <span className="me-avatar" style={accounts.length > 1 ? { background: colorOf(current?.id ?? ''), color: 'rgba(0,0,0,.7)' } : undefined}>
        {initials(label)}
        {otherUnread > 0 && <i className="acc-badge">{otherUnread > 99 ? '99+' : otherUnread}</i>}
      </span>
      <span className="me-name">
        {label}
        {current?.kind === 'tg' ? <small>Telegram{accounts.length > 1 ? ` · ${accounts.length} contas` : ''}</small> : accounts.length > 1 && <small>{accounts.length} contas</small>}
      </span>
      <Chevron size={13} className="acc-chev" />
    </button>
  )
}

/** like T3: a download button with a dot shows up when a new version is ready; one click installs and reopens */
export async function installUpdate() {
  const u = getState().update
  if (!u) return
  const ok = await askConfirm(
    `Atualizar pro Zapdesk ${u.version}?`,
    (u.notes.length ? 'Novidades:\n' + u.notes.map((n) => '• ' + n).join('\n') + '\n\n' : '') + 'O app fecha, instala sozinho e abre de novo em poucos segundos. Suas conversas e configurações ficam.',
    'Atualizar agora'
  )
  if (!ok) return
  toast('Atualizando… o Zapdesk volta já já')
  const started = await zap.installUpdate().catch(() => false)
  if (!started) toast('Não achei o instalador da atualização')
}

function UpdateButton() {
  const update = useStore((s) => s.update)
  return (
    <AnimatePresence>
      {update && (
        <motion.button
          key="upd"
          className="icon-btn update-btn"
          title={`Atualização ${update.version} disponível — clique pra instalar`}
          onClick={() => void installUpdate()}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={{ type: 'spring', stiffness: 500, damping: 32 }}
        >
          <DownloadIcon size={17} />
          <i className="update-dot" />
        </motion.button>
      )}
    </AnimatePresence>
  )
}

const errText = (e: any) => String(e?.message ?? e ?? 'Falhou').replace(/^Error invoking remote method '\w+': (Error: )?/, '')

export async function toggleBlock(chat: UiChat) {
  if (!chat.blocked) {
    const ok = await askConfirm(
      `Bloquear ${chat.name}?`,
      'A pessoa não vai mais conseguir te mandar mensagem nem ligar, e não vê mais seu visto por último, foto e recado. Vale pra sua conta inteira (celular também). Dá pra desbloquear depois.',
      'Bloquear',
      true
    )
    if (!ok) return
  }
  try {
    await zap.chatAction(chat.id, { block: !chat.blocked })
    toast(chat.blocked ? `${chat.name} desbloqueado` : `${chat.name} bloqueado 🚫`)
  } catch (e) {
    toast(errText(e))
  }
}

export async function deleteChat(chat: UiChat) {
  const ok = await askConfirm(
    `Apagar conversa com ${chat.name}?`,
    chat.channel
      ? 'Você sai deste canal e ele some da sua lista (aqui e no celular).'
      : `Apaga todas as mensagens desta conversa aqui no Zapdesk e no seu celular (e nos outros aparelhos conectados). Não dá pra desfazer.${chat.isGroup ? ' Você continua no grupo — pra sair, use o celular.' : ''}`,
    'Apagar',
    true
  )
  if (!ok) return
  try {
    await zap.chatAction(chat.id, { delete: true })
    toast('Conversa apagada')
  } catch (e) {
    toast(errText(e))
  }
}

async function newSection(chatId?: string) {
  const name = (await askText('Nova seção', 'ex: família, faculdade…'))?.toLowerCase()
  if (!name) return
  const s = getState().settings!
  if (!s.sections.includes(name)) setState({ settings: await zap.setSettings({ sections: [...s.sections, name] }) })
  if (chatId) await zap.chatAction(chatId, { section: name })
}

async function newChat() {
  const tg = getState().accounts.find((a) => a.active)?.kind === 'tg'
  const raw = await askText('Nova conversa', tg ? '@usuario, t.me/usuario ou número com DDD' : 'Número com DDD, ex: 11 91234-5678')
  if (!raw) return
  if (tg) {
    const id = await zap.resolveNumber(raw).catch(() => null)
    if (!id) return toast('Não achei esse contato no Telegram (o número pode estar escondido pela privacidade dele)')
    return void openChat(id)
  }
  let digits = raw.replace(/\D/g, '')
  if (digits.length === 10 || digits.length === 11) digits = '55' + digits
  if (digits.length < 10) return toast('Número inválido')
  // ask WhatsApp which account it really is (the Brazilian extra 9 can go either way)
  let id = digits + '@s.whatsapp.net'
  if (getState().conn === 'open') {
    const real = await zap.resolveNumber(digits).catch(() => undefined)
    if (real === null) return toast('Esse número não tem WhatsApp')
    if (real) id = real
  }
  if (!getState().chats[id]) {
    setState((s) => ({
      chats: { ...s.chats, [id]: { id, name: '+' + digits, ts: Date.now(), unread: 0, pinned: 0, muted: false, archived: false, isGroup: false } }
    }))
  }
  void openChat(id)
}

const ChatRow = memo(function ChatRow({ chat, active, n, typing }: { chat: UiChat; active: boolean; n?: number; typing?: string | true }) {
  const unread = chat.unread || (chat.markedUnread ? true : 0)
  // a quick glow + avatar bump when a new message lands (not for muted chats or the one you're reading)
  const [flash, setFlash] = useState(0)
  const prev = useRef({ ts: chat.ts, unread: chat.unread })
  useEffect(() => {
    const p = prev.current
    prev.current = { ts: chat.ts, unread: chat.unread }
    if (chat.unread > p.unread && chat.ts > p.ts && !active && !chat.muted) setFlash((f) => f + 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.ts, chat.unread])
  return (
    <button
      className={'chat-row' + (active ? ' active' : '') + (unread ? ' unread' : '') + (chat.blocked ? ' blocked' : '')}
      onClick={() => void openChat(chat.id)}
      onContextMenu={(e) => showMenu(e, chatMenu(chat))}
      onPointerEnter={(e) => peekEnter(chat.id, e.currentTarget, e)}
      onPointerLeave={peekLeave}
    >
      {flash > 0 && <span key={flash} className="row-flash" />}
      <span key={'av' + flash} className={flash ? 'row-av bump' : 'row-av'}>
        <Avatar id={chat.id} name={chat.name} size={34} />
      </span>
      <div className="chat-row-main">
        <div className="chat-row-top">
          <span className="chat-name">{chat.name}</span>
          {chat.blocked && <BlockIcon size={12} className="blocked-ic" />}
          {chat.muted && <BellOff size={12} className="dim" />}
          <span className="chat-time">{listTime(chat.ts)}</span>
        </div>
        <div className="chat-row-bottom">
          {typing ? (
            <span className="chat-preview typing">{typing === true ? 'digitando…' : `${typing} está digitando…`}</span>
          ) : (
            <span className="chat-preview">
              {chat.previewFromMe ? 'Você: ' : chat.previewSender ? chat.previewSender + ': ' : ''}
              {chat.preview}
            </span>
          )}
          {unread ? <span className={'unread-pill' + (chat.muted ? ' muted' : '')}>{unread === true ? '' : unread > 99 ? '99+' : unread}</span> : n ? <span className="kbd">^{n}</span> : null}
        </div>
      </div>
    </button>
  )
})

/**
 * "Marcar todas como lidas": clears the badges right away, then tells WhatsApp/Telegram chat by chat
 * (a few at a time, so a hundred unread chats don't flood the connection). Modo fantasma is respected.
 */
export async function markAllRead(list: UiChat[], where: string) {
  const targets = list.filter((c) => c.unread || c.markedUnread)
  if (!targets.length) return toast('Nada pra marcar: ' + where + ' já está tudo lido ✓')
  const ids = new Set(targets.map((c) => c.id))
  setState((s) => {
    const chats = { ...s.chats }
    for (const id of ids) if (chats[id]) chats[id] = { ...chats[id], unread: 0, markedUnread: false }
    return { chats }
  })
  toast(`${targets.length} ${targets.length > 1 ? 'conversas marcadas' : 'conversa marcada'} como lida${targets.length > 1 ? 's' : ''} ✓`)
  const queue = targets.slice()
  const worker = async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      // read first (sends the receipts for the real unread messages), then drop the manual "unread" mark
      await zap.read(c.id).catch(() => {})
      if (c.markedUnread) await zap.chatAction(c.id, { markUnread: false }).catch(() => {})
    }
  }
  await Promise.all([worker(), worker(), worker()])
}

/** silence (or bring back) a whole folder/section at once; synced to the phone like a single mute */
export async function muteAll(list: UiChat[], where: string, mute: boolean) {
  const targets = list.filter((c) => c.muted !== mute)
  if (!targets.length) return toast(mute ? 'Tudo em ' + where + ' já está silenciado' : 'Nada silenciado em ' + where)
  const ids = new Set(targets.map((c) => c.id))
  setState((s) => {
    const chats = { ...s.chats }
    for (const id of ids) if (chats[id]) chats[id] = { ...chats[id], muted: mute }
    return { chats }
  })
  const n = targets.length
  toast(mute ? `🔕 ${n} ${n > 1 ? 'conversas silenciadas' : 'conversa silenciada'}` : `🔔 Notificações de volta em ${n} ${n > 1 ? 'conversas' : 'conversa'}`)
  const queue = targets.slice()
  const worker = async () => {
    for (let c = queue.shift(); c; c = queue.shift()) await zap.chatAction(c.id, { mute }).catch(() => {})
  }
  await Promise.all([worker(), worker()])
}

/** right-click menu of a folder tab / section title: act on every chat in it */
const bulk = (list: () => UiChat[], where: string): MenuItem[] => {
  const all = list()
  const anyLoud = all.some((c) => !c.muted)
  const anyMuted = all.some((c) => c.muted)
  return [
    { label: 'Marcar todas como lidas', icon: <Check size={13} />, onClick: () => void markAllRead(list(), where) },
    ...(anyLoud ? [{ label: 'Silenciar todas', icon: <BellOff size={15} />, onClick: () => void muteAll(list(), where, true) }] : []),
    ...(anyMuted ? [{ label: 'Reativar notificações de todas', icon: <Bell size={15} />, onClick: () => void muteAll(list(), where, false) }] : [])
  ]
}

/** Telegram folders as tabs, like in the Telegram app (with unread count per folder) */
function FolderTabs() {
  const folders = useStore((s) => s.folders)
  const cur = useStore((s) => s.folder)
  const chats = useStore((s) => s.chats)
  const counts = useMemo(() => {
    const m = new Map<number, number>()
    for (const c of Object.values(chats)) {
      if (c.muted || !(c.unread || c.markedUnread)) continue
      for (const f of c.folders ?? []) m.set(f, (m.get(f) ?? 0) + 1)
    }
    return m
  }, [chats])
  if (!folders.length) return null
  const tabs: { id: number | null; title: string; emoji?: string }[] = [{ id: null, title: 'Todas' }, ...folders]
  return (
    <div
      className="folder-tabs no-drag"
      onWheel={(e) => {
        // vertical wheel scrolls the strip sideways
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY
      }}
    >
      {tabs.map((f) => {
        const n = f.id == null ? 0 : (counts.get(f.id) ?? 0)
        return (
          <button
            key={f.id ?? 'all'}
            className={'folder-tab' + (cur === f.id ? ' on' : '')}
            onClick={() => setState({ folder: f.id })}
            onContextMenu={(e) =>
              showMenu(
                e,
                bulk(
                  () => Object.values(getState().chats).filter((c) => (f.id == null ? !c.archived : c.folders?.includes(f.id))),
                  f.id == null ? 'todas as conversas' : 'a pasta ' + f.title
                )
              )
            }
          >
            {cur === f.id && <motion.span layoutId="folder-pill" className="folder-pill" transition={{ type: 'spring', stiffness: 520, damping: 40 }} />}
            <span className="folder-name">
              {f.emoji ? f.emoji + ' ' : ''}
              {f.title}
            </span>
            {n > 0 && <i className="folder-count">{n > 99 ? '99+' : n}</i>}
          </button>
        )
      })}
    </div>
  )
}

const previewText = (c: UiChat) => (c.previewFromMe ? 'Você: ' : c.previewSender ? c.previewSender + ': ' : '') + (c.preview ?? '')

const PinTile = memo(function PinTile({ c, i, active, typing }: { c: UiChat; i: number; active: boolean; typing?: string | true }) {
  const bump = useAnimationControls()
  const [peek, setPeek] = useState<string | null>(null)
  const prev = useRef({ ts: c.ts, unread: c.unread })
  const unread = c.unread || (c.markedUnread ? true : 0)

  const peekTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const latest = useRef(c)
  latest.current = c
  useEffect(() => () => clearTimeout(peekTimer.current), [])
  useEffect(() => {
    const p = prev.current
    prev.current = { ts: c.ts, unread: c.unread }
    const cur = latest.current
    if (!(c.unread > p.unread && c.ts > p.ts) || active) return
    void bump.start({ scale: [1, 1.16, 0.95, 1], rotate: [0, -7, 4, 0], transition: { duration: 0.55, ease: 'easeOut' } })
    if (cur.muted) return
    setPeek(previewText(cur))
    clearTimeout(peekTimer.current)
    peekTimer.current = setTimeout(() => setPeek(null), 5000)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.ts, c.unread])

  return (
    <motion.button
      layout
      className={'pin-tile' + (active ? ' active' : '') + (unread ? ' unread' : '') + (c.muted ? ' muted' : '')}
      initial={{ opacity: 0, scale: 0.85 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.85 }}
      transition={{ type: 'spring', stiffness: 500, damping: 34 }}
      onClick={() => {
        setPeek(null)
        void openChat(c.id)
      }}
      onContextMenu={(e) => showMenu(e, chatMenu(c))}
      onPointerEnter={(e) => peekEnter(c.id, e.currentTarget, e)}
      onPointerLeave={peekLeave}
      title={getState().settings?.hoverPeek === false ? c.name + (c.preview ? '\n' + previewText(c) : '') : undefined}
    >
      <motion.div className="pin-av" animate={bump}>
        <Avatar id={c.id} name={c.name} size={52} badge={unread} />
        {typing && (
          <span className="pin-typing">
            <span className="dots">
              <i />
              <i />
              <i />
            </span>
          </span>
        )}
      </motion.div>
      {i < 9 && <span className="kbd pin-kbd">^{i + 1}</span>}
      <span className="pin-name">
        {c.muted && <BellOff size={10} />}
        {c.name}
      </span>
      {(unread || typing) && !(peek && !typing) && (
        <span className={'pin-preview' + (typing ? ' typing' : '')}>{typing ? (typing === true ? 'digitando…' : `${typing} digitando…`) : previewText(c)}</span>
      )}
      <AnimatePresence>
        {peek && (
          <motion.span
            className="pin-peek"
            initial={{ opacity: 0, y: -6, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.95 }}
            transition={{ type: 'spring', stiffness: 520, damping: 30 }}
          >
            {peek}
          </motion.span>
        )}
      </AnimatePresence>
    </motion.button>
  )
})

function PinnedGrid({ chats, active, typingOf }: { chats: UiChat[]; active: string | null; typingOf: (id: string) => string | true | undefined }) {
  if (!chats.length) return null
  return (
    <div className="pinned-grid">
      <AnimatePresence initial={false}>
        {chats.map((c, i) => (
          <PinTile key={c.id} c={c} i={i} active={active === c.id} typing={typingOf(c.id)} />
        ))}
      </AnimatePresence>
    </div>
  )
}

export function Sidebar() {
  const chats = useStore((s) => s.chats)
  const settings = useStore((s) => s.settings)
  const active = useStore((s) => s.active)
  const typingMap = useStore((s) => s.typing)
  const me = useStore((s) => s.me)
  const conn = useStore((s) => s.conn)
  const sync = useStore((s) => s.sync)
  const hasPin = useStore((s) => s.hasPin)
  const [q, setQ] = useState('')
  const [searching, setSearching] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const pinnedStyle = settings?.appearance.pinned ?? 'grade'
  const folder = useStore((s) => s.folder)
  const folderList = useStore((s) => s.folders)
  const ghostOn = !!settings && (settings.ghost.noReadReceipts || settings.ghost.noTyping || settings.ghost.hideOnline)

  const { pinned, rows, groupChats } = useMemo(() => {
    const o = orderedChats(getState(), q)
    const rows: Row[] = []
    const groupChats: Record<string, UiChat[]> = {}
    for (const g of o.groups) groupChats[g.label] = g.chats
    let n = o.pinned.length
    if (pinnedStyle === 'lista' && o.pinned.length) {
      rows.push({ kind: 'pinned', chats: o.pinned })
    }
    for (const g of o.groups) {
      if (o.groups.length > 1 || g.label !== 'conversas' || o.pinned.length) rows.push({ kind: 'head', label: g.label })
      for (const chat of g.chats) {
        n++
        rows.push({ kind: 'chat', chat, n: n <= 9 ? n : undefined })
      }
    }
    if (o.archived.length) {
      rows.push({ kind: 'arch', count: o.archived.length, open: showArchived })
      if (showArchived) for (const chat of o.archived) rows.push({ kind: 'chat', chat })
    }
    return { pinned: o.pinned, rows, groupChats }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chats, settings?.sections, q, showArchived, pinnedStyle, folder, folderList])

  const now = Date.now()
  const typingOf = (id: string) => {
    const t = typingMap[id]
    return t && t.until > now ? (t.who ?? true) : undefined
  }

  return (
    <aside className="sidebar">
      <div className="side-head drag">
        <AnimatePresence initial={false} mode="popLayout">
          {searching ? (
            <motion.div key="s" className="search no-drag" initial={{ opacity: 0, width: '40%' }} animate={{ opacity: 1, width: '100%' }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }}>
              <Search size={15} />
              <input
                ref={searchRef}
                autoFocus
                value={q}
                placeholder="Buscar conversas"
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    setQ('')
                    setSearching(false)
                  }
                  if (e.key === 'Enter') {
                    const first = rows.find((r) => r.kind === 'chat') as Extract<Row, { kind: 'chat' }> | undefined
                    if (first) void openChat(first.chat.id)
                  }
                }}
              />
              <button
                className="icon-btn sm"
                onClick={() => {
                  setQ('')
                  setSearching(false)
                }}
              >
                <X size={14} />
              </button>
            </motion.div>
          ) : (
            <motion.div key="b" className="side-actions no-drag" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }}>
              <span className="brand" onContextMenu={(e) => showMenu(e, bulk(() => Object.values(getState().chats).filter((c) => !c.archived), 'todas as conversas'))}>
                Zapdesk
              </span>
              <button className="icon-btn" title="Buscar (Ctrl+K)" id="open-search" onClick={() => setSearching(true)}>
                <Search />
              </button>
              <button className="icon-btn" title="Nova conversa" onClick={() => void newChat()}>
                <Plus />
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {conn !== 'open' && conn !== 'loading' && (
        <div className="conn-pill">
          <span className="dot" /> {conn === 'reconnecting' ? 'Reconectando…' : conn === 'qr' ? 'Aguardando login' : 'Conectando…'}
        </div>
      )}
      {!sync.done && (
        <div className="sync-bar" title="Sincronizando histórico">
          <motion.i animate={{ width: `${Math.max(8, sync.progress ?? 30)}%` }} />
        </div>
      )}

      {!q && <FolderTabs />}

      {pinnedStyle === 'grade' && !q && <PinnedGrid chats={pinned} active={active} typingOf={typingOf} />}

      <div className="chat-list">
        {rows.map((r) =>
          r.kind === 'pinned' ? (
            <div key="pinned" className="pinned-section">
              <div className="section-head pinned-head" onContextMenu={(e) => showMenu(e, bulk(() => r.chats, 'as fixadas'))}>
                <PinIcon size={12} /> fixadas
              </div>
              {r.chats.map((chat, i) => (
                <ChatRow key={chat.id} chat={chat} active={active === chat.id} n={i < 9 ? i + 1 : undefined} typing={typingOf(chat.id)} />
              ))}
            </div>
          ) : r.kind === 'head' ? (
            <div
              key={'h:' + r.label}
              className="section-head"
              onContextMenu={(e) =>
                showMenu(e, [
                  // "conversas" = the whole list (pinned too); a section = just its chats
                  ...(r.label === 'conversas'
                    ? bulk(() => Object.values(getState().chats).filter((c) => !c.archived), 'todas as conversas')
                    : bulk(() => groupChats[r.label] ?? [], r.label === 'sem seção' ? 'as conversas sem seção' : 'a seção ' + r.label)),
                  { divider: true, label: '' },
                  { label: 'Nova seção…', icon: <Plus size={15} />, onClick: () => void newSection() }
                ])
              }
            >
              {r.label}
            </div>
          ) : r.kind === 'arch' ? (
            <button key="arch" className="section-head arch" onClick={() => setShowArchived((v) => !v)}>
              <Archive size={13} /> arquivadas ({r.count}) <Chevron size={12} style={{ transform: r.open ? 'rotate(90deg)' : undefined, transition: 'transform .15s' }} />
            </button>
          ) : (
            <ChatRow key={r.chat.id} chat={r.chat} active={active === r.chat.id} n={r.n} typing={typingOf(r.chat.id)} />
          )
        )}
        {!rows.length && <div className="empty-list">{q ? 'Nada encontrado' : conn === 'open' ? 'Sincronizando conversas…' : ''}</div>}
      </div>

      <HoverPeek />
      <div className="side-foot">
        <AccountButton name={me?.name} />
        <UpdateButton />
        {ghostOn && (
          <button className="icon-btn on" title="Modo fantasma ligado" onClick={() => setState({ settingsOpen: true, settingsTab: 'tools' })}>
            <Ghost size={17} />
          </button>
        )}
        {hasPin && (
          <button className="icon-btn" title="Bloquear agora (Ctrl+L)" onClick={() => void zap.lockNow()}>
            <LockIcon size={17} />
          </button>
        )}
        <button className="icon-btn" title="Configurações e aparência" onClick={() => setState({ settingsOpen: true, settingsTab: 'look' })}>
          <Gear size={17} />
        </button>
      </div>
    </aside>
  )
}
