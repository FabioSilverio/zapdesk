import { memo, useEffect, useSyncExternalStore } from 'react'
import type { LinkMeta } from '@shared/types'
import { getState, toast, zap } from '../state'
import { showMenu } from './overlays'

/** renderer-side cache of link previews (main does the fetching + disk cache) */
const metas = new Map<string, LinkMeta | null>()
const pending = new Set<string>()
const subs = new Set<() => void>()
let version = 0
const bump = () => {
  version++
  subs.forEach((f) => f())
}

export function requestMeta(url: string) {
  if (metas.has(url) || pending.has(url) || !getState().settings?.linkPreviews) return
  pending.add(url)
  zap
    .linkMeta(url)
    .then((m) => metas.set(url, m))
    .catch(() => metas.set(url, null))
    .finally(() => {
      pending.delete(url)
      bump()
    })
}

export function useLinkMeta(url: string | undefined): LinkMeta | null | undefined {
  useSyncExternalStore(
    (f) => {
      subs.add(f)
      return () => subs.delete(f)
    },
    () => version
  )
  useEffect(() => {
    if (url) requestMeta(url)
  }, [url])
  return url ? metas.get(url) : undefined
}

export function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** short human form while the title isn't known: cgn.inf.br/noticia/… */
export function prettyUrl(url: string) {
  try {
    const u = new URL(url)
    const host = u.hostname.replace(/^www\./, '')
    const p = decodeURIComponent(u.pathname).replace(/\/$/, '')
    if (!p) return host
    const first = p.split('/').filter(Boolean)[0] ?? ''
    return host + '/' + (first.length > 24 ? first.slice(0, 22) + '…' : first) + (p.split('/').filter(Boolean).length > 1 ? '/…' : '')
  } catch {
    return url
  }
}

export function linkMenu(e: React.MouseEvent, url: string) {
  e.preventDefault()
  e.stopPropagation()
  showMenu(e, [
    { label: 'Abrir no navegador', onClick: () => window.open(url, '_blank') },
    { label: 'Copiar link', onClick: () => void navigator.clipboard.writeText(url).then(() => toast('Link copiado')) }
  ])
}

/** a link shown by its page title (site name as a fallback), full URL on hover */
export const LinkText = memo(function LinkText({ url, raw }: { url: string; raw: string }) {
  const enabled = getState().settings?.linkPreviews !== false
  const meta = useLinkMeta(enabled ? url : undefined)
  const title = meta?.title && meta.title.length > 64 ? meta.title.slice(0, 61).trimEnd() + '…' : meta?.title
  const label = !enabled ? raw : title ? title : prettyUrl(url)
  return (
    <a href={url} target="_blank" rel="noreferrer" className={'link' + (enabled ? ' named' : '')} title={url} onContextMenu={(e) => linkMenu(e, url)}>
      {enabled && <span className="link-ic">🔗</span>}
      {label}
      {enabled && meta?.title && <span className="link-host"> · {meta.site || hostOf(url)}</span>}
    </a>
  )
})

/** WhatsApp-like preview card under a message (sender's embedded preview first, fetched one otherwise) */
export const LinkCard = memo(function LinkCard({ url, embedded }: { url: string; embedded?: { title?: string; description?: string; thumb?: string } }) {
  const fetched = useLinkMeta(embedded?.title ? undefined : url)
  const title = embedded?.title ?? fetched?.title
  const description = embedded?.description ?? fetched?.description
  const thumb = embedded?.thumb ?? fetched?.thumb
  const site = fetched?.site || hostOf(url)
  if (!title && !thumb) return null
  return (
    <a className={'link-card' + (thumb ? ' has-thumb' : '')} href={url} target="_blank" rel="noreferrer" title={url} onContextMenu={(e) => linkMenu(e, url)}>
      {thumb && <img src={thumb} alt="" loading="lazy" draggable={false} />}
      <span className="link-card-text">
        <b>{title ?? site}</b>
        {description && <span className="link-card-desc">{description}</span>}
        <span className="link-card-site">{site}</span>
      </span>
    </a>
  )
})
