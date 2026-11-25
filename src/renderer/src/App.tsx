import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, MotionConfig, motion } from 'motion/react'
import { boot, flatOrder, getState, openChat, setState, toast, useStore, zap, isLite } from './state'
import { applyAppearance } from './themes'
import { Sidebar } from './components/Sidebar'
import { ChatView } from './components/ChatView'
import { LockScreen, PinSetup } from './components/Lock'
import { Login } from './components/Login'
import { SettingsModal, updateSettings } from './components/Settings'
import { OverlayHost } from './components/overlays'
import { PersonCardHost } from './components/People'
import { preloadEmoji } from './components/Pickers'
import { Safe } from './components/Safe'
import { onWhisperFailed, onWhisperReady, watchTranscripts } from './transcribe'
import { FontPicker } from './components/FontPicker'
import { Shortcuts } from './components/Shortcuts'

function useNarrow() {
  const [narrow, setNarrow] = useState(() => window.innerWidth < 720)
  useEffect(() => {
    const on = () => setNarrow(window.innerWidth < 720)
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  return narrow
}

function drawBadge(n: number): string | null {
  if (!n) return null
  const c = document.createElement('canvas')
  c.width = c.height = 32
  const g = c.getContext('2d')!
  g.fillStyle = '#ff3b4f'
  g.beginPath()
  g.arc(16, 16, 15, 0, Math.PI * 2)
  g.fill()
  g.fillStyle = '#fff'
  g.font = `600 ${n > 99 ? 13 : n > 9 ? 16 : 19}px "SF Pro Display", "Segoe UI", sans-serif`
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(n > 99 ? '99+' : String(n), 16, 17)
  return c.toDataURL()
}

function Toast() {
  const t = useStore((s) => s.toast)
  useEffect(() => {
    if (!t) return
    const id = setTimeout(() => setState({ toast: undefined }), 2600)
    return () => clearTimeout(id)
  }, [t])
  return (
    <AnimatePresence>
      {t && (
        <motion.div key={t.id} className="toast" initial={{ opacity: 0, y: 12, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8 }} transition={{ type: 'spring', stiffness: 500, damping: 34 }}>
          {t.text}
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function Empty() {
  return (
    <section className="chat empty">
      <div className="chat-head drag" />
      <motion.div className="empty-state" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
        <div className="empty-logo" />
        <h2>Zapdesk</h2>
        <p>Escolha uma conversa — ou aperte <kbd>Ctrl</kbd>+<kbd>1</kbd>…<kbd>9</kbd></p>
      </motion.div>
    </section>
  )
}

export function App() {
  const ready = useStore((s) => s.ready)
  const conn = useStore((s) => s.conn)
  const me = useStore((s) => s.me)
  const chatsCount = useStore((s) => Object.keys(s.chats).length)
  const active = useStore((s) => (s.active ? s.chats[s.active] : undefined))
  const locked = useStore((s) => s.locked)
  const hasPin = useStore((s) => s.hasPin)
  const appearance = useStore((s) => s.settings?.appearance)
  const lite = useStore(isLite)
  // asked once, on a brand-new install; stays open (live preview) until "Pronto"
  const [fontAsk, setFontAsk] = useState(false)
  const fontAsked = useRef(false)
  useEffect(() => {
    if (!appearance || fontAsked.current) return
    fontAsked.current = true
    if (!appearance.font) setFontAsk(true)
  }, [appearance])
  const settingsOpen = useStore((s) => s.settingsOpen)
  const chats = useStore((s) => s.chats)
  const accounts = useStore((s) => s.accounts)
  const narrow = useNarrow()
  const [shortcuts, setShortcuts] = useState(false)
  const [, tick] = useState(0)

  useEffect(() => {
    void boot().then(preloadEmoji)
  }, [])

  useEffect(() => {
    if (appearance) applyAppearance(appearance, lite)
  }, [appearance, lite])

  // transcription engine finished (or failed) downloading: run / release the voice notes that were waiting
  const whisperReady = useStore((s) => s.whisper.ready)
  const whisperBusy = useStore((s) => s.whisper.progress !== null)
  const whisperErr = useStore((s) => s.whisper.error)
  useEffect(() => {
    if (whisperReady) onWhisperReady()
    else if (!whisperBusy) onWhisperFailed()
  }, [whisperReady, whisperBusy])
  useEffect(() => {
    if (whisperErr) toast('Download da transcrição falhou: ' + whisperErr)
  }, [whisperErr])
  // voice notes transcribed as they arrive, and long ones filling in while they're worked on
  useEffect(() => watchTranscripts(), [])

  const blur = useStore((s) => !!s.settings?.privacyBlur)
  useEffect(() => {
    document.documentElement.dataset.blur = blur ? '1' : ''
  }, [blur])

  const coveredNow = locked || (!hasPin && conn === 'open')
  useEffect(() => {
    if (coveredNow) (document.activeElement as HTMLElement | null)?.blur()
  }, [coveredNow])

  // activity → keeps the idle lock from kicking in while you use the app
  useEffect(() => {
    let last = 0
    const ping = () => {
      const now = Date.now()
      if (now - last > 10_000) {
        last = now
        zap.activity()
      }
    }
    const evs = ['mousemove', 'mousedown', 'keydown', 'wheel', 'focus'] as const
    evs.forEach((e) => window.addEventListener(e, ping, { passive: true }))
    const iv = setInterval(() => tick((n) => n + 1), 4000) // expires "digitando…"
    return () => {
      evs.forEach((e) => window.removeEventListener(e, ping))
      clearInterval(iv)
    }
  }, [])

  // taskbar badge
  useEffect(() => {
    const mine = Object.values(chats).reduce((n, c) => n + (c.muted || c.archived ? 0 : c.unread || (c.markedUnread ? 1 : 0)), 0)
    // the taskbar counts every account, not just the one on screen
    const total = mine + accounts.filter((x) => !x.active).reduce((n, x) => n + x.unread, 0)
    zap.setBadge(total, drawBadge(total))
    document.title = total ? `(${total}) Zapdesk` : 'Zapdesk'
  }, [chats, accounts])

  // keyboard shortcuts
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const s = getState()
      if (s.locked) return
      // accounts: Ctrl+Tab / Ctrl+Shift+Tab cycle (WhatsApp ⇄ Telegram…), Ctrl+Alt+1..9 jump
      // Alt+' (the key under Esc, "Backquote") as a one-hand alternative: Alt+Tab itself belongs to Windows
      if ((e.ctrlKey && e.key === 'Tab') || (e.altKey && !e.ctrlKey && e.code === 'Backquote')) {
        const list = s.accounts
        if (list.length > 1) {
          const i = Math.max(0, list.findIndex((a) => a.active))
          const next = list[(i + (e.shiftKey ? -1 : 1) + list.length) % list.length]
          toast('Trocando pra ' + next.label + (next.kind === 'tg' ? ' (Telegram)' : ''))
          void zap.switchAccount(next.id)
        } else toast('Só tem uma conta — adicione outra no rodapé (seu nome → Adicionar)')
        e.preventDefault()
        return
      }
      if (e.ctrlKey && e.altKey && /^[1-9]$/.test(e.key)) {
        const acc = s.accounts[+e.key - 1]
        if (acc && !acc.active) void zap.switchAccount(acc.id)
        e.preventDefault()
        return
      }
      if (e.ctrlKey && (e.key === '/' || e.key === ';' || e.code === 'Slash' || e.code === 'IntlRo')) {
        setShortcuts((v) => !v)
        e.preventDefault()
        return
      }
      if (e.ctrlKey && /^[1-9]$/.test(e.key)) {
        const id = flatOrder(s)[+e.key - 1]
        if (id) void openChat(id)
        e.preventDefault()
      } else if (e.ctrlKey && (e.key === 'k' || e.key === 'f')) {
        document.getElementById('open-search')?.click()
        e.preventDefault()
      } else if (e.ctrlKey && e.shiftKey && (e.key === 'B' || e.key === 'b')) {
        const on = !s.settings?.privacyBlur
        void updateSettings({ privacyBlur: on })
        toast(on ? 'Modo privacidade ligado 🙈' : 'Modo privacidade desligado')
        e.preventDefault()
      } else if (e.ctrlKey && e.key === 'l') {
        void zap.lockNow()
        e.preventDefault()
      } else if (e.ctrlKey && (e.key === '=' || e.key === '+' || e.key === '-' || e.key === '0')) {
        const cur = s.settings?.appearance.zoom ?? 1
        const zoom = e.key === '0' ? 1 : Math.round(Math.min(1.6, Math.max(0.7, cur + (e.key === '-' ? -0.05 : 0.05))) * 100) / 100
        void updateSettings({ appearance: { ...s.settings!.appearance, zoom } })
        e.preventDefault()
      } else if (e.ctrlKey && e.key === ',') {
        setState({ settingsOpen: !s.settingsOpen })
        e.preventDefault()
      } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        const order = flatOrder(s)
        const i = s.active ? order.indexOf(s.active) : -1
        const next = order[e.key === 'ArrowUp' ? Math.max(0, i - 1) : Math.min(order.length - 1, i + 1)]
        if (next) void openChat(next)
        e.preventDefault()
      } else if (e.key === 'Escape' && s.active && !e.defaultPrevented && (s.settings?.escClosesChat || narrow)) {
        // something else is open → Esc closes that first
        if (s.settingsOpen || s.replyTo || s.editing || s.mediaOpen || document.querySelector('.popover, .menu, .lightbox, .scrim, .dialog, .send-sheet, .media-drawer')) return
        ;(document.activeElement as HTMLElement | null)?.blur()
        void openChat(null)
      }
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [narrow])

  if (!ready) return <div className="boot" />

  const needLogin = !me && chatsCount === 0 && (conn === 'qr' || conn === 'connecting' || conn === 'reconnecting' || conn === 'loading' || conn === 'setup' || conn === 'password')
  const needPin = !locked && !hasPin && conn === 'open'
  // anything covering the app makes it inert: keystrokes (like PIN digits) must never reach the composer
  const covered = locked || needPin

  return (
    <MotionConfig reducedMotion={lite ? 'always' : 'user'}>
      <div className={'app' + (locked ? ' is-locked' : '')} inert={covered}>
        {needLogin ? (
          <Login />
        ) : (
          <div className={'shell' + (narrow ? ' narrow' : '') + (narrow && active ? ' show-chat' : '')}>
            {(!narrow || !active) && (
              <Safe name="sidebar" autoRetryMs={1500} fallback={<aside className="sidebar" />}>
                <Sidebar />
              </Safe>
            )}
            {active ? (
              <Safe name="chat" resetKey={active.id} fallback={<section className="chat empty"><div className="chat-head drag" /><div className="empty-state"><p>Não deu pra abrir essa conversa agora.</p><button className="btn" onClick={() => void openChat(null)}>Voltar</button></div></section>}>
                <ChatView chat={active} narrow={narrow} />
              </Safe>
            ) : (
              !narrow && <Empty />
            )}
          </div>
        )}
      </div>
      <AnimatePresence>{locked && <LockScreen key="lock" />}</AnimatePresence>
      <AnimatePresence>{needPin && <PinSetup key="setup" onDone={() => {}} />}</AnimatePresence>
      <AnimatePresence>{settingsOpen && !locked && <SettingsModal key="settings" />}</AnimatePresence>
      <AnimatePresence>{shortcuts && <Shortcuts key="sc" onClose={() => setShortcuts(false)} />}</AnimatePresence>
      {/* brand-new install: pick the font first (SF Pro isn't in the public build) */}
      <AnimatePresence>{fontAsk && appearance && !locked && <FontPicker key="font" a={appearance} onDone={() => setFontAsk(false)} />}</AnimatePresence>
      <OverlayHost />
      <PersonCardHost />
      <Toast />
    </MotionConfig>
  )
}
