// Files you paste, drop or pick wait here for a look (and a caption) before they go.
// A small card that rises above the composer: thumbnails, × to drop one, + to add more, Enter sends.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { OutFile } from '@shared/types'
import { toast, zap } from '../state'
import { Doc, Play, Plus, Send, X } from './icons'
import { sendFilesTo } from './ChatView'

type Item = OutFile & { key: string; kind: 'image' | 'video' | 'file'; blob?: boolean }
type Staged = { chatId: string; items: Item[] }

let staged: Staged | null = null
const subs = new Set<() => void>()
const emit = () => subs.forEach((f) => f())
const subscribe = (f: () => void) => {
  subs.add(f)
  return () => subs.delete(f)
}
let seq = 0

const IMG = /^image\/(png|jpe?g|gif|webp|bmp|avif|svg\+xml)$/i
const VID = /^video\/(mp4|webm|quicktime|x-m4v|ogg)$/i
const kindOf = (f: OutFile): Item['kind'] => (IMG.test(f.mime) ? 'image' : VID.test(f.mime) ? 'video' : 'file')

/** in-memory bytes (pasted screenshot) get a blob: URL for the preview */
function withPreview(f: OutFile): Item {
  let preview = f.preview
  let blob = false
  if (!preview && f.data && kindOf(f) !== 'file') {
    preview = URL.createObjectURL(new Blob([f.data], { type: f.mime }))
    blob = true
  }
  return { ...f, preview, blob: blob || preview?.startsWith('blob:'), key: 'f' + seq++, kind: kindOf(f), size: f.size ?? f.data?.byteLength }
}

const release = (items: Item[]) => {
  for (const it of items) if (it.blob && it.preview) URL.revokeObjectURL(it.preview)
}

/** opens the preview (or adds to the one already open for this chat) */
export function stageFiles(chatId: string, files: OutFile[]) {
  if (!files.length) return
  const add = files.map(withPreview)
  if (staged && staged.chatId === chatId) staged = { chatId, items: [...staged.items, ...add] }
  else {
    if (staged) release(staged.items)
    staged = { chatId, items: add }
  }
  emit()
}

function close() {
  if (staged) release(staged.items)
  staged = null
  emit()
}

function removeItem(key: string) {
  if (!staged) return
  const gone = staged.items.filter((i) => i.key === key)
  release(gone)
  const items = staged.items.filter((i) => i.key !== key)
  staged = items.length ? { ...staged, items } : null
  emit()
}

export const useStaged = (chatId: string) => useSyncExternalStore(subscribe, () => (staged?.chatId === chatId ? staged : null))

export const cleanError = (e: any) => String(e?.message ?? 'Falhou').replace(/^Error invoking remote method '\w+': (Error: )?/, '')

const fmtSize = (n?: number) =>
  n == null ? '' : n < 1024 ? n + ' B' : n < 1024 * 1024 ? Math.round(n / 1024) + ' KB' : (n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0).replace('.', ',') + ' MB'

const ext = (name: string) => (/\.([a-z0-9]{1,5})$/i.exec(name)?.[1] ?? '').toUpperCase()

function Thumb({ it, big }: { it: Item; big: boolean }) {
  const [broken, setBroken] = useState(false)
  const [ready, setReady] = useState(false)
  if (it.kind === 'image' && it.preview && !broken)
    return <img src={it.preview} alt="" decoding="async" draggable={false} className={ready ? 'in' : ''} onLoad={() => setReady(true)} onError={() => setBroken(true)} />
  if (it.kind === 'video' && it.preview && !broken)
    return (
      <>
        {/* #t: Chromium paints the first frame instead of black */}
        <video src={it.preview + '#t=0.001'} muted preload="metadata" playsInline className={ready ? 'in' : ''} onLoadedData={() => setReady(true)} onError={() => setBroken(true)} />
        <span className="ss-play">
          <Play size={big ? 18 : 13} />
        </span>
      </>
    )
  return (
    <div className="ss-file">
      <Doc size={big ? 30 : 22} />
      <span className="ss-ext">{ext(it.name) || 'ARQ'}</span>
    </div>
  )
}

