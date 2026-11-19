import fs from 'node:fs'
import path from 'node:path'
import { nativeImage, net } from 'electron'
import type { LinkMeta } from '@shared/types'

/**
 * Link previews (title / site / description / thumbnail) fetched like a browser would.
 * Cached in memory + a small JSON file so reopening the app doesn't refetch everything.
 */
const MAX_HTML = 2 * 1024 * 1024
const MAX_IMG = 3 * 1024 * 1024
const MAX_CACHE = 400
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'

let cache = new Map<string, LinkMeta>()
const inflight = new Map<string, Promise<LinkMeta | null>>()
let file = ''
let saveTimer: NodeJS.Timeout | null = null
let active = 0
const queue: (() => void)[] = []

export function initLinkCache(dir: string) {
  file = path.join(dir, 'links.json')
  try {
    const list = JSON.parse(fs.readFileSync(file, 'utf8')) as LinkMeta[]
    cache = new Map(list.map((m) => [m.url, m]))
  } catch {}
}

function save() {
  if (saveTimer || !file) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    const list = [...cache.values()].sort((a, b) => b.ts - a.ts).slice(0, MAX_CACHE)
    try {
      fs.writeFileSync(file, JSON.stringify(list))
    } catch {}
  }, 3000)
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }
function decode(s: string) {
  return s
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
        return Number.isFinite(code) ? String.fromCodePoint(code) : m
      }
      return ENT[e.toLowerCase()] ?? m
    })
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * All <meta> tags → { key: content } in ONE linear pass.
 * (The previous per-key regexes could backtrack across the whole page: on YouTube's 700 KB of
 * inline JS that froze the main process for minutes. `[^>]*` can never leave a tag, so this
 * stays linear no matter what the page contains.)
 */
function parseMetaTags(html: string): Map<string, string> {
  const tags = new Map<string, string>()
  for (const tag of html.matchAll(/<meta\b[^>]{0,2000}>/gi)) {
    let key = ''
    let content = ''
    for (const a of tag[0].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
      const name = a[1].toLowerCase()
      const value = a[2] ?? a[3] ?? a[4] ?? ''
      if (name === 'content') content = value
      else if ((name === 'property' || name === 'name' || name === 'itemprop') && !key) key = value.toLowerCase()
    }
    if (key && content.trim() && !tags.has(key)) tags.set(key, decode(content))
  }
  return tags
}

const pick = (tags: Map<string, string>, keys: string[]) => keys.map((k) => tags.get(k)).find(Boolean)

function titleTag(html: string): string | undefined {
  const i = html.search(/<title\b/i)
  if (i < 0) return undefined
  const open = html.indexOf('>', i)
  const close = html.indexOf('</title', open)
  if (open < 0 || close < 0 || close - open > 2000) return undefined
  return decode(html.slice(open + 1, close)) || undefined
}

/** official oEmbed endpoints: tiny JSON, way faster and more reliable than scraping those pages */
const OEMBED: [RegExp, (url: string) => string][] = [
  [/^https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch|shorts|live)|youtu\.be\/)/i, (u) => `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(u)}`],
  [/^https?:\/\/(?:www\.)?vimeo\.com\/\d+/i, (u) => `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(u)}`],
  [/^https?:\/\/open\.spotify\.com\//i, (u) => `https://open.spotify.com/oembed?url=${encodeURIComponent(u)}`],
  [/^https?:\/\/(?:www\.|vm\.)?tiktok\.com\//i, (u) => `https://www.tiktok.com/oembed?url=${encodeURIComponent(u)}`],
  [/^https?:\/\/(?:www\.)?(?:twitter|x)\.com\/\w+\/status\//i, (u) => `https://publish.twitter.com/oembed?omit_script=1&url=${encodeURIComponent(u)}`]
]

async function fetchOEmbed(url: string): Promise<LinkMeta | null> {
  const hit = OEMBED.find(([re]) => re.test(url))
  if (!hit) return null
  try {
    const res = await net.fetch(hit[1](url), { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(6000) })
    if (!res.ok) return null
    const j = JSON.parse(new TextDecoder().decode(await readCapped(res, 256 * 1024))) as Record<string, string>
    let title = j.title
    // X/Twitter only returns HTML: take the tweet text out of it
    if (!title && j.html) title = decode(j.html.replace(/<[^>]{0,500}>/g, ' ')).slice(0, 200)
    const t = j.thumbnail_url ? await thumbFrom(j.thumbnail_url) : {}
    return {
      url,
      site: j.provider_name || new URL(url).hostname.replace(/^www\./, ''),
      domain: new URL(url).hostname.replace(/^www\./, ''),
      title: title?.slice(0, 200),
      description: j.author_name ? `${j.author_name}` : undefined,
      ...t,
      ts: Date.now()
    }
  } catch {
    return null
  }
}

function charsetOf(contentType: string | null, head: string) {
  const fromHeader = /charset=([\w-]+)/i.exec(contentType ?? '')?.[1]
  const fromMeta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1]
  return (fromHeader || fromMeta || 'utf-8').toLowerCase()
}

/** `</head` as bytes: stop downloading once the head is over */
const HEAD_END = new TextEncoder().encode('</head')

function hasBytes(chunk: Uint8Array, needle: Uint8Array) {
  outer: for (let i = 0; i <= chunk.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      const c = chunk[i + j]
      // case-insensitive for ASCII letters
      if (c !== needle[j] && (c | 0x20) !== needle[j]) continue outer
    }
    return true
  }
  return false
}

