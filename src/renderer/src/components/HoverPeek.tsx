// Hover a chat in the list → a floating card with its last messages. Opens on hover intent,
// glides between rows once open, never marks anything as read. Only transform/opacity animate.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { AnimatePresence, animate, motion, useMotionValue } from 'motion/react'
import type { UiMessage } from '@shared/types'
import { getState, useStore, zap, isLite } from '../state'
import { colorOf, duration, listTime, richText, timeOf } from '../format'
import { Avatar } from './Avatar'

type Anchor = { id: string; top: number; bottom: number; right: number }

// ---- hover controller (module state, so hovering never re-renders the sidebar) ----
let anchor: Anchor | null = null
let lastHide = 0
let openTimer: ReturnType<typeof setTimeout> | undefined
let closeTimer: ReturnType<typeof setTimeout> | undefined
const subs = new Set<() => void>()
const emit = () => subs.forEach((f) => f())
const subscribe = (f: () => void) => {
  subs.add(f)
  return () => subs.delete(f)
}

const CARD_W = 300
const INTENT_MS = 420 // first open: you have to rest on the row
const WARM_MS = 40 // already open (or just closed): follow the mouse right away

// last messages per chat, keyed by the chat's ts so a new message refreshes it
const cache = new Map<string, { ts: number; msgs: UiMessage[] }>()
const inflight = new Map<string, Promise<UiMessage[]>>()

function fromThread(id: string) {
  const t = getState().threads[id]
  return t?.list.length ? t.list.slice(-8) : null
}

function load(id: string): Promise<UiMessage[]> {
  const ts = getState().chats[id]?.ts ?? 0
  const hit = cache.get(id)
  if (hit && hit.ts === ts) return Promise.resolve(hit.msgs)
  const open = fromThread(id)
  if (open) {
    cache.set(id, { ts, msgs: open })
    return Promise.resolve(open)
  }
  let p = inflight.get(id)
  if (!p) {
    p = zap
      .peek(id)
      .catch(() => [] as UiMessage[])
      .then((msgs) => {
        inflight.delete(id)
        cache.set(id, { ts, msgs })
        if (cache.size > 40) cache.delete(cache.keys().next().value!)
        return msgs
      })
    inflight.set(id, p)
  }
  return p
}

function blocked(id: string, el: HTMLElement) {
  const s = getState()
  if (s.settings?.hoverPeek === false || s.active === id || s.locked || isLite(s)) return true
  if (document.querySelector('.menu, .dialog, .scrim, .popover, .lightbox')) return true
  // no room on the right (narrow window: the list fills the screen)
  const edge = el.closest('.sidebar')?.getBoundingClientRect().right ?? el.getBoundingClientRect().right
  return edge + CARD_W + 24 > window.innerWidth
}

export function peekEnter(id: string, el: HTMLElement, e: React.PointerEvent) {
  if (e.pointerType !== 'mouse' || e.buttons) return
  clearTimeout(closeTimer)
  clearTimeout(openTimer)
  if (blocked(id, el)) return hidePeek()
  const warm = anchor !== null || Date.now() - lastHide < 350
  openTimer = setTimeout(async () => {
    await load(id)
    if (!el.isConnected || !el.matches(':hover') || blocked(id, el)) return
    const r = el.getBoundingClientRect()
    // always beside the sidebar's edge (pinned tiles sit mid-sidebar)
    const edge = el.closest('.sidebar')?.getBoundingClientRect().right ?? r.right
    anchor = { id, top: r.top, bottom: r.bottom, right: edge }
    emit()
  }, warm ? WARM_MS : INTENT_MS)
  // start reading while the intent timer runs: the card opens already filled
  if (!warm) setTimeout(() => el.matches(':hover') && void load(id), 150)
}

export function peekLeave() {
  clearTimeout(openTimer)
  clearTimeout(closeTimer)
  closeTimer = setTimeout(hidePeek, 110)
}

