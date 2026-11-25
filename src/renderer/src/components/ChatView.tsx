import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { OutFile, UiChat, UiMessage } from '@shared/types'
import { getState, loadOlder, openChat, setState, toast, useStore, zap, type Thread } from '../state'
import { Avatar } from './Avatar'
import { Message } from './Message'
import { Safe } from './Safe'
import { EmojiPopover, StickerPopover } from './Pickers'
import { showMenu } from './overlays'
import { chatMenu, toggleBlock } from './Sidebar'
import { Back, BlockIcon, Clock, Down, More, Paperclip, PhotoIcon, PinIcon, Send, Smile, StickerIcon, X } from './icons'
import { fmtWhen, pickCustomTime, timeChoices } from '../tools'
import { firstUrl, hasFormatting, richBlocks } from '../format'
import { useLinkMeta } from './Links'
import { SendPreview, cleanError, stageFiles } from './SendPreview'
import { ChatMedia } from './ChatMedia'

const drafts = new Map<string, string>()

/**
 * Plain (non-virtual) list in a `column-reverse` scroller: the scroll origin sits at the bottom,
 * so older pages and history-sync messages inserted anywhere above never move what you're reading,
 * and heights are always the real DOM heights (no stale size cache → no overlapping bubbles).
 */
function MessageList({
  chatId,
  isGroup,
  thread,
  fresh,
  scrollerRef,
  onAtBottom,
  onOpenImage,
  onReactMore
}: {
  chatId: string
  isGroup: boolean
  thread: Thread
  fresh: Set<string>
  scrollerRef: React.RefObject<HTMLDivElement | null>
  onAtBottom: (v: boolean) => void
  onOpenImage: (src: string) => void
  onReactMore: (m: UiMessage, x: number, y: number) => void
}) {
  const messages = thread.list
  const last = useRef<{ id?: string; height: number; bottom: boolean }>({ height: 0, bottom: true })

  const check = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    const bottom = el.scrollTop > -80
    if (bottom !== last.current.bottom) {
      last.current.bottom = bottom
      onAtBottom(bottom)
    }
    // near the (visual) top → fetch older
    if (el.scrollHeight - el.clientHeight + el.scrollTop < 900) void loadOlder(chatId)
  }, [chatId, onAtBottom, scrollerRef])

  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const newLast = messages[messages.length - 1]?.id
    const prev = last.current
    // a new message arrived at the bottom while you're reading further up: keep the view still
    if (prev.id && newLast !== prev.id && !prev.bottom) el.scrollTop -= el.scrollHeight - prev.height
    prev.id = newLast
    prev.height = el.scrollHeight
    check()
  }, [messages, check, scrollerRef])

  return (
    <div className="msg-scroller" ref={scrollerRef} onScroll={check}>
      <div className="msg-inner">
        <div className="list-top">{thread.loading ? <span className="media-spin" /> : !thread.hasMore ? <span className="dim">início da conversa</span> : null}</div>
        {messages.map((m, i) => (
          <Safe key={m.id} name="message" resetKey={m} fallback={<div className="msg-wrap"><div className="sys-msg">⚠️ mensagem que não deu pra mostrar</div></div>}>
            <Message m={m} prev={messages[i - 1]} isGroup={isGroup} fresh={fresh.has(m.id)} onOpenImage={onOpenImage} onReactMore={onReactMore} />
          </Safe>
        ))}
        <div style={{ height: 12 }} />
      </div>
    </div>
  )
}

/** dropped/picked files keep their disk path (streamed by main, any size up to WhatsApp's 2 GB); pasted blobs go as bytes */
async function filesFrom(list: FileList | File[]): Promise<OutFile[]> {
  return Promise.all(
    [...list].map(async (f) => {
      const path = zap.pathForFile(f)
      const base = { name: f.name || 'arquivo', mime: f.type || '', size: f.size }
      // blob: URL straight from the File for the preview card (instant, nothing read through IPC)
      const preview = /^(image|video)\//.test(f.type) ? URL.createObjectURL(f) : undefined
      return path ? { ...base, path, preview } : { ...base, mime: base.mime || 'application/octet-stream', data: await f.arrayBuffer(), preview }
    })
  )
}