async function readCapped(res: Response, cap: number, stopAt?: Uint8Array): Promise<Uint8Array> {
  const reader = res.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let size = 0
  while (size < cap) {
    const { done, value } = await reader.read()
    if (done || !value) break
    chunks.push(value)
    size += value.length
    if (stopAt && hasBytes(value, stopAt)) break
  }
  void reader.cancel().catch(() => {})
  const out = new Uint8Array(Math.min(size, cap))
  let o = 0
  for (const c of chunks) {
    const take = Math.min(c.length, out.length - o)
    out.set(c.subarray(0, take), o)
    o += take
    if (o >= out.length) break
  }
  return out
}

async function thumbFrom(imgUrl: string): Promise<{ thumb?: string; jpeg?: string }> {
  try {
    const res = await net.fetch(imgUrl, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(6000) })
    if (!res.ok) return {}
    const buf = Buffer.from(await readCapped(res, MAX_IMG))
    const img = nativeImage.createFromBuffer(buf)
    if (img.isEmpty()) return {}
    const { width, height } = img.getSize()
    const small = width > height ? img.resize({ width: Math.min(320, width), quality: 'good' }) : img.resize({ height: Math.min(320, height), quality: 'good' })
    const jpeg = small.toJPEG(72).toString('base64')
    return { thumb: 'data:image/jpeg;base64,' + jpeg, jpeg }
  } catch {
    return {}
  }
}

async function fetchMeta(url: string): Promise<LinkMeta | null> {
  const u = new URL(url)
  if (!/^https?:$/.test(u.protocol)) return null
  const viaOEmbed = await fetchOEmbed(url)
  if (viaOEmbed?.title) return viaOEmbed
  const res = await net.fetch(url, {
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', 'accept-language': 'pt-BR,pt;q=0.9,en;q=0.6' },
    redirect: 'follow',
    signal: AbortSignal.timeout(7000)
  })
  const finalUrl = res.url || url
  const site = new URL(finalUrl).hostname.replace(/^www\./, '')
  const type = res.headers.get('content-type') ?? ''
  if (type.startsWith('image/')) {
    const t = await thumbFrom(finalUrl)
    return { url, site, title: decodeURIComponent(u.pathname.split('/').pop() || site), ...t, ts: Date.now() }
  }
  if (!res.ok || !/html|xml/i.test(type)) return { url, site, ts: Date.now() }
  const bytes = await readCapped(res, MAX_HTML, HEAD_END)
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 4096))
  let html: string
  try {
    html = new TextDecoder(charsetOf(res.headers.get('content-type'), head)).decode(bytes)
  } catch {
    html = new TextDecoder().decode(bytes)
  }
  // metadata lives in <head>: everything after it is irrelevant (and big)
  const endHead = html.search(/<\/head\s*>/i)
  if (endHead > 0) html = html.slice(0, endHead)
  const tags = parseMetaTags(html)
  const title = pick(tags, ['og:title', 'twitter:title', 'title']) ?? titleTag(html)
  const description = pick(tags, ['og:description', 'twitter:description', 'description'])
  const siteName = pick(tags, ['og:site_name', 'application-name'])
  let image = pick(tags, ['og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src'])
  if (image) {
    try {
      image = new URL(image, finalUrl).toString()
    } catch {
      image = undefined
    }
  }
  const t = image ? await thumbFrom(image) : {}
  return {
    url,
    site: siteName || site,
    domain: site,
    title: title?.slice(0, 200),
    description: description?.slice(0, 300),
    ...t,
    ts: Date.now()
  }
}

export function cachedLinkMeta(url: string) {
  return cache.get(url)
}

export function getLinkMeta(url: string): Promise<LinkMeta | null> {
  const hit = cache.get(url)
  // refresh entries older than a week in the background, serve the cached one now
  if (hit && Date.now() - hit.ts < 7 * 86400_000) return Promise.resolve(hit)
  const job = inflight.get(url)
  if (job) return job
  const p = new Promise<LinkMeta | null>((resolve) => {
    const run = async () => {
      active++
      try {
        const meta = await fetchMeta(url)
        if (meta) {
          cache.set(url, meta)
          save()
        }
        resolve(meta ?? hit ?? null)
      } catch {
        // remember failures briefly so we don't hammer dead links
        const fail: LinkMeta = { url, site: safeHost(url), ts: Date.now() - 6 * 86400_000 }
        cache.set(url, hit ?? fail)
        resolve(hit ?? fail)
      } finally {
        active--
        inflight.delete(url)
        queue.shift()?.()
      }
    }
    if (active < 4) void run()
    else queue.push(() => void run())
  })
  inflight.set(url, p)
  return p
}

function safeHost(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}
