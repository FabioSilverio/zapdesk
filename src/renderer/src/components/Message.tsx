import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { UiMessage } from '@shared/types'
import { colorOf, dayLabel, duration, firstUrl, isEmojiOnly, richBlocks, sameDay, timeOf } from '../format'
import { LinkCard } from './Links'
import { getState, openChat, setState, toast, useStore, zap, isLite } from '../state'
import { fmtWhen, pickCustomTime, timeChoices } from '../tools'
import { Avatar } from './Avatar'
import { askText, showMenu, type MenuItem } from './overlays'
import { Check, Checks, Clock, Copy, Doc, Eye, Pause, Pencil, Play, Plus, Reply, Smile, Star, TextLines } from './icons'
import { isVoice, transcribeMsg, useTranscript } from '../transcribe'
import { grabPoster, grabbedPoster, posterUrl } from '../posters'
import { MentionCtx, openPerson } from './People'

export const QUICK = ['👍', '❤️', '😂', '😮', '😢', '🙏']
/** Telegram only accepts its own reaction set (no 😂/😮): closest equivalents */
export const QUICK_TG = ['👍', '❤️', '🤣', '😱', '😢', '🙏']
export const quickFor = () => ((getState().accounts.find((a) => a.active)?.kind ?? 'wa') === 'tg' ? QUICK_TG : QUICK)

const mediaUrl = (m: UiMessage) => `zap://media/${encodeURIComponent(m.chatId)}/${encodeURIComponent(m.id)}`

function Ticks({ status }: { status?: number }) {
  if (!status || status <= 1) return <Clock size={11} className="tick" />
  if (status === 2) return <Check size={14} className="tick" />
  return <Checks size={16} className={'tick' + (status >= 4 ? ' read' : '')} />
}

// ---------- media downloaded ahead of time ----------
// one observer for every photo/video bubble: when it comes near the screen, the file starts downloading
// in the background (2 at a time, in main), so opening it is instant instead of "download, then play"
const PREFETCH_MAX = 40 * 1024 * 1024
const prefetchIO =
  typeof IntersectionObserver !== 'undefined'
    ? new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (!e.isIntersecting) continue
            const el = e.target as HTMLElement
            prefetchIO!.unobserve(el)
            if (el.dataset.chat && el.dataset.msg) zap.prefetch(el.dataset.chat, el.dataset.msg)
          }
        },
        { rootMargin: '600px 0px' }
      )
    : null
