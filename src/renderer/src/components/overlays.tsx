import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Chevron } from './icons'

export interface MenuItem {
  label: string
  icon?: ReactNode
  danger?: boolean
  checked?: boolean
  onClick?: () => void
  sub?: MenuItem[]
  divider?: boolean
}

type MenuState = { x: number; y: number; items: MenuItem[]; key: number } | null
let menu: MenuState = null
let ask: {
  title: string
  placeholder?: string
  initial?: string
  type?: string
  multiline?: boolean
  confirm?: { body: string; ok: string; danger?: boolean }
  resolve: (v: string | null) => void
} | null = null

/** yes/no dialog; resolves true only on the explicit confirm button */
export function askConfirm(title: string, body: string, ok = 'Confirmar', danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    ask = { title, confirm: { body, ok, danger }, resolve: (v) => resolve(v === 'ok') }
    notify()
  })
}
const subs = new Set<() => void>()
const notify = () => subs.forEach((f) => f())
const sub = (f: () => void) => {
  subs.add(f)
  return () => subs.delete(f)
}

export function showMenu(e: { clientX: number; clientY: number; preventDefault?: () => void }, items: MenuItem[]) {
  e.preventDefault?.()
  menu = { x: e.clientX, y: e.clientY, items, key: Date.now() }
  notify()
}
export function closeMenu() {
  menu = null
  notify()
}
export function askText(title: string, placeholder?: string, initial?: string, type?: 'text' | 'datetime-local' | 'textarea'): Promise<string | null> {
  return new Promise((resolve) => {
    ask = { title, placeholder, initial, type: type === 'textarea' ? 'text' : type, multiline: type === 'textarea', resolve }
    notify()
  })
}

function Menu({ state }: { state: NonNullable<MenuState> }) {
  const ref = useRef<HTMLDivElement>(null)
  const [items, setItems] = useState(state.items)
  const [pos, setPos] = useState({ x: state.x, y: state.y })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      x: Math.max(8, Math.min(state.x, window.innerWidth - r.width - 8)),
      y: Math.max(8, Math.min(state.y, window.innerHeight - r.height - 8))
    })
  }, [items, state.x, state.y])
  return (
    <motion.div
      ref={ref}
      className="menu"
      style={{ left: pos.x, top: pos.y }}
      initial={{ opacity: 0, scale: 0.96, y: -4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.08 } }}
      transition={{ duration: 0.14, ease: [0.2, 0.8, 0.2, 1] }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) =>
        it.divider ? (
          <div key={i} className="menu-div" />
        ) : (
          <button
            key={i}
            className={'menu-item' + (it.danger ? ' danger' : '')}
            onClick={() => {
              if (it.sub) return setItems(it.sub)
              closeMenu()
              it.onClick?.()
            }}
          >
            <span className="menu-ic">{it.checked ? '✓' : it.icon}</span>
            <span className="menu-label">{it.label}</span>
            {it.sub && <Chevron size={14} />}
          </button>
        )
      )}
    </motion.div>
  )
}

function AskDialog({ a }: { a: NonNullable<typeof ask> }) {
  const [v, setV] = useState(a.initial ?? '')
  const done = (val: string | null) => {
    ask = null
    notify()
    a.resolve(val)
  }
  return (
    <motion.div className="scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={() => done(null)}>
      <motion.form
        className="dialog"
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.98 }}
        transition={{ type: 'spring', stiffness: 520, damping: 36 }}
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          done(a.confirm ? 'ok' : v.trim() || null)
        }}
        onKeyDown={(e) => e.key === 'Escape' && done(null)}
      >
        <h3>{a.title}</h3>
        {a.confirm ? (
          <>
            <p className="dialog-body">{a.confirm.body}</p>
            {/* focus lands on Cancelar: Enter never confirms a destructive action by accident */}
          </>
        ) : a.multiline ? (
          <textarea
            autoFocus
            rows={4}
            value={v}
            placeholder={a.placeholder}
            onChange={(e) => setV(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') done(null)
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) done(v.trim() || null)
            }}
          />
        ) : (
          <input autoFocus type={a.type ?? 'text'} value={v} placeholder={a.placeholder} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && done(null)} />
        )}
        <div className="dialog-actions">
          <button type="button" className="btn ghost" autoFocus={!!a.confirm} onClick={() => done(null)}>
            Cancelar
          </button>
          <button type="submit" className={'btn ' + (a.confirm?.danger ? 'danger solid' : 'primary')}>
            {a.confirm?.ok ?? 'OK'}
          </button>
        </div>
      </motion.form>
    </motion.div>
  )
}

export function OverlayHost() {
  const m = useSyncExternalStore(sub, () => menu)
  const a = useSyncExternalStore(sub, () => ask)
  useEffect(() => {
    if (!m) return
    const close = () => closeMenu()
    const key = (e: KeyboardEvent) => e.key === 'Escape' && closeMenu()
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('keydown', key)
    }
  }, [m])
  return (
    <>
      <AnimatePresence>{m && <Menu key={m.key} state={m} />}</AnimatePresence>
      <AnimatePresence>{a && <AskDialog key={a.title} a={a} />}</AnimatePresence>
    </>
  )
}