export function hidePeek(cold = false) {
  clearTimeout(openTimer)
  clearTimeout(closeTimer)
  // scrolling/clicking: the next row under the mouse needs a real pause again, not the instant follow
  if (cold) lastHide = 0
  if (!anchor) return
  anchor = null
  if (!cold) lastHide = Date.now()
  emit()
}

// ---- card ----
const LABEL: Partial<Record<UiMessage['kind'], string>> = {
  image: '📷 Foto',
  video: '🎬 Vídeo',
  audio: '🎤 Áudio',
  document: '📄 Documento',
  sticker: '💟 Figurinha',
  location: '📍 Localização',
  contact: '👤 Contato',
  poll: '📊 Enquete',
  deleted: '🚫 Mensagem apagada',
  unknown: 'Mensagem'
}

function Bubble({ m, group, i, n, unreadFrom }: { m: UiMessage; group: boolean; i: number; n: number; unreadFrom: number }) {
  const label = m.kind === 'text' ? '' : m.kind === 'audio' ? `🎤 Áudio ${duration(m.seconds)}` : m.kind === 'document' ? `📄 ${m.fileName ?? 'Documento'}` : (LABEL[m.kind] ?? '')
  const thumb = (m.kind === 'image' || m.kind === 'video' || m.kind === 'sticker') && m.thumb
  return (
    <>
      {i === unreadFrom && <div className="peek-new" style={{ animationDelay: i * 28 + 'ms' }}>novas</div>}
      <div className={'peek-msg ' + (m.fromMe ? 'out' : 'in') + (m.kind === 'sticker' ? ' sticker' : '')} style={{ animationDelay: (n - 1 - i < 6 ? i * 28 : 0) + 'ms' }}>
        {group && !m.fromMe && m.senderName && (
          <b className="peek-sender" style={{ color: colorOf(m.sender ?? m.senderName) }}>
            {m.senderName}
          </b>
        )}
        {thumb && <img className="peek-thumb" src={thumb} alt="" draggable={false} />}
        {(label || m.text) && (
          <span className="peek-text">
            {label && <span className="peek-kind">{label}</span>}
            {label && m.text ? ' ' : ''}
            {m.text ? richText(m.text.length > 400 ? m.text.slice(0, 400) + '…' : m.text, m.id) : null}
          </span>
        )}
        <i className="peek-time">{timeOf(m.ts)}</i>
      </div>
    </>
  )
}

