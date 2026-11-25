import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { SharedItems, SharedLink, UiChat, UiMessage } from '@shared/types'
import { loadOlder, toast, useStore, zap } from '../state'
import { duration } from '../format'
import { hostOf, linkMenu, prettyUrl, useLinkMeta } from './Links'
import { grabPoster, grabbedPoster, posterUrl } from '../posters'
import { Back, Chevron, Copy, Doc, DownloadIcon, LinkIcon, PhotoIcon, Play, Search, X } from './icons'

type Tab = 'media' | 'links' | 'docs'

const mediaUrl = (m: UiMessage) => `zap://media/${encodeURIComponent(m.chatId)}/${encodeURIComponent(m.id)}`
const monthFmt = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' })
const dateFmt = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })

function fmtBytes(n?: number) {
  if (!n || n <= 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 ** 3) return `${(n / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`
  return `${(n / 1024 ** 3).toFixed(2).replace('.', ',')} GB`
}

function groupByMonth<T extends { ts: number }>(items: T[]): { key: string; label: string; items: T[] }[] {
  const out: { key: string; label: string; items: T[] }[] = []
  let cur: { key: string; label: string; items: T[] } | null = null
  for (const it of items) {
    const d = new Date(it.ts || 0)
    const key = `${d.getFullYear()}-${d.getMonth()}`
    if (!cur || cur.key !== key) {
      const raw = it.ts ? monthFmt.format(d) : 'Sem data'
      cur = { key, label: raw ? raw[0].toUpperCase() + raw.slice(1) : raw, items: [] }
      out.push(cur)
    }
    cur.items.push(it)
  }
  return out
}

const tileIO =
  typeof IntersectionObserver !== 'undefined'
    ? new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (!e.isIntersecting) continue
            const el = e.target as HTMLElement
            tileIO!.unobserve(el)
            if (el.dataset.chat && el.dataset.msg) zap.prefetch(el.dataset.chat, el.dataset.msg)
          }
        },
        { rootMargin: '400px 0px' }
      )
    : null

