// @mentions and phone numbers inside messages: shown by name, clickable → photo, name, number, "Conversar".
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { PersonInfo, UiMessage } from '@shared/types'
import { getState, openChat, setState, toast, zap } from '../state'
import { Avatar } from './Avatar'
import { Check, Copy, Eye, Reply } from './icons'

export const MentionCtx = createContext<UiMessage['mentions']>(undefined)

const isPhoneJid = (id: string) => id.endsWith('@s.whatsapp.net')
export const phoneOf = (id: string) => (isPhoneJid(id) ? '+' + id.split('@')[0] : undefined)

/** opens (or starts) the 1:1 chat with someone; numbers are checked with WhatsApp first (the extra-9 problem) */
export async function openPerson(id: string, name?: string) {
  if (!id || id.endsWith('@g.us')) return
  let target = id
  if (isPhoneJid(id) && getState().conn === 'open') {
    const real = await zap.resolveNumber(id.split('@')[0]).catch(() => undefined)
    if (real === null) return toast('Esse número não tem WhatsApp')
    if (real) target = real
  }
  const s = getState()
  if (!s.chats[target])
    setState({
      chats: {
        ...s.chats,
        [target]: { id: target, name: name || phoneOf(target) || target.split('@')[0], ts: Date.now(), unread: 0, pinned: 0, muted: false, archived: false, isGroup: false }
      }
    })
  void openChat(target)
}

// ---------- contact card: click a name/photo → name and full number, ready to copy ----------
type CardReq = { x: number; y: number; id: string; name: string; key: number }
let card: CardReq | null = null
const subs = new Set<() => void>()
const sub = (f: () => void) => {
  subs.add(f)
  return () => subs.delete(f)
}
const setCard = (c: CardReq | null) => {
  card = c
  subs.forEach((f) => f())
}

export function personMenu(e: { clientX: number; clientY: number }, p: { id: string; name: string }) {
  if (!p.id || p.id.endsWith('@g.us')) return
  setCard({ x: e.clientX, y: e.clientY, id: p.id, name: p.name, key: Date.now() })
}

function CopyRow({ label, value, copy, big }: { label: string; value: string; copy: string; big?: boolean }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className={'pc-row' + (big ? ' big' : '')}
      title="Clique pra copiar"
      onClick={() =>
        void navigator.clipboard.writeText(copy).then(() => {
          setDone(true)
          setTimeout(() => setDone(false), 1200)
        })
      }
    >
      <span className="pc-text">
        <small>{label}</small>
        <span className="pc-value">{value}</span>
      </span>
      <span className={'pc-copy' + (done ? ' done' : '')}>{done ? <Check size={14} strokeWidth={2.6} /> : <Copy size={14} />}</span>
    </button>
  )
}

function PersonCard({ c }: { c: CardReq }) {
  const ref = useRef<HTMLDivElement>(null)
  const [info, setInfo] = useState<PersonInfo | null>(null)
  const [pos, setPos] = useState({ x: c.x, y: c.y })
  useEffect(() => {
    let alive = true
    zap
      .person(c.id, c.name)
      .then((i) => alive && setInfo(i))
      .catch(() => alive && setInfo({ id: c.id, name: c.name, phone: phoneOf(c.id), phoneRaw: phoneOf(c.id) }))
    return () => {
      alive = false
    }
  }, [c.id, c.name])
  // stays inside the window
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({ x: Math.max(8, Math.min(c.x, innerWidth - r.width - 8)), y: c.y + r.height + 8 > innerHeight ? Math.max(8, c.y - r.height - 6) : c.y + 6 })
  }, [c.x, c.y, info])
  const id = info?.id ?? c.id
  const name = info?.name || c.name
  const other = [info?.savedName, info?.pushName].filter((n, i, a) => n && n !== name && a.indexOf(n) === i) as string[]
  const both = info?.phoneRaw ? `${name}\n${info.phone}` : name
  const close = () => setCard(null)
  return (
    <motion.div
      ref={ref}
      className="person-card"
      style={{ left: pos.x, top: pos.y }}
      initial={{ opacity: 0, scale: 0.96, y: -4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ type: 'spring', stiffness: 600, damping: 38 }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="pc-head">
        <button
          className="pc-photo"
          title="Ver foto"
          onClick={() => {
            close()
            window.dispatchEvent(new CustomEvent('zap:image', { detail: `zap://avatar/${encodeURIComponent(id)}?big=1` }))
          }}
        >
          <Avatar id={id} name={name} size={52} />
        </button>
        <div className="pc-names">
          <b>{name}</b>
          {other.map((n) => (
            <span key={n}>~{n}</span>
          ))}
        </div>
      </div>
      <CopyRow label="Nome" value={name} copy={name} />
      {info ? (
        info.phone ? (
          <CopyRow label="Número" value={info.phone} copy={info.phoneRaw ?? info.phone} big />
        ) : (
          <div className="pc-row muted">
            <span className="pc-text">
              <small>Número</small>
              <span className="pc-value">o WhatsApp não mostra o número dessa pessoa</span>
            </span>
          </div>
        )
      ) : (
        <div className="pc-row muted">
          <span className="pc-text">
            <small>Número</small>
            <span className="pc-value">buscando…</span>
          </span>
        </div>
      )}
      <div className="pc-actions">
        <button
          className="btn ghost sm"
          disabled={!info}
          onClick={() => void navigator.clipboard.writeText(both).then(() => toast(info?.phone ? 'Nome e número copiados' : 'Nome copiado'))}
        >
          <Copy size={14} /> Copiar tudo
        </button>
        <button
          className="btn primary sm"
          onClick={() => {
            close()
            void openPerson(id, name)
          }}
        >
          <Reply size={14} /> Conversar
        </button>
      </div>
    </motion.div>
  )
}

export function PersonCardHost() {
  const c = useSyncExternalStore(sub, () => card)
  useEffect(() => {
    if (!c) return
    const close = () => setCard(null)
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      close()
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('keydown', key, true)
    }
  }, [c])
  return <AnimatePresence>{c && <PersonCard key={c.key} c={c} />}</AnimatePresence>
}

/** "@5511999…" / "@2658028…" (WhatsApp's hidden id) → "@Nome" */
export function Mention({ token, raw }: { token: string; raw: string }) {
  const mentions = useContext(MentionCtx)
  const who = mentions?.[token]
  if (!who) return <>{raw}</>
  return (
    <button
      className="mention"
      onClick={(e) => {
        e.stopPropagation()
        personMenu(e, who)
      }}
    >
      @{who.name}
    </button>
  )
}

/** a phone number typed in a message */
export function PhoneText({ raw }: { raw: string }) {
  let digits = raw.replace(/\D/g, '')
  if (digits.length === 10 || digits.length === 11) digits = '55' + digits
  // only on WhatsApp accounts a number is a chat address
  const wa = (getState().accounts.find((a) => a.active)?.kind ?? 'wa') === 'wa'
  if (!wa || digits.length < 12 || digits.length > 15) return <>{raw}</>
  const id = digits + '@s.whatsapp.net'
  return (
    <button
      className="mention phone"
      onClick={(e) => {
        e.stopPropagation()
        personMenu(e, { id, name: getState().chats[id]?.name || raw.trim() })
      }}
    >
      {raw}
    </button>
  )
}