export function HoverPeek() {
  const a = useSyncExternalStore(subscribe, () => anchor)
  const chat = useStore((s) => (a ? s.chats[a.id] : undefined))
  const typing = useStore((s) => (a ? s.typing[a.id] : undefined))
  const [got, setGot] = useState<{ id: string; msgs: UiMessage[] } | null>(null)
  // first frame already has the right chat's messages (they were loaded before the card opened)
  const msgs = a ? (got?.id === a.id ? got.msgs : (cache.get(a.id)?.msgs ?? [])) : []
  const card = useRef<HTMLDivElement>(null)
  const y = useMotionValue(0)
  const shown = useRef(false)
  const [warm, setWarm] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => {
      setWarm(true)
      setTimeout(() => setWarm(false), 600)
    }, 2500)
    return () => clearTimeout(t)
  }, [])

  // global "get out of the way" triggers: click, scroll, keys, window losing focus, chat opened
  useEffect(() => {
    if (!a) return
    const off = () => hidePeek(true)
    window.addEventListener('pointerdown', off, true)
    window.addEventListener('wheel', off, { passive: true })
    window.addEventListener('keydown', off, true)
    window.addEventListener('blur', off)
    window.addEventListener('resize', off)
    return () => {
      window.removeEventListener('pointerdown', off, true)
      window.removeEventListener('wheel', off)
      window.removeEventListener('keydown', off, true)
      window.removeEventListener('blur', off)
      window.removeEventListener('resize', off)
    }
  }, [!!a])
  const active = useStore((s) => s.active)
  const locked = useStore((s) => s.locked)
  useEffect(() => {
    if (a && (active === a.id || locked)) hidePeek(true)
  }, [active, a, locked])

  // content: cached synchronously when possible; refreshes if a message lands while you look
  useEffect(() => {
    if (!a) return
    let live = true
    const id = a.id
    void load(id).then((m) => live && setGot({ id, msgs: m }))
    return () => {
      live = false
    }
  }, [a?.id, chat?.ts])

  // place it next to the row, clamped to the window; glide (spring on transform) when moving between rows
  useLayoutEffect(() => {
    if (!a) {
      shown.current = false
      return
    }
    const h = card.current?.offsetHeight ?? 200
    const target = Math.round(Math.min(Math.max(8, a.top - 10), window.innerHeight - h - 8))
    const notch = Math.min(Math.max(14, (a.top + a.bottom) / 2 - target), h - 14)
    card.current?.style.setProperty('--notch', notch + 'px')
    if (!shown.current) {
      y.set(target)
      shown.current = true
    } else animate(y, target, { type: 'spring', stiffness: 620, damping: 44, mass: 0.7 })
  }, [a, msgs.length, msgs.at(-1)?.id])

  const group = !!chat?.isGroup
  const unread = chat?.unread ?? 0
  const unreadFrom = unread > 0 && unread < msgs.length ? msgs.length - unread : -1
  const typingNow = typing && typing.until > Date.now()
  const sub = typingNow
    ? (typing.who ? typing.who + ' está digitando…' : 'digitando…')
    : unread
      ? `${unread > 99 ? '99+' : unread} não lida${unread > 1 ? 's' : ''}`
      : chat?.self
        ? 'suas anotações'
        : group
          ? 'grupo'
          : chat?.ts
            ? 'última mensagem ' + listTime(chat.ts)
            : ''

  return (
    <>
      {warm && !a && (
        <div className="peek-card peek-warm">
          <div className="peek-head">
            <div className="peek-title">
              <b>Zapdesk</b>
              <small className="unread">1 não lida</small>
            </div>
          </div>
          <div className="peek-body">
            <div className="peek-msg in">
              <span className="peek-text">
                <span className="peek-kind">🎤📷🎬📄💟📍👤📊🚫</span> <b>a</b> <i>a</i> <code>a</code> 😂👍🙏❤️
              </span>
              <i className="peek-time">00:00</i>
            </div>
          </div>
          <div className="peek-foot">só espiando</div>
        </div>
      )}
    <AnimatePresence>
      {a && chat && (
        <motion.div
          key="peek"
          ref={card}
          className="peek-card"
          style={{ left: a.right + 10, y }}
          initial={{ opacity: 0, x: -12 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -6, transition: { duration: 0.12, ease: [0.4, 0, 1, 1] } }}
          transition={{ type: 'spring', stiffness: 520, damping: 36, mass: 0.8 }}
          aria-hidden
        >
          <div key={a.id} className="peek-swap">
            <div className="peek-head">
              <Avatar id={chat.id} name={chat.name} size={30} />
              <div className="peek-title">
                <b>{chat.name}</b>
                <small className={typingNow ? 'typing' : unread ? 'unread' : ''}>{sub}</small>
              </div>
            </div>
            <div className="peek-body">
              {msgs.length ? (
                msgs.map((m, i) => <Bubble key={m.id} m={m} group={group} i={i} n={msgs.length} unreadFrom={unreadFrom} />)
              ) : (
                <div className="peek-empty">{chat.preview || 'Nenhuma mensagem por aqui ainda'}</div>
              )}
              {typingNow && (
                <div className="peek-msg in typing-bubble">
                  <span className="dots">
                    <i />
                    <i />
                    <i />
                  </span>
                </div>
              )}
            </div>
            <div className="peek-foot">só espiando · não marca como lida</div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
    </>
  )
}