const MediaTile = memo(function MediaTile({ m, onOpen }: { m: UiMessage; onOpen: (m: UiMessage) => void }) {
  const isVideo = m.kind === 'video'
  const tg = m.chatId.startsWith('tg:')
  const [src, setSrc] = useState<string | null>(() => (isVideo ? (m.poster || tg ? posterUrl(m) : (grabbedPoster(m) ?? null)) : mediaUrl(m)))
  const [ok, setOk] = useState(false)
  const grabbed = useRef(false)

  const ref = useCallback(
    (el: HTMLButtonElement | null) => {
      if (!el || !m.hasMedia) return
      if (!isVideo && tileIO) {
        el.dataset.chat = m.chatId
        el.dataset.msg = m.id
        tileIO.observe(el)
        return () => tileIO.unobserve(el)
      }
      if (isVideo && !src && !grabbed.current && typeof IntersectionObserver !== 'undefined' && (m.size ?? 0) <= 40 * 1024 * 1024) {
        const io = new IntersectionObserver(
          (es) => {
            if (!es.some((e) => e.isIntersecting)) return
            io.disconnect()
            grabbed.current = true
            void grabPoster(m).then((u) => u && setSrc(u))
          },
          { rootMargin: '250px 0px' }
        )
        io.observe(el)
        return () => io.disconnect()
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [m.chatId, m.id, isVideo, src]
  )

  return (
    <button
      ref={ref}
      type="button"
      className="media-tile"
      style={{ backgroundImage: m.thumb ? `url(${m.thumb})` : undefined }}
      title={[m.fromMe ? 'Você' : m.senderName, m.ts ? dateFmt.format(m.ts) : '', m.text].filter(Boolean).join(' · ')}
      onPointerEnter={() => isVideo && m.hasMedia && zap.prefetch(m.chatId, m.id, true)}
      onClick={() => onOpen(m)}
    >
      {src && (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          className={ok ? 'in' : ''}
          onLoad={() => setOk(true)}
          onError={() => {
            if (isVideo) {
              setSrc(null)
              setOk(false)
              if (!grabbed.current && (m.size ?? 0) <= 40 * 1024 * 1024) {
                grabbed.current = true
                void grabPoster(m).then((u) => u && setSrc(u))
              }
            }
          }}
        />
      )}
      {isVideo && (
        <span className="tile-video-badge">
          <Play size={11} />
          {m.seconds ? <span>{duration(m.seconds)}</span> : null}
        </span>
      )}
    </button>
  )
})

const LinkRow = memo(function LinkRow({ item }: { item: SharedLink }) {
  const fetched = useLinkMeta(item.title && item.thumb ? undefined : item.url)
  const title = item.title ?? fetched?.title
  const thumb = item.thumb ?? fetched?.thumb
  const host = fetched?.site || hostOf(item.url)
  return (
    <div className="shared-link-row" onContextMenu={(e) => linkMenu(e, item.url)}>
      <a className="shared-link-main" href={item.url} target="_blank" rel="noreferrer" title={item.url}>
        <span className={'shared-link-thumb' + (thumb ? ' img' : '')}>
          {thumb ? <img src={thumb} alt="" loading="lazy" draggable={false} /> : <LinkIcon size={16} />}
        </span>
        <span className="shared-link-body">
          <b className="shared-link-title">{title || prettyUrl(item.url)}</b>
          <span className="shared-link-url">{title ? prettyUrl(item.url) : host}</span>
          <span className="shared-link-meta">
            {item.senderName ? item.senderName + ' · ' : ''}
            {item.ts ? dateFmt.format(item.ts) : ''}
          </span>
        </span>
      </a>
      <button
        type="button"
        className="icon-btn sm shared-link-copy"
        title="Copiar link"
        onClick={() => void navigator.clipboard.writeText(item.url).then(() => toast('Link copiado'))}
      >
        <Copy size={14} />
      </button>
    </div>
  )
})

async function copyImg(m: UiMessage) {
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

function GalleryLightbox({ list, index, onChange, onClose }: { list: UiMessage[]; index: number; onChange: (i: number) => void; onClose: () => void }) {
  const m = list[index]
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      } else if (e.key === 'ArrowLeft' && index > 0) {
        e.preventDefault()
        onChange(index - 1)
      } else if (e.key === 'ArrowRight' && index < list.length - 1) {
        e.preventDefault()
        onChange(index + 1)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [index, list.length, onChange, onClose])

  if (!m) return null
  const who = m.fromMe ? 'Você' : m.senderName || ''

  return (
    <motion.div className="lightbox gallery-box" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <div className="gallery-top" onClick={(e) => e.stopPropagation()}>
        <div className="gallery-info">
          <b>{who || 'Mídia'}</b>
          <span>
            {m.ts ? dateFmt.format(m.ts) : ''}
            {list.length > 1 ? ` · ${index + 1} de ${list.length}` : ''}
          </span>
        </div>
        <div className="gallery-actions">
          {m.kind === 'image' && (
            <button type="button" className="icon-btn" title="Copiar imagem" onClick={() => void copyImg(m)}>
              <Copy size={16} />
            </button>
          )}
          <button
            type="button"
            className="icon-btn"
            title="Abrir / salvar"
            onClick={() => void zap.openMedia(m.chatId, m.id).catch(() => toast('Não consegui abrir a mídia'))}
          >
            <DownloadIcon size={16} />
          </button>
          <button type="button" className="icon-btn" title="Fechar (Esc)" onClick={onClose}>
            <X size={17} />
          </button>
        </div>
      </div>

      {index > 0 && (
        <button
          type="button"
          className="gallery-nav prev"
          title="Mais recente (←)"
          onClick={(e) => {
            e.stopPropagation()
            onChange(index - 1)
          }}
        >
          <Back size={22} />
        </button>
      )}
      {index < list.length - 1 && (
        <button
          type="button"
          className="gallery-nav next"
          title="Mais antiga (→)"
          onClick={(e) => {
            e.stopPropagation()
            onChange(index + 1)
          }}
        >
          <Chevron size={22} />
        </button>
      )}

      <div className="gallery-stage" onClick={(e) => e.stopPropagation()}>
        {m.kind === 'video' ? (
          <video key={m.id} src={mediaUrl(m)} controls autoPlay playsInline loop={m.ptt} className="gallery-media" />
        ) : (
          <motion.img
            key={m.id}
            src={mediaUrl(m)}
            alt=""
            className="gallery-media"
            initial={{ opacity: 0.5, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.16 }}
          />
        )}
      </div>

      {m.text && (
        <div className="gallery-caption" onClick={(e) => e.stopPropagation()}>
          {m.text}
        </div>
      )}
    </motion.div>
  )
}

export function ChatMedia({ chat, onClose }: { chat: UiChat; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('media')
  const [data, setData] = useState<SharedItems | null>(null)
  const [q, setQ] = useState('')
  const [limit, setLimit] = useState(90)
  const [viewer, setViewer] = useState<number | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const thread = useStore((s) => s.threads[chat.id])
  const msgCount = thread?.list.length ?? 0

  const reload = useCallback(() => {
    void zap
      .shared(chat.id)
      .then((res) => setData(res))
      .catch(() => setData({ media: [], docs: [], links: [], totalMsgs: 0 }))
  }, [chat.id])

  useEffect(() => {
    setData(null)
    setQ('')
    setLimit(90)
    setViewer(null)
    reload()
  }, [chat.id, reload])

  // live updates when new messages or older history arrive while the drawer is open
  useEffect(() => {
    if (msgCount > 0) reload()
  }, [msgCount, reload])

  // Escape closes the drawer (when the gallery lightbox isn't open)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && viewer === null && !document.querySelector('.menu, .dialog, .scrim')) {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [viewer, onClose])

  const term = q.trim().toLowerCase()
  const filteredMedia = useMemo(() => {
    const list = data?.media ?? []
    if (!term) return list
    return list.filter((m) => (m.text ?? '').toLowerCase().includes(term) || (m.senderName ?? '').toLowerCase().includes(term))
  }, [data?.media, term])

  const filteredLinks = useMemo(() => {
    const list = data?.links ?? []
    if (!term) return list
    return list.filter(
      (l) =>
        l.url.toLowerCase().includes(term) ||
        (l.title ?? '').toLowerCase().includes(term) ||
        (l.text ?? '').toLowerCase().includes(term) ||
        (l.senderName ?? '').toLowerCase().includes(term)
    )
  }, [data?.links, term])

  const filteredDocs = useMemo(() => {
    const list = data?.docs ?? []
    if (!term) return list
    return list.filter(
      (d) => (d.fileName ?? '').toLowerCase().includes(term) || (d.text ?? '').toLowerCase().includes(term) || (d.senderName ?? '').toLowerCase().includes(term)
    )
  }, [data?.docs, term])

  const activeList = tab === 'media' ? filteredMedia : tab === 'links' ? filteredLinks : filteredDocs
  const mediaGroups = useMemo(() => groupByMonth(filteredMedia.slice(0, limit)), [filteredMedia, limit])
  const linkGroups = useMemo(() => groupByMonth(filteredLinks.slice(0, limit)), [filteredLinks, limit])
  const docGroups = useMemo(() => groupByMonth(filteredDocs.slice(0, limit)), [filteredDocs, limit])

  const fetchHistory = async () => {
    if (loadingMore) return
    setLoadingMore(true)
    try {
      await loadOlder(chat.id)
      // give WhatsApp/Telegram a moment to deliver history-sync messages into the store
      setTimeout(() => {
        reload()
        setLoadingMore(false)
      }, 900)
    } catch {
      setLoadingMore(false)
    }
  }

  return (
    <>
      <motion.aside
        className="media-drawer"
        initial={{ x: 32, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: 32, opacity: 0 }}
        transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
      >
        <div className="media-drawer-head">
          <div className="media-drawer-title">
            <b>Mídias, links e docs</b>
            <span>{chat.name}</span>
          </div>
          <button type="button" className="icon-btn sm" title="Fechar (Esc)" onClick={onClose}>
            <X size={15} />
          </button>
        </div>

        <div className="media-tabs">
          {(
            [
              ['media', 'Mídias', data?.media.length ?? 0],
              ['links', 'Links', data?.links.length ?? 0],
              ['docs', 'Arquivos', data?.docs.length ?? 0]
            ] as const
          ).map(([id, label, count]) => (
            <button
              key={id}
              type="button"
              className={'media-tab' + (tab === id ? ' on' : '')}
              onClick={() => {
                setTab(id)
                setLimit(90)
              }}
            >
              {tab === id && <motion.span layoutId="media-tab-pill" className="media-tab-pill" transition={{ type: 'spring', stiffness: 520, damping: 38 }} />}
              <span className="media-tab-label">
                {label}
                {data && <i className="media-tab-count">{count}</i>}
              </span>
            </button>
          ))}
        </div>

        {((tab === 'links' && (data?.links.length ?? 0) > 4) || (tab === 'docs' && (data?.docs.length ?? 0) > 4) || (tab === 'media' && (data?.media.length ?? 0) > 12)) && (
          <div className="media-search">
            <Search size={14} />
            <input
              value={q}
              placeholder={tab === 'links' ? 'Filtrar links ou remetente…' : tab === 'docs' ? 'Filtrar arquivos…' : 'Filtrar por legenda ou quem mandou…'}
              onChange={(e) => setQ(e.target.value)}
            />
            {q && (
              <button type="button" className="icon-btn sm" onClick={() => setQ('')}>
                <X size={12} />
              </button>
            )}
          </div>
        )}

        <div className="media-drawer-body">
          {!data ? (
            <div className="media-empty">
              <span className="media-spin" />
            </div>
          ) : tab === 'media' ? (
            filteredMedia.length ? (
              mediaGroups.map((g) => (
                <div key={g.key} className="media-group">
                  <div className="media-group-head">{g.label}</div>
                  <div className="media-grid">
                    {g.items.map((m) => (
                      <MediaTile
                        key={m.id}
                        m={m}
                        onOpen={(picked) => {
                          const idx = filteredMedia.findIndex((x) => x.id === picked.id)
                          if (idx >= 0) setViewer(idx)
                        }}
                      />
                    ))}
                  </div>
                </div>
              ))
            ) : (
              <div className="media-empty">
                <PhotoIcon size={28} />
                <span>{term ? 'Nenhuma mídia encontrada pra essa busca' : 'Nenhuma foto ou vídeo guardado nessa conversa ainda'}</span>
              </div>
            )
          ) : tab === 'links' ? (
            filteredLinks.length ? (
              linkGroups.map((g) => (
                <div key={g.key} className="media-group">
                  <div className="media-group-head">{g.label}</div>
                  <div className="shared-list">
                    {g.items.map((l) => (
                      <LinkRow key={l.id} item={l} />
                    ))}
                  </div>
                </div>
              ))
            ) : (
              <div className="media-empty">
                <LinkIcon size={26} />
                <span>{term ? 'Nenhum link encontrado pra essa busca' : 'Nenhum link guardado nessa conversa ainda'}</span>
              </div>
            )
          ) : filteredDocs.length ? (
            docGroups.map((g) => (
              <div key={g.key} className="media-group">
                <div className="media-group-head">{g.label}</div>
                <div className="shared-list">
                  {g.items.map((d) => {
                    const ext = (d.fileName?.split('.').pop() ?? '').toUpperCase().slice(0, 5)
                    const sz = fmtBytes(d.size)
                    return (
                      <button
                        key={d.id}
                        type="button"
                        className="shared-doc-row"
                        onClick={() => void zap.openMedia(d.chatId, d.id).catch(() => toast('Não consegui baixar o arquivo'))}
                      >
                        <span className="shared-doc-ic">
                          <Doc size={18} />
                          {ext && <i>{ext}</i>}
                        </span>
                        <span className="shared-doc-body">
                          <b>{d.fileName || 'Documento'}</b>
                          <span>
                            {[sz, d.fromMe ? 'Você' : d.senderName, d.ts ? dateFmt.format(d.ts) : ''].filter(Boolean).join(' · ')}
                          </span>
                        </span>
                      </button>
                    )
                  })}
                </div>
              </div>
            ))
          ) : (
            <div className="media-empty">
              <Doc size={26} />
              <span>{term ? 'Nenhum arquivo encontrado pra essa busca' : 'Nenhum arquivo guardado nessa conversa ainda'}</span>
            </div>
          )}

          {data && activeList.length > limit && (
            <button type="button" className="btn ghost media-more-btn" onClick={() => setLimit((n) => n + 90)}>
              Mostrar mais ({activeList.length - limit} restantes)
            </button>
          )}

          {data && thread?.hasMore && (
            <button type="button" className="btn ghost media-more-btn" disabled={loadingMore} onClick={() => void fetchHistory()}>
              {loadingMore ? 'Buscando mensagens mais antigas…' : 'Buscar mais antigas do histórico'}
            </button>
          )}
        </div>
      </motion.aside>

      <AnimatePresence>
        {viewer !== null && <GalleryLightbox list={filteredMedia} index={viewer} onChange={setViewer} onClose={() => setViewer(null)} />}
      </AnimatePresence>
    </>
  )
}