export function SendPreview({ chatId, text, takeText, giveText }: { chatId: string; text: string; takeText: () => void; giveText: (t: string) => void }) {
  const st = useStaged(chatId)
  const [caption, setCaption] = useState('')
  const [sending, setSending] = useState(false)
  const capRef = useRef<HTMLTextAreaElement>(null)
  const open = !!st

  // opening: whatever you were typing becomes the caption (it goes back if you cancel)
  useEffect(() => {
    if (!open) return
    if (text.trim()) {
      setCaption(text)
      takeText()
    }
    requestAnimationFrame(() => capRef.current?.focus())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // switching chats with the card open: the caption goes back to that chat's draft, the files are dropped
  const capNow = useRef('')
  capNow.current = caption
  useEffect(
    () => () => {
      if (staged?.chatId !== chatId) return
      if (capNow.current.trim()) giveText(capNow.current)
      close()
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  const cancel = () => {
    if (caption.trim()) giveText(caption)
    setCaption('')
    close()
  }

  const send = () => {
    if (!staged || sending) return
    const files = staged.items.map(({ name, mime, path, data }) => (path ? { name, mime, path } : { name, mime, data }))
    const cap = caption.trim() || undefined
    setSending(true)
    setCaption('')
    close()
    void sendFilesTo(chatId, files, cap)
      .catch(() => cap && giveText(cap))
      .finally(() => setSending(false))
  }

  const addMore = () =>
    zap
      .pickFiles()
      .then((f) => stageFiles(chatId, f))
      .catch((e) => toast(cleanError(e)))

  // Esc cancels the preview (not the chat); Enter sends from anywhere in the card
  useEffect(() => {
    if (!open) return
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        cancel()
      }
    }
    window.addEventListener('keydown', k, true)
    return () => window.removeEventListener('keydown', k, true)
  })

  const items = st?.items ?? []
  const one = items.length === 1 && items[0].kind !== 'file'
  const total = items.reduce((a, i) => a + (i.size ?? 0), 0)

  return (
    <AnimatePresence>
      {st && (
        <motion.div
          className="send-sheet"
          initial={{ opacity: 0, y: 12, scale: 0.985 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 8, scale: 0.985, transition: { duration: 0.14 } }}
          transition={{ type: 'spring', stiffness: 430, damping: 34 }}
          onDragOver={(e) => e.preventDefault()}
        >
          <div className="ss-head">
            <b>{items.length === 1 ? 'Enviar arquivo' : `Enviar ${items.length} arquivos`}</b>
            {total > 0 && <span>{fmtSize(total)}</span>}
            <button className="icon-btn sm" title="Cancelar (Esc)" onClick={cancel}>
              <X size={14} />
            </button>
          </div>
          <div className={'ss-items' + (one ? ' one' : '')}>
            <AnimatePresence initial={false}>
              {items.map((it, i) => (
                <motion.div
                  key={it.key}
                  layout
                  className={'ss-item ' + it.kind}
                  initial={{ opacity: 0, scale: 0.94 }}
                  animate={{ opacity: 1, scale: 1, transition: { delay: Math.min(i, 8) * 0.025, duration: 0.2 } }}
                  exit={{ opacity: 0, scale: 0.92, transition: { duration: 0.12 } }}
                  title={it.name + (it.size ? ' · ' + fmtSize(it.size) : '')}
                >
                  <Thumb it={it} big={one} />
                  {!one && <span className="ss-name">{it.name}</span>}
                  <button className="ss-remove" title="Tirar" onClick={() => removeItem(it.key)}>
                    <X size={11} />
                  </button>
                </motion.div>
              ))}
            </AnimatePresence>
            {!one && (
              <button className="ss-add" title="Adicionar mais" onClick={addMore}>
                <Plus size={18} />
              </button>
            )}
          </div>
          {one && (
            <div className="ss-meta">
              <span className="ss-meta-name">{items[0].name}</span>
              <span>{fmtSize(items[0].size)}</span>
              <button className="ss-link" onClick={addMore}>
                + adicionar mais
              </button>
            </div>
          )}
          <div className="ss-caption">
            <textarea
              ref={capRef}
              rows={1}
              value={caption}
              placeholder="Legenda (opcional)"
              onChange={(e) => setCaption(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  send()
                }
              }}
              onPaste={(e) => {
                // more pictures pasted while the card is open join the others
                const files = [...e.clipboardData.files]
                if (files.length && !e.clipboardData.getData('text/plain')) {
                  e.preventDefault()
                  void Promise.all(files.map(async (f) => ({ name: f.name || 'imagem.png', mime: f.type || 'application/octet-stream', data: await f.arrayBuffer(), size: f.size }))).then((l) => stageFiles(chatId, l))
                }
              }}
            />
            <button className="send-btn" title="Enviar (Enter)" onClick={send}>
              <Send size={17} />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