export async function sendFilesTo(chatId: string, files: OutFile[], caption?: string) {
  if (!files.length) return
  toast(files.length > 1 ? `Enviando ${files.length} arquivos…` : `Enviando ${files[0].name}…`)
  try {
    await zap.sendFiles(chatId, files, caption)
    toast(files.length > 1 ? `${files.length} arquivos enviados ✓` : 'Enviado ✓')
  } catch (e: any) {
    toast(String(e?.message ?? 'Falhou ao enviar').replace(/^Error invoking remote method '\w+': (Error: )?/, ''))
    throw e
  }
}

function ScheduledBar({ chatId }: { chatId: string }) {
  const all = useStore((s) => s.scheduled)
  const mine = all.filter((s) => s.chatId === chatId)
  if (!mine.length) return null
  return (
    <div className="sched-bar">
      <AnimatePresence initial={false}>
        {mine.map((s) => (
          <motion.div key={s.id} className="sched-chip" layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95 }}>
            <Clock size={13} />
            <b>{fmtWhen(s.at)}</b>
            <span>{s.text}</span>
            <button className="icon-btn sm" title="Cancelar agendamento" onClick={() => void zap.cancelScheduled(s.id)}>
              <X size={12} />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}

function Composer({ chat }: { chat: UiChat }) {
  const replyTo = useStore((s) => s.replyTo)
  const quick = useStore((s) => s.settings?.quickReplies ?? [])
  const [text, setText] = useState(() => drafts.get(chat.id) ?? '')
  const [panel, setPanel] = useState<'emoji' | 'sticker' | null>(null)
  const [qIndex, setQIndex] = useState(0)
  const [hasSel, setHasSel] = useState(false)
  const [skipPreview, setSkipPreview] = useState<string | null>(null)
  const ta = useRef<HTMLTextAreaElement>(null)
  const linkUrl = firstUrl(text)
  const linkMeta = useLinkMeta(linkUrl)
  const showLink = !!linkUrl && skipPreview !== linkUrl && !!(linkMeta?.title || linkMeta?.thumb)
  const showFmt = text.length < 4000 && hasFormatting(text) && !text.startsWith('/')

  /** wraps the selection with a WhatsApp marker (or inserts an empty pair at the cursor) */
  const wrap = (open: string, close = open) => {
    const el = ta.current
    if (!el) return
    const s = el.selectionStart
    const e = el.selectionEnd
    const v = el.value
    const sel = v.slice(s, e)
    // toggle off when the selection is already wrapped
    if (sel && v.slice(s - open.length, s) === open && v.slice(e, e + close.length) === close) {
      onChange(v.slice(0, s - open.length) + sel + v.slice(e + close.length))
      requestAnimationFrame(() => el.setSelectionRange(s - open.length, e - open.length))
      return
    }
    // markers must hug the text: trim spaces out of the selection
    const lead = sel.length - sel.trimStart().length
    const trail = sel.length - sel.trimEnd().length
    const core = sel.trim()
    const next = v.slice(0, s + lead) + open + core + close + v.slice(e - trail)
    onChange(next)
    requestAnimationFrame(() => {
      el.focus()
      if (core) el.setSelectionRange(s + lead + open.length, s + lead + open.length + core.length)
      else el.setSelectionRange(s + open.length, s + open.length)
    })
  }
  /** prefixes every selected line (citação / lista) */
  const prefixLines = (kind: 'quote' | 'ul' | 'ol') => {
    const el = ta.current
    if (!el) return
    const v = el.value
    const start = v.lastIndexOf('\n', el.selectionStart - 1) + 1
    const endIdx = v.indexOf('\n', el.selectionEnd)
    const end = endIdx < 0 ? v.length : endIdx
    const lines = v.slice(start, end).split('\n')
    const out = lines.map((l, i) => (kind === 'quote' ? '> ' : kind === 'ul' ? '- ' : `${i + 1}. `) + l.replace(/^(> |- |\* |\d+[.)] )/, ''))
    onChange(v.slice(0, start) + out.join('\n') + v.slice(end))
    requestAnimationFrame(() => el.focus())
  }
  const typingRef = useRef<{ on: boolean; t?: ReturnType<typeof setTimeout> }>({ on: false })

  // respostas rápidas: "/oi" → suggestions
  const slash = /^\/(\S*)$/.exec(text)
  const suggestions = slash ? quick.filter((q) => q.key.toLowerCase().startsWith(slash[1].toLowerCase()) || q.text.toLowerCase().includes(slash[1].toLowerCase())).slice(0, 6) : []

  useEffect(() => {
    ta.current?.focus()
  }, [chat.id, replyTo])
  useEffect(() => setQIndex(0), [text])

  // format bar follows the real text selection (mouse drag, Shift+arrows, Ctrl+A, double click)
  useEffect(() => {
    const el = ta.current
    if (!el) return
    const update = () => setHasSel(document.activeElement === el && el.selectionEnd - el.selectionStart > 0)
    document.addEventListener('selectionchange', update)
    el.addEventListener('select', update)
    el.addEventListener('mouseup', update)
    el.addEventListener('keyup', update)
    return () => {
      document.removeEventListener('selectionchange', update)
      el.removeEventListener('select', update)
      el.removeEventListener('mouseup', update)
      el.removeEventListener('keyup', update)
    }
  }, [])

  useLayoutEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = Math.min(el.scrollHeight, 180) + 'px'
  }, [text])

  const stopTyping = () => {
    const t = typingRef.current
    if (t.t) clearTimeout(t.t)
    if (t.on) void zap.typing(chat.id, false)
    t.on = false
  }
  useEffect(() => stopTyping, [chat.id])

  const onChange = (v: string) => {
    setText(v)
    drafts.set(chat.id, v)
    const t = typingRef.current
    if (!t.on && v) {
      t.on = true
      void zap.typing(chat.id, true)
    }
    if (t.t) clearTimeout(t.t)
    t.t = setTimeout(stopTyping, 3500)
  }

  const clear = () => {
    setText('')
    drafts.delete(chat.id)
    stopTyping()
  }

  const send = () => {
    const body = text.trim()
    if (!body) return
    clear()
    const quoted = getState().replyTo?.id
    setState({ replyTo: undefined })
    const noPreview = !!linkUrl && skipPreview === linkUrl
    setSkipPreview(null)
    zap.send(chat.id, body, quoted, { noPreview }).catch((e) => {
      toast(e?.message ?? 'Não enviou')
      setText(body)
    })
  }

  const applyQuick = (i: number) => {
    const q = suggestions[i]
    if (!q) return
    onChange(q.text)
    requestAnimationFrame(() => ta.current?.focus())
  }

  const scheduleAt = async (at: number | null) => {
    const body = text.trim()
    if (!body || !at) return
    try {
      await zap.schedule(chat.id, body, at)
      clear()
      toast(`⏰ Agendada para ${fmtWhen(at)}`)
    } catch (e: any) {
      toast(String(e?.message ?? 'Não agendou').replace(/^Error invoking remote method '\w+': (Error: )?/, ''))
    }
  }

  const scheduleMenu = (e: React.MouseEvent) => {
    if (!text.trim()) return toast('Escreva a mensagem primeiro, depois agende')
    showMenu(e, [
      ...timeChoices().map((c) => ({ label: c.label, icon: <Clock size={14} />, onClick: () => void scheduleAt(c.at) })),
      { divider: true, label: '' },
      { label: 'Escolher data e hora…', onClick: () => void pickCustomTime('Agendar mensagem para').then(scheduleAt) }
    ])
  }

  const insertEmoji = useCallback((e: string) => {
    const el = ta.current
    if (!el) return
    const s = el.selectionStart ?? el.value.length
    const v = el.value.slice(0, s) + e + el.value.slice(el.selectionEnd ?? s)
    onChange(v)
    requestAnimationFrame(() => {
      el.focus()
      el.selectionStart = el.selectionEnd = s + e.length
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.id])

  return (
    <div className="composer-wrap">
      <SendPreview
        chatId={chat.id}
        text={text}
        takeText={clear}
        // back into the box without telling the other person you're typing
        giveText={(t) => {
          setText(t)
          drafts.set(chat.id, t)
        }}
      />
      <AnimatePresence>
        {panel === 'emoji' && <EmojiPopover key="e" onPick={insertEmoji} onClose={() => setPanel(null)} />}
        {panel === 'sticker' && <StickerPopover key="s" chatId={chat.id} onClose={() => setPanel(null)} />}
        {suggestions.length > 0 && (
          <motion.div key="q" className="popover quick-pop" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }} transition={{ duration: 0.12 }}>
            {suggestions.map((q, i) => (
              <button key={q.key} className={'quick-item' + (i === qIndex ? ' on' : '')} onMouseEnter={() => setQIndex(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => applyQuick(i)}>
                <b>/{q.key}</b>
                <span>{q.text}</span>
              </button>
            ))}
            <div className="quick-hint">Tab ou Enter pra usar · edite em Configurações → Ferramentas</div>
          </motion.div>
        )}
      </AnimatePresence>
      <ScheduledBar chatId={chat.id} />
      <AnimatePresence initial={false}>
        {showLink && (
          <motion.div key="lp" className="compose-link" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }} transition={{ duration: 0.14 }}>
            {linkMeta?.thumb && <img src={linkMeta.thumb} alt="" />}
            <span className="compose-link-text">
              <b>{linkMeta?.title ?? linkMeta?.site}</b>
              <span>{linkMeta?.site}</span>
            </span>
            <button className="icon-btn sm" title="Enviar sem prévia" onClick={() => setSkipPreview(linkUrl!)}>
              <X size={13} />
            </button>
          </motion.div>
        )}
        {showFmt && (
          <motion.div key="fp" className="fmt-preview" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }} transition={{ duration: 0.14 }}>
            <span className="fmt-preview-label">prévia</span>
            <div className="text">{richBlocks(text)}</div>
          </motion.div>
        )}
        {hasSel && (
          <motion.div key="ft" className="fmt-bar" initial={{ opacity: 0, y: 4, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 2 }} transition={{ duration: 0.12 }} onMouseDown={(e) => e.preventDefault()}>
            <button title="Negrito (Ctrl+B)" onClick={() => wrap('*')}>
              <b>B</b>
            </button>
            <button title="Itálico (Ctrl+I)" onClick={() => wrap('_')}>
              <i>I</i>
            </button>
            <button title="Tachado (Ctrl+Shift+X)" onClick={() => wrap('~')}>
              <s>S</s>
            </button>
            <button title="Código (Ctrl+E)" onClick={() => wrap('`')}>
              {'</>'}
            </button>
            <button title="Bloco de código (Ctrl+Shift+M)" onClick={() => wrap('```')}>
              {'{ }'}
            </button>
            <i className="fmt-sep" />
            <button title="Citação" onClick={() => prefixLines('quote')}>
              ❝
            </button>
            <button title="Lista" onClick={() => prefixLines('ul')}>
              •
            </button>
            <button title="Lista numerada" onClick={() => prefixLines('ol')}>
              1.
            </button>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence initial={false}>
        {replyTo && (
          <motion.div className="reply-bar" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.15 }}>
            <div className="quote">
              <b>{replyTo.fromMe ? 'Você' : replyTo.senderName || chat.name}</b>
              <span>{replyTo.text || (replyTo.kind === 'image' ? '📷 Foto' : replyTo.kind === 'sticker' ? '💟 Figurinha' : 'Mensagem')}</span>
            </div>
            <button className="icon-btn sm" onClick={() => setState({ replyTo: undefined })}>
              <X size={14} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="composer">
        <button
          className="icon-btn"
          title="Enviar arquivo (ou arraste / cole com Ctrl+V)"
          onClick={() =>
            zap
              .pickFiles()
              .then((f) => stageFiles(chat.id, f))
              .catch((e) => toast(cleanError(e)))
          }
        >
          <Paperclip size={18} />
        </button>
        <textarea
          ref={ta}
          rows={1}
          value={text}
          placeholder={`Mensagem para ${chat.name}  ·  / respostas rápidas`}
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => setHasSel(false)}
          onKeyDown={(e) => {
            const mod = e.ctrlKey || e.metaKey
            if (mod && !e.altKey) {
              const k = e.key.toLowerCase()
              const map: Record<string, string> = e.shiftKey ? { x: '~', m: '```' } : { b: '*', i: '_', e: '`' }
              if (map[k]) {
                e.preventDefault()
                wrap(map[k])
                return
              }
            }
            if (suggestions.length) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                setQIndex((i) => (i + (e.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length)
                return
              }
              if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                e.preventDefault()
                applyQuick(qIndex)
                return
              }
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              send()
            }
            if (e.key === 'Escape') {
              if (panel) {
                setPanel(null)
                e.preventDefault()
              } else if (suggestions.length) {
                onChange('')
                e.preventDefault()
              } else if (getState().replyTo) {
                setState({ replyTo: undefined })
                e.preventDefault()
              }
            }
          }}
          onPaste={(e) => {
            const files = [...e.clipboardData.files]
            const pastedText = e.clipboardData.getData('text/plain')
            // Word/Excel/browsers put a picture of the selection next to the text: text wins
            if (pastedText && files.every((f) => f.type.startsWith('image/'))) return
            // nothing goes straight out: the preview card opens first (what you typed becomes the caption)
            if (files.length) {
              e.preventDefault()
              void filesFrom(files)
                .then((f) => stageFiles(chat.id, f))
                .catch(() => {})
              return
            }
            // files copied in Explorer don't reach the page: ask main to read the clipboard
            if (!e.clipboardData.getData('text/plain')) {
              e.preventDefault()
              zap
                .pasteClipboard()
                .then((f) => (f.length ? stageFiles(chat.id, f) : toast('Nada pra colar')))
                .catch((err) => toast(cleanError(err)))
            }
          }}
        />
        <button className={'icon-btn' + (panel === 'emoji' ? ' on' : '')} title="Emojis" onMouseDown={(e) => e.stopPropagation()} onClick={() => setPanel((p) => (p === 'emoji' ? null : 'emoji'))}>
          <Smile size={19} />
        </button>
        <button className={'icon-btn' + (panel === 'sticker' ? ' on' : '')} title="Figurinhas" onMouseDown={(e) => e.stopPropagation()} onClick={() => setPanel((p) => (p === 'sticker' ? null : 'sticker'))}>
          <StickerIcon size={18} />
        </button>
        <button className="icon-btn" title="Agendar mensagem" onClick={scheduleMenu}>
          <Clock size={18} />
        </button>
        <motion.button
          className="send-btn"
          title="Enviar (Enter) · botão direito: agendar"
          disabled={!text.trim()}
          onClick={send}
          onContextMenu={scheduleMenu}
          animate={{ scale: text.trim() ? 1 : 0.86, opacity: text.trim() ? 1 : 0.45 }}
          transition={{ type: 'spring', stiffness: 600, damping: 30 }}
        >
          <Send size={17} />
        </motion.button>
      </div>
    </div>
  )
}

