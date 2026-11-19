import type { ReactNode } from 'react'
import { LinkText } from './components/Links'
import { Mention, PhoneText } from './components/People'

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<]+[^\s<.,:;"')\]!?]/gi
export const normUrl = (u: string) => (/^https?:\/\//i.test(u) ? u : 'https://' + u)
export function firstUrl(text?: string) {
  const m = text ? new RegExp(URL_RE.source, 'i').exec(text) : null
  return m ? normUrl(m[0]) : undefined
}

function linkify(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let i = 0
  for (const m of text.matchAll(URL_RE)) {
    if (m.index! > last) out.push(...people(text.slice(last, m.index), key + 'p' + i))
    out.push(<LinkText key={key + 'l' + i++} url={normUrl(m[0])} raw={m[0]} />)
    last = m.index! + m[0].length
  }
  if (last < text.length) out.push(...people(text.slice(last), key + 'p' + i))
  return out
}

// "@5511999990000" mentions (WhatsApp writes the account id in the text) and phone numbers:
// +55 43 99645-0404 · (43) 99645-0404 · 43 99645-0404 · +1 415 555 0100
const PEOPLE_RE = /@(\d{2,})|((?:\+\d{1,3}[\s.-]?)?\(?\b\d{2,3}\)?[\s.-]?9?\d{4}[\s.-]\d{4}\b)/g
function people(text: string, key: string): ReactNode[] {
  if (!/@\d|\d{4}/.test(text)) return [text]
  const out: ReactNode[] = []
  let last = 0
  let i = 0
  for (const m of text.matchAll(PEOPLE_RE)) {
    if (m.index! > last) out.push(text.slice(last, m.index))
    const k = key + 'm' + i++
    out.push(m[1] ? <Mention key={k} token={m[1]} raw={m[0]} /> : <PhoneText key={k} raw={m[0]} />)
    last = m.index! + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/**
 * Block-level WhatsApp formatting on top of the inline one:
 * ```code blocks```, "> citação", "- lista" / "* lista", "1. lista numerada".
 */
export function richBlocks(text: string): ReactNode[] {
  // giant pastes render as plain text: formatting regexes on 20k+ chars aren't worth a frozen frame
  if (text.length > 20000) return [text]
  const out: ReactNode[] = []
  const parts = text.split(/(```[\s\S]+?```)/)
  parts.forEach((part, pi) => {
    if (!part) return
    if (part.startsWith('```') && part.endsWith('```') && part.length > 6) {
      out.push(<pre key={'c' + pi}>{part.slice(3, -3).replace(/^\n|\n$/g, '')}</pre>)
      return
    }
    const lines = part.split('\n')
    let buf: string[] = []
    let block: { kind: 'quote' | 'ul' | 'ol'; items: string[] } | null = null
    const flushText = (k: string) => {
      if (!buf.length) return
      out.push(<span key={k}>{richText(buf.join('\n'), k)}</span>)
      buf = []
    }
    const flushBlock = (k: string) => {
      if (!block) return
      const b = block
      block = null
      if (b.kind === 'quote')
        out.push(
          <blockquote key={k} className="fmt-quote">
            {richText(b.items.join('\n'), k)}
          </blockquote>
        )
      else {
        const Tag = b.kind === 'ul' ? 'ul' : 'ol'
        out.push(
          <Tag key={k} className="fmt-list">
            {b.items.map((it, i) => (
              <li key={i}>{richText(it, k + 'i' + i)}</li>
            ))}
          </Tag>
        )
      }
    }
    lines.forEach((line, li) => {
      const k = `b${pi}-${li}`
      const quote = /^>\s?(.*)$/.exec(line)
      const ul = /^\s*[-*•]\s+(.+)$/.exec(line)
      const ol = /^\s*\d{1,3}[.)]\s+(.+)$/.exec(line)
      const kind = quote ? 'quote' : ul ? 'ul' : ol ? 'ol' : null
      if (kind) {
        if (block?.kind !== kind) {
          flushText(k + 't')
          flushBlock(k + 'b')
          block = { kind, items: [] }
        }
        block!.items.push((quote?.[1] ?? ul?.[1] ?? ol?.[1])!)
      } else {
        flushBlock(k + 'b')
        // keep the line break between plain text and a following block
        buf.push(line)
      }
    })
    flushText(`b${pi}-endt`)
    flushBlock(`b${pi}-endb`)
  })
  return out
}

export const hasFormatting = (t: string) => /(\*[^*\s][^*]*\*|_[^_\s][^_]*_|~[^~\s][^~]*~|`[^`]+`|^>\s|^\s*[-*•]\s|^\s*\d+[.)]\s)/m.test(t)

// WhatsApp-style inline formatting: *bold* _italic_ ~strike~ `code` ```mono```
const FMT_RE = /```([\s\S]+?)```|`([^`\n]+)`|(?<![\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\w*])|(?<![\w_])_(?!\s)([^_\n]+?)(?<!\s)_(?![\w_])|(?<![\w~])~(?!\s)([^~\n]+?)(?<!\s)~(?![\w~])/g

export function richText(text: string, key = 'r'): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let i = 0
  for (const m of text.matchAll(FMT_RE)) {
    if (m.index! > last) out.push(...linkify(text.slice(last, m.index), key + i++))
    const k = key + 'f' + i++
    if (m[1] != null) out.push(<pre key={k}>{m[1]}</pre>)
    else if (m[2] != null) out.push(<code key={k}>{m[2]}</code>)
    else if (m[3] != null) out.push(<strong key={k}>{richText(m[3], k)}</strong>)
    else if (m[4] != null) out.push(<em key={k}>{richText(m[4], k)}</em>)
    else if (m[5] != null) out.push(<s key={k}>{richText(m[5], k)}</s>)
    last = m.index! + m[0].length
  }
  if (last < text.length) out.push(...linkify(text.slice(last), key + i++))
  return out
}

const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}(?:️|‍|\p{Emoji_Modifier}|\p{Extended_Pictographic})*\s*){1,3}$/u
export const isEmojiOnly = (t?: string) => !!t && t.length <= 24 && EMOJI_ONLY.test(t.trim())

const hm = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' })
const dm = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' })
const wd = new Intl.DateTimeFormat('pt-BR', { weekday: 'long' })
const full = new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' })

export const timeOf = (ts: number) => hm.format(ts)

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()

export function listTime(ts: number) {
  if (!ts) return ''
  const now = new Date()
  const diff = startOfDay(now) - startOfDay(new Date(ts))
  if (diff <= 0) return hm.format(ts)
  if (diff <= 86400_000) return 'Ontem'
  if (diff < 6 * 86400_000) return wd.format(ts).replace('-feira', '')
  return dm.format(ts)
}

export function dayLabel(ts: number) {
  const diff = startOfDay(new Date()) - startOfDay(new Date(ts))
  if (diff <= 0) return 'Hoje'
  if (diff <= 86400_000) return 'Ontem'
  if (diff < 6 * 86400_000) return wd.format(ts)
  return full.format(ts)
}

export const sameDay = (a: number, b: number) => startOfDay(new Date(a)) === startOfDay(new Date(b))

export const duration = (s?: number) => {
  if (!s && s !== 0) return ''
  const m = Math.floor(s / 60)
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}

const PALETTE = ['#ff7a45', '#ff4d6d', '#3d7bff', '#22c08a', '#e05cd6', '#b8864b', '#8f7bff', '#f5b31b', '#1fb6c9', '#ff8fb1']
export function colorOf(id: string) {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
  return PALETTE[Math.abs(h) % PALETTE.length]
}

export function initials(name: string) {
  const clean = name.replace(/[^\p{L}\p{N}\s]/gu, '').trim()
  if (!clean) return name.trim().slice(0, 2) || '?'
  const parts = clean.split(/\s+/)
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts[parts.length - 1][0] ?? '') : '')).toUpperCase()
}