function prefetchable(m: UiMessage) {
  if (!m.hasMedia) return false
  if (m.size) return m.size <= PREFETCH_MAX
  // unknown size: photos yes, videos only when short
  return m.kind === 'image' || (m.seconds ?? 999) <= 120
}
function usePrefetch(m: UiMessage) {
  return useCallback(
    (el: HTMLElement | null) => {
      if (!el || !prefetchIO || !prefetchable(m)) return
      el.dataset.chat = m.chatId
      el.dataset.msg = m.id
      prefetchIO.observe(el)
      return () => prefetchIO.unobserve(el)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [m.chatId, m.id]
  )
}

function fit(w = 300, h = 300, max = 300, maxH = 340) {
  const r = Math.min(max / w, maxH / h, 1)
  return { width: Math.max(120, Math.round(w * r)), height: Math.max(80, Math.round(h * r)) }
}

function ImageBody({ m, onOpen }: { m: UiMessage; onOpen: (src: string) => void }) {
  const [ok, setOk] = useState(false)
  const size = fit(m.w, m.h)
  const pre = usePrefetch(m)
  return (
    <button ref={pre} className="media" style={{ ...size, backgroundImage: m.thumb ? `url(${m.thumb})` : undefined }} onClick={() => onOpen(mediaUrl(m))}>
      <img src={mediaUrl(m)} alt="" loading="lazy" decoding="async" className={ok ? 'in' : ''} onLoad={() => setOk(true)} draggable={false} />
      {!ok && <span className="media-spin" />}
    </button>
  )
}

const RATES = [1, 1.5, 2]
/** last speed you picked sticks for the next videos / voice notes */
let lastRate = 1
let audioRate = 1

/**
 * Sharp still for a video bubble. Stored one → shown right away. Telegram → its own thumbnail (main fetches it).
 * Otherwise, once the bubble is on screen, the first frame is grabbed from the (pre)downloaded file.
 */
function usePoster(m: UiMessage) {
  const tg = m.chatId.startsWith('tg:')
  const [src, setSrc] = useState<string | null>(() => (m.poster || tg ? posterUrl(m) : (grabbedPoster(m) ?? null)))
  const [ok, setOk] = useState(false)
  // lite mode: no decoding videos just for a still (the blurry thumbnail stays)
  const lite = useStore(isLite)
  const grabbable = !!m.hasMedia && prefetchable(m) && !lite
  const seen = useRef(false)
  const grabWhenVisible = useCallback(
    (el: HTMLElement | null) => {
      if (!el || src || !grabbable || seen.current || typeof IntersectionObserver === 'undefined') return
      const io = new IntersectionObserver(
        (es) => {
          if (!es.some((e) => e.isIntersecting)) return
          io.disconnect()
          seen.current = true
          void grabPoster(m).then((url) => url && setSrc(url))
        },
        { rootMargin: '300px 0px' }
      )
      io.observe(el)
      return () => io.disconnect()
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [src, m.chatId, m.id]
  )
  const onError = () => {
    // no stored/Telegram picture: fall back to grabbing the frame
    setSrc(null)
    setOk(false)
    if (grabbable) void grabPoster(m).then((url) => url && setSrc(url))
  }
  return { src, ok, onLoad: () => setOk(true), onError, ref: grabWhenVisible }
}

function VideoBody({ m }: { m: UiMessage }) {
  const [play, setPlay] = useState(false)
  const [rate, setRate] = useState(lastRate)
  const [loading, setLoading] = useState(true)
  const ref = useRef<HTMLVideoElement>(null)
  const size = fit(m.w, m.h, 340, 380)
  const pre = usePrefetch(m)
  const poster = usePoster(m)
  const bubbleRef = useCallback(
    (el: HTMLButtonElement | null) => {
      const a = pre(el)
      const b = poster.ref(el)
      return () => {
        a?.()
        b?.()
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pre, poster.ref]
  )
  if (play)
    return (
      <div className="video-wrap" style={size}>
        <video
          ref={ref}
          className="media"
          style={size}
          src={mediaUrl(m)}
          poster={poster.ok && poster.src ? poster.src : undefined}
          controls
          autoPlay
          playsInline
          preload="auto"
          loop={m.ptt}
          muted={m.ptt}
          onLoadedMetadata={(e) => {
            e.currentTarget.playbackRate = rate
            e.currentTarget.preservesPitch = true
          }}
          onCanPlay={() => setLoading(false)}
          onWaiting={() => setLoading(true)}
          onPlaying={() => setLoading(false)}
          onRateChange={(e) => setRate(e.currentTarget.playbackRate)}
        />
        {loading && <span className="media-spin video-spin" />}
        <button
          className="rate-pill"
          title="Velocidade"
          onClick={() => {
            const cur = ref.current?.playbackRate ?? rate
            const next = RATES[(RATES.indexOf(cur) + 1) % RATES.length] ?? 1
            lastRate = next
            setRate(next)
            if (ref.current) ref.current.playbackRate = next
          }}
        >
          {rate}×
        </button>
      </div>
    )
  return (
    <button
      ref={bubbleRef}
      className="media"
      style={{ ...size, backgroundImage: m.thumb ? `url(${m.thumb})` : undefined }}
      // pointing at it = about to click: download it first, before anything else in the queue
      onPointerEnter={() => m.hasMedia && zap.prefetch(m.chatId, m.id, true)}
      onClick={() => setPlay(true)}
    >
      {poster.src && <img src={poster.src} alt="" decoding="async" draggable={false} className={poster.ok ? 'in' : ''} onLoad={poster.onLoad} onError={poster.onError} />}
      <span className="play-badge">
        <Play size={20} />
      </span>
      {m.seconds ? <span className="media-dur">{duration(m.seconds)}</span> : null}
    </button>
  )
}

/** "Transcrever" + the text, under a voice note */
function Transcript({ m }: { m: UiMessage }) {
  const tr = useTranscript(m)
  const auto = useStore((s) => !!s.settings?.autoTranscribe && s.whisper.ready && !isLite(s))
  const dl = useStore((s) => s.whisper.progress)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    // auto mode: only fresh voice notes from others, never the whole history
    if (auto && isVoice(m) && !m.fromMe && tr.text === undefined && !tr.busy && !tr.error && Date.now() - m.ts < 7 * 86400_000) void transcribeMsg(m, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, m.id])
  if (tr.busy && tr.partial)
    return (
      <div className="transcript partial">
        {tr.partial}
        <span className="dots">
          <i />
          <i />
          <i />
        </span>
      </div>
    )
  if (tr.busy)
    return (
      <div className="transcript busy">
        <span className="dots">
          <i />
          <i />
          <i />
        </span>
        {dl !== null ? `baixando transcrição ${dl}%` : 'transcrevendo…'}
      </div>
    )
  if (tr.error)
    return (
      <button className="transcript error" onClick={() => void transcribeMsg(m)}>
        {tr.error} · tentar de novo
      </button>
    )
  if (tr.text === undefined) return null
  const long = tr.text.length > 260
  return (
    <div className={'transcript' + (long && !open ? ' clamp' : '')} onClick={() => long && setOpen((v) => !v)}>
      {tr.text || <i className="dim">sem fala reconhecível nesse áudio</i>}
    </div>
  )
}

function AudioBody({ m }: { m: UiMessage }) {
  const ref = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [t, setT] = useState(0)
  const [rate, _setRate] = useState(audioRate)
  // ref mirrors state so fast clicks never read a stale speed
  const rateRef = useRef(audioRate)
  const setRate = (r: number) => {
    rateRef.current = r
    _setRate(r)
  }
  const total = m.seconds || ref.current?.duration || 0
  const toggle = () => {
    const a = ref.current
    if (!a) return
    if (!a.getAttribute('src')) a.src = mediaUrl(m)
    a.defaultPlaybackRate = rateRef.current
    a.playbackRate = rateRef.current
    if (a.paused) void a.play().catch(() => toast('Não deu pra tocar esse áudio'))
    else a.pause()
  }
  const tr = useTranscript(m)
  return (
    <>
    <div className={'audio' + (m.ptt ? ' ptt' : '')}>
      <button className="audio-btn" onClick={toggle}>
        {playing ? <Pause size={16} /> : <Play size={16} />}
      </button>
      <div
        className="audio-bar"
        onClick={(e) => {
          const a = ref.current
          if (!a || !a.duration) return
          const r = e.currentTarget.getBoundingClientRect()
          a.currentTime = ((e.clientX - r.left) / r.width) * a.duration
        }}
      >
        <i style={{ width: total ? `${(t / total) * 100}%` : 0 }} />
      </div>
      <span className="audio-time">{duration(playing || t ? t : total)}</span>
      <button
        className={'audio-rate' + (rate !== 1 ? ' on' : '')}
        title="Velocidade (1× · 1,5× · 2×)"
        onClick={() => {
          const cur = rateRef.current
          const next = cur >= 2 ? 1 : cur + 0.5
          audioRate = next
          if (ref.current) {
            ref.current.defaultPlaybackRate = next
            ref.current.playbackRate = next
          }
          setRate(next)
        }}
      >
        {String(rate).replace('.', ',')}×
      </button>
      <audio
        ref={ref}
        preload="none"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false)
          setT(0)
        }}
        onTimeUpdate={(e) => setT(e.currentTarget.currentTime)}
      />
      {tr.text === undefined && !tr.busy && !tr.error && (
        <button className="audio-tr" title="Transcrever (roda no seu PC)" onClick={() => void transcribeMsg(m)}>
          <TextLines size={15} />
        </button>
      )}
    </div>
    <Transcript m={m} />
    </>
  )
}

