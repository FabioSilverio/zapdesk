import { useEffect, useRef, useState } from 'react'
import { motion } from 'motion/react'
import data from '@emoji-mart/data'
import i18n from '@emoji-mart/data/i18n/pt.json'
import { Picker } from 'emoji-mart'
import { toast, useStore, zap } from '../state'
import { showMenu } from './overlays'
import { Refresh, StickerIcon, X } from './icons'

let handler: ((emoji: string) => void) | null = null
let cached: { el: HTMLElement; key: string } | null = null

function pickerEl(scheme: string, accent: string) {
  const key = scheme + accent
  if (cached?.key === key) return cached.el
  const el = new Picker({
    data,
    i18n,
    locale: 'pt',
    theme: scheme,
    set: 'native',
    previewPosition: 'none',
    skinTonePosition: 'search',
    navPosition: 'top',
    perLine: 8,
    emojiSize: 22,
    emojiButtonSize: 34,
    maxFrequentRows: 2,
    onEmojiSelect: (e: { native: string }) => handler?.(e.native)
  }) as unknown as HTMLElement
  const hex = accent.trim().replace('#', '')
  if (/^[0-9a-f]{6}$/i.test(hex)) {
    const n = parseInt(hex, 16)
    el.style.setProperty('--rgb-accent', `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`)
  }
  cached = { el, key }
  return el
}

/** warm up the picker after boot so the first open is instant */
export function preloadEmoji() {
  const s = document.documentElement.dataset.scheme ?? 'dark'
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent')
  setTimeout(() => pickerEl(s, accent), 1500)
}

const pop = {
  initial: { opacity: 0, y: 8, scale: 0.97 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: 6, scale: 0.98, transition: { duration: 0.1 } },
  transition: { duration: 0.16, ease: [0.2, 0.8, 0.2, 1] as const }
}

export function EmojiPopover({ onPick, onClose, style }: { onPick: (e: string) => void; onClose: () => void; style?: React.CSSProperties }) {
  const host = useRef<HTMLDivElement>(null)
  const theme = useStore((s) => s.settings?.appearance.theme)
  useEffect(() => {
    handler = onPick
    const scheme = document.documentElement.dataset.scheme ?? 'dark'
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent')
    const el = pickerEl(scheme, accent)
    host.current?.appendChild(el)
    requestAnimationFrame(() => (el.shadowRoot?.querySelector('input') as HTMLInputElement | null)?.focus())
    return () => {
      handler = null
      el.remove()
    }
  }, [onPick, theme])
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  return <motion.div {...pop} className="popover emoji-pop" style={style} ref={host} onMouseDown={(e) => e.stopPropagation()} />
}

export function StickerPopover({ chatId, onClose }: { chatId: string; onClose: () => void }) {
  const stickers = useStore((s) => s.stickers)
  const conn = useStore((s) => s.conn)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  const resync = async () => {
    setBusy(true)
    try {
      await zap.resyncStickers()
      toast('Figurinhas sincronizadas com a conta')
    } catch (e: any) {
      toast(e?.message ?? 'Falhou ao sincronizar')
    }
    setBusy(false)
  }
  return (
    <motion.div {...pop} className="popover sticker-pop" onMouseDown={(e) => e.stopPropagation()}>
      <div className="pop-head">
        <StickerIcon size={15} />
        <span>Figurinhas favoritas</span>
        <button className={'icon-btn sm' + (busy ? ' spin' : '')} title="Reimportar da conta" disabled={busy || conn !== 'open'} onClick={() => void resync()}>
          <Refresh size={15} />
        </button>
        <button className="icon-btn sm" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      {stickers.length ? (
        <div className="sticker-grid">
          {stickers.map((s) => (
            <button
              key={s.id}
              className="sticker-cell"
              disabled={!s.ready}
              title={s.source === 'account' ? 'Da sua conta' : 'Favoritada aqui'}
              onClick={() => {
                onClose()
                zap.sendSticker(chatId, s.id).catch((e) => toast(e?.message ?? 'Não enviou'))
              }}
              onContextMenu={(e) => showMenu(e, [{ label: 'Remover dos favoritos', danger: true, onClick: () => void zap.removeSticker(s.id) }])}
            >
              {s.ready ? <img src={`zap://sticker/${s.id}`} alt="" loading="lazy" draggable={false} /> : <span className="sticker-wait" />}
            </button>
          ))}
        </div>
      ) : (
        <div className="pop-empty">
          Nenhuma figurinha ainda.
          <br />
          As favoritas da sua conta chegam no primeiro sync — ou clique com o botão direito numa figurinha recebida → <b>Favoritar</b>.
        </div>
      )}
    </motion.div>
  )
}