function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  return (
    <motion.div className="lightbox" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.img src={src} initial={{ scale: 0.92 }} animate={{ scale: 1 }} exit={{ scale: 0.96 }} transition={{ type: 'spring', stiffness: 420, damping: 34 }} />
    </motion.div>
  )
}

export function ChatView({ chat, narrow }: { chat: UiChat; narrow: boolean }) {
  const thread = useStore((s) => s.threads[chat.id])
  const typing = useStore((s) => s.typing[chat.id])
  const fresh = useStore((s) => s.fresh)
  const mediaOpen = useStore((s) => s.mediaOpen)
  const [lightbox, setLightbox] = useState<string | null>(null)
  const [reactFor, setReactFor] = useState<{ m: UiMessage; x: number; y: number } | null>(null)
  const [atBottom, setAtBottom] = useState(true)
  const [drag, setDrag] = useState(false)
  const list = useRef<HTMLDivElement>(null)
  const messages = thread?.list ?? []

  // per-chat UI state must not leak into the next chat
  useEffect(() => {
    setAtBottom(true)
    setReactFor(null)
    setLightbox(null)
    setDrag(false)
  }, [chat.id])

  const onReactMore = useCallback((m: UiMessage, x: number, y: number) => setReactFor({ m, x, y }), [])
  const onOpenImage = useCallback((src: string) => setLightbox(src), [])
  // profile photos from @mention cards
  useEffect(() => {
    const fn = (e: Event) => setLightbox((e as CustomEvent<string>).detail)
    window.addEventListener('zap:image', fn)
    return () => window.removeEventListener('zap:image', fn)
  }, [])
  const pickReaction = useCallback(
    (e: string) => {
      if (reactFor) zap.react(reactFor.m.chatId, reactFor.m.id, e).catch((err) => toast(err?.message ?? 'Falhou'))
      setReactFor(null)
    },
    [reactFor]
  )

  const isTyping = typing && typing.until > Date.now()

  return (
    <section
      className="chat"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          setDrag(true)
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDrag(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setDrag(false)
        if (e.dataTransfer.files.length)
          void filesFrom(e.dataTransfer.files)
            .then((f) => stageFiles(chat.id, f))
            .catch(() => {})
      }}
    >
      <header className="chat-head drag">
        {narrow && (
          <button className="icon-btn no-drag" onClick={() => void openChat(null)}>
            <Back />
          </button>
        )}
        <div
          className={'chat-title no-drag clickable' + (mediaOpen ? ' on' : '')}
          title="Ver mídias, links e docs"
          onClick={() => setState((s) => ({ mediaOpen: !s.mediaOpen }))}
          onContextMenu={(e) => showMenu(e, chatMenu(chat))}
        >
          <Avatar id={chat.id} name={chat.name} size={26} />
          <div className="chat-title-text">
            <span className="chat-title-name">{chat.name}</span>
            <AnimatePresence mode="wait" initial={false}>
              {isTyping ? (
                <motion.span key="t" className="chat-sub typing" initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -3 }}>
                  <span className="dots">
                    <i />
                    <i />
                    <i />
                  </span>
                  {typing.who ? `${typing.who} digitando` : 'digitando'}
                </motion.span>
              ) : chat.isGroup || chat.archived ? (
                <motion.span key="g" className="chat-sub" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                  {chat.isGroup && chat.archived ? 'grupo · arquivada' : chat.archived ? 'arquivada' : 'grupo'}
                </motion.span>
              ) : null}
            </AnimatePresence>
          </div>
        </div>
        <div className="chat-head-actions no-drag">
          <button
            className={'icon-btn' + (mediaOpen ? ' on' : '')}
            title="Mídias, links e docs"
            onClick={() => setState((s) => ({ mediaOpen: !s.mediaOpen }))}
          >
            <PhotoIcon size={17} />
          </button>
          <button className={'icon-btn' + (chat.pinned ? ' on' : '')} title={chat.pinned ? 'Desafixar' : 'Fixar'} onClick={() => void zap.chatAction(chat.id, { pin: !chat.pinned })}>
            <PinIcon size={17} />
          </button>
          <button className="icon-btn" title="Mais" onClick={(e) => showMenu(e, chatMenu(chat))}>
            <More />
          </button>
        </div>
      </header>

      <motion.div key={"msgs:" + chat.id} className="messages" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.16, ease: [0.2, 0.8, 0.2, 1] }}>
        {thread ? (
          messages.length ? (
            <MessageList chatId={chat.id} isGroup={chat.isGroup} thread={thread} fresh={fresh} scrollerRef={list} onAtBottom={setAtBottom} onOpenImage={onOpenImage} onReactMore={onReactMore} />
          ) : (
            <div className="empty-chat">Nenhuma mensagem carregada ainda.{'\n'}Mande um oi 👋</div>
          )
        ) : (
          <div className="empty-chat">
            <span className="media-spin" />
          </div>
        )}
        <AnimatePresence>
          {!atBottom && (
            <motion.button
              className="to-bottom"
              initial={{ opacity: 0, scale: 0.8, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.8, y: 8 }}
              onClick={() => list.current?.scrollTo({ top: 0, behavior: 'smooth' })}
            >
              <Down size={16} />
            </motion.button>
          )}
        </AnimatePresence>
      </motion.div>

      {chat.blocked ? (
        <div className="composer-wrap" key={'blocked:' + chat.id}>
          <div className="blocked-bar">
            <BlockIcon size={16} />
            <span>Você bloqueou este contato.</span>
            <button className="btn" onClick={() => void toggleBlock(chat)}>
              Desbloquear
            </button>
          </div>
        </div>
      ) : (
        <Composer key={'composer:' + chat.id} chat={chat} />
      )}

      <AnimatePresence>{mediaOpen && <ChatMedia key={'media:' + chat.id} chat={chat} onClose={() => setState({ mediaOpen: false })} />}</AnimatePresence>
      <AnimatePresence>{lightbox && <Lightbox src={lightbox} onClose={() => setLightbox(null)} />}</AnimatePresence>
      <AnimatePresence>
        {reactFor && (
          <>
            <div className="click-catcher" onMouseDown={() => setReactFor(null)} />
            <EmojiPopover
              key="react"
              onPick={pickReaction}
              onClose={() => setReactFor(null)}
              style={{ position: 'fixed', left: Math.min(reactFor.x, window.innerWidth - 360), top: Math.max(8, Math.min(reactFor.y - 200, window.innerHeight - 440)), bottom: 'auto', right: 'auto' }}
            />
          </>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {drag && (
          <motion.div className="drop-zone" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            Solte pra enviar para <b>{chat.name}</b>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  )
}