function Body({ m, onOpen }: { m: UiMessage; onOpen: (src: string) => void }) {
  switch (m.kind) {
    case 'image':
      return <ImageBody m={m} onOpen={onOpen} />
    case 'video':
      return <VideoBody m={m} />
    case 'audio':
      return <AudioBody m={m} />
    case 'sticker':
      return m.hasMedia ? (
        <img className="sticker" src={mediaUrl(m)} alt="figurinha" loading="lazy" draggable={false} style={{ aspectRatio: `${m.w ?? 1}/${m.h ?? 1}` }} />
      ) : (
        <div className="sticker sticker-missing">figurinha animada</div>
      )
    case 'document':
      return (
        <button className="doc" onClick={() => zap.openMedia(m.chatId, m.id).catch(() => toast('Não consegui baixar o arquivo'))}>
          <Doc size={22} />
          <span className="doc-name">{m.fileName}</span>
          <span className="doc-ext">{(m.fileName?.split('.').pop() ?? '').toUpperCase().slice(0, 5)}</span>
        </button>
      )
    case 'location':
      return (
        <a className="loc" href={m.fileName} target="_blank" rel="noreferrer">
          {m.thumb && <img src={m.thumb} alt="" />}
          <span>📍 {m.text}</span>
        </a>
      )
    default:
      return null
  }
}

interface Props {
  m: UiMessage
  prev?: UiMessage
  isGroup: boolean
  fresh: boolean
  onOpenImage: (src: string) => void
  onReactMore: (m: UiMessage, x: number, y: number) => void
}

export const Message = memo(function Message({ m, prev, isGroup, fresh, onOpenImage, onReactMore }: Props) {
  const listMode = useStore((s) => s.settings?.appearance.messages === 'lista')
  const chatName = useStore((s) => s.chats[m.chatId]?.name)
  const meId = useStore((s) => s.me?.id)
  const showDay = !prev || !sameDay(prev.ts, m.ts)
  const grouped = !showDay && prev && prev.fromMe === m.fromMe && prev.sender === m.sender && prev.kind !== 'system' && m.ts - prev.ts < 5 * 60_000

  const day = showDay ? (
    <div className="day-sep">
      <span>{dayLabel(m.ts)}</span>
    </div>
  ) : null

  if (m.kind === 'system')
    return (
      <div className="msg-wrap">
        {day}
        {m.text ? <div className="sys-msg">{m.text}</div> : null}
      </div>
    )

  const react = (e: string) => zap.react(m.chatId, m.id, e).catch((err) => toast(err?.message ?? 'Não reagiu'))
  const reply = () => setState({ replyTo: m })
  const emojiOnly = m.kind === 'text' && isEmojiOnly(m.text)
  const bare = m.kind === 'sticker' || emojiOnly
  const hasCaption = m.text && m.kind !== 'text' && m.kind !== 'location' && m.kind !== 'deleted' && m.kind !== 'unknown'
  // group members get their profile photo (lista mode: everyone, you included)
  const showAvatar = (isGroup && !m.fromMe) || listMode
  const avatarId = m.fromMe ? (meId ?? '') : (m.sender ?? m.chatId)
  const avatarName = m.fromMe ? 'Você' : (isGroup ? m.senderName : chatName) || '?'
  const linkUrl = m.link?.url ?? (m.kind === 'text' ? firstUrl(m.text) : undefined)

  const remindAt = (at: number | null) => {
    if (!at) return
    void zap.remind(m.chatId, m.id, at).then(() => toast(`⏰ Vou te lembrar ${fmtWhen(at)}`))
  }

  const menu = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('a')) return
    const items: MenuItem[] = [
      { label: 'Responder', icon: <Reply size={15} />, onClick: reply },
      { label: 'Reagir…', icon: <Smile size={15} />, onClick: () => onReactMore(m, e.clientX, e.clientY) }
    ]
    if (m.text) items.push({ label: 'Copiar texto', icon: <Copy size={15} />, onClick: () => void navigator.clipboard.writeText(m.text!).then(() => toast('Copiado')) })
    if (m.kind === 'audio') {
      const t = m.transcript ?? undefined
      items.push({ label: t !== undefined ? 'Transcrever de novo' : 'Transcrever áudio', icon: <TextLines size={15} />, onClick: () => void transcribeMsg(m) })
    }
    if (m.kind === 'image') items.push({ label: 'Copiar imagem', icon: <Copy size={15} />, onClick: () => void copyImage(m) })
    items.push({
      label: 'Lembrar disso…',
      icon: <Clock size={15} />,
      sub: [
        ...timeChoices().map((c) => ({ label: c.label, onClick: () => remindAt(c.at) })),
        { divider: true, label: '' },
        { label: 'Escolher data e hora…', onClick: () => void pickCustomTime('Lembrar desta mensagem em').then(remindAt) }
      ]
    })
    if (m.fromMe && (m.status ?? 0) <= 1 && Date.now() - m.ts > 15_000 && m.kind !== 'deleted')
      items.unshift({ label: 'Reenviar (ficou pendente)', icon: <Clock size={15} />, onClick: () => zap.resend(m.chatId, m.id).then(() => toast('Reenviada ✓')).catch((e) => toast(String(e?.message ?? e).replace(/^Error invoking remote method '\w+': (Error: )?/, ''))) })
    if (m.originalText) items.push({ label: 'Ver texto original', icon: <Eye size={15} />, onClick: () => void askText('Antes de editar estava assim:', undefined, m.originalText, 'textarea') })
    if (m.kind === 'sticker' && m.hasMedia)
      items.push({
        label: m.stickerFav ? 'Remover dos favoritos' : 'Favoritar figurinha',
        icon: <Star size={15} />,
        onClick: () => zap.favSticker(m.chatId, m.id, !m.stickerFav).then(() => toast(m.stickerFav ? 'Removida dos favoritos' : 'Figurinha favoritada ⭐'))
      })
    if (m.hasMedia && m.kind !== 'sticker') items.push({ label: 'Abrir / salvar', icon: <Doc size={15} />, onClick: () => void zap.openMedia(m.chatId, m.id) })
    if (isGroup && !m.fromMe && m.sender) items.push({ label: `Conversar com ${m.senderName?.split(' ')[0] ?? 'contato'}`, onClick: () => openPerson(m.sender!, m.senderName) })
    showMenu(e, items)
  }

  return (
    <div className={'msg-wrap' + (grouped ? ' grouped' : '') + (showAvatar ? ' with-av' : '')}>
      {day}
      <div className={'msg ' + (m.fromMe ? 'out' : 'in') + (fresh ? ' fresh' : '') + (m.revoked ? ' revoked' : '')} onContextMenu={menu} onDoubleClick={reply}>
        {showAvatar && (
          <div className="msg-av">
            {!grouped && (
              <button title={m.fromMe ? 'Você' : `${avatarName} — clique pra conversar em particular`} onClick={() => !m.fromMe && isGroup && openPerson(avatarId, avatarName)}>
                <Avatar id={avatarId} name={avatarName} size={30} />
              </button>
            )}
          </div>
        )}
        <div className="msg-col">
          {!grouped && (listMode || (isGroup && !m.fromMe)) && (
            <div className="sender" style={{ color: m.fromMe ? 'var(--accent)' : colorOf(m.sender ?? m.chatId) }}>
              {m.fromMe ? 'Você' : isGroup ? m.senderName : chatName}
              {listMode && <span className="sender-time">{timeOf(m.ts)}</span>}
            </div>
          )}
          <div className="msg-line">
            <div className={'bubble' + (bare ? ' bare' : '') + (m.kind === 'deleted' ? ' deleted' : '') + (m.kind === 'unknown' ? ' unknown' : '') + (emojiOnly ? ' emoji-only' : '') + (m.kind === 'image' || m.kind === 'video' ? ' has-media' : '')}>
              {m.revoked && <div className="revoked-tag">🚫 {m.fromMe ? 'você apagou pra todos' : 'apagada pra todos'} · guardada pelo Zapdesk</div>}
              {m.quoted && (
                <div className="quote">
                  <b>{m.quoted.senderName || 'Mensagem'}</b>
                  <span>{m.quoted.text}</span>
                </div>
              )}
              <Body m={m} onOpen={onOpenImage} />
              <MentionCtx.Provider value={m.mentions}>
                {(m.kind === 'text' || m.kind === 'deleted' || m.kind === 'unknown' || m.kind === 'poll' || m.kind === 'contact') && (
                  <div className="text">{m.kind === 'text' ? richBlocks(m.text ?? '') : m.text}</div>
                )}
                {hasCaption && <div className="text caption">{richBlocks(m.text!)}</div>}
              </MentionCtx.Provider>
              {m.kind === 'text' && linkUrl && <LinkCard url={linkUrl} embedded={m.link} />}
              <span className="meta">
                {m.edited && (
                  <button
                    type="button"
                    className={'edited-tag' + (m.originalText ? ' has-orig' : '')}
                    title={m.originalText ? 'Editada · clique pra ver como era antes' : 'Mensagem editada'}
                    onClick={(e) => {
                      e.stopPropagation()
                      if (m.originalText) void askText('Antes de editar estava assim:', undefined, m.originalText, 'textarea')
                    }}
                    onDoubleClick={(e) => e.stopPropagation()}
                  >
                    <Pencil size={10} />
                    editada
                  </button>
                )}
                {timeOf(m.ts)}
                {m.fromMe && <Ticks status={m.status} />}
              </span>
            </div>
            {m.kind !== 'deleted' && (
              <div className="hover-bar">
                {quickFor().slice(0, 3).map((e) => (
                  <button key={e} onClick={() => void react(e)}>
                    {e}
                  </button>
                ))}
                <button title="Mais reações" onClick={(ev) => onReactMore(m, ev.clientX, ev.clientY)}>
                  <Plus size={14} />
                </button>
                <button title="Responder" onClick={reply}>
                  <Reply size={14} />
                </button>
              </div>
            )}
          </div>
          <AnimatePresence initial={false}>
            {m.reactions?.length ? (
              <motion.div className="reactions" initial={{ opacity: 0, scale: 0.6, y: -4 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.6 }} transition={{ type: 'spring', stiffness: 600, damping: 28 }}>
                {m.reactions.map((r) => (
                  <motion.button layout key={r.e} className={'reaction' + (r.by.includes('me') ? ' mine' : '')} onClick={() => void react(r.e)} title={r.by.length + (r.by.length > 1 ? ' pessoas' : ' pessoa')}>
                    {r.e}
                    {r.by.length > 1 && <span>{r.by.length}</span>}
                  </motion.button>
                ))}
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
})

async function copyImage(m: UiMessage) {
  try {
    const blob = await (await fetch(mediaUrl(m))).blob()
    const png = await createImageBitmap(blob).then((bmp) => {
      const c = document.createElement('canvas')
      c.width = bmp.width
      c.height = bmp.height
      c.getContext('2d')!.drawImage(bmp, 0, 0)
      return new Promise<Blob>((res) => c.toBlob((b) => res(b!), 'image/png'))
    })
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
    toast('Imagem copiada')
  } catch {
    toast('Não consegui copiar a imagem')
  }
}
