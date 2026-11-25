import { useEffect, useRef, useState } from 'react'
import { motion } from 'motion/react'
import type { UiMessage } from '@shared/types'
import { toast, zap } from '../state'
import { cleanError } from './SendPreview'
import { Check, X } from './icons'

/** a poll inside a bubble: tap an option to vote (again to take it back), bars fill with the share of voters */
export function PollBody({ m }: { m: UiMessage }) {
  const p = m.poll!
  // what you just picked, shown before WhatsApp/Telegram confirms (cleared when the real result arrives)
  const [pending, setPending] = useState<boolean[] | null>(null)
  useEffect(() => setPending(null), [p])
  const mine = pending ?? p.options.map((o) => o.mine)
  const opts = p.options.map((o, i) => ({ ...o, mine: mine[i], votes: Math.max(0, o.votes - (o.mine ? 1 : 0) + (mine[i] ? 1 : 0)) }))
  const votedBefore = p.options.some((o) => o.mine)
  const votedNow = mine.some(Boolean)
  const voters = Math.max(0, p.voters - (votedBefore ? 1 : 0) + (votedNow ? 1 : 0))

  const vote = (i: number) => {
    if (p.closed) return
    const next = p.multi ? mine.map((v, j) => (j === i ? !v : v)) : mine.map((v, j) => j === i && !v)
    setPending(next)
    const picked = next.flatMap((v, j) => (v ? [j] : []))
    zap.votePoll(m.chatId, m.id, picked).catch((e) => {
      setPending(null)
      toast(cleanError(e) || 'Não votou')
    })
  }

  return (
    <div className="poll">
      <div className="poll-q">{p.name}</div>
      <div className="poll-hint">{p.closed ? 'Enquete encerrada' : p.multi ? 'Selecione uma ou mais opções' : 'Selecione uma opção'}</div>
      {opts.map((o, i) => (
        <button key={i} type="button" className={'poll-opt' + (o.mine ? ' mine' : '')} disabled={p.closed} onClick={() => vote(i)} onDoubleClick={(e) => e.stopPropagation()}>
          <span className={'poll-check' + (p.multi ? ' sq' : '')}>{o.mine && <Check size={11} strokeWidth={3} />}</span>
          <span className="poll-main">
            <span className="poll-row">
              <span className="poll-name">{o.name}</span>
              <span className="poll-count">{o.votes || ''}</span>
            </span>
            <span className="poll-bar">
              <i style={{ width: voters ? `${Math.min(100, (o.votes / voters) * 100)}%` : 0 }} />
            </span>
          </span>
        </button>
      ))}
      <div className="poll-foot">{voters ? `${voters} ${voters === 1 ? 'pessoa votou' : 'pessoas votaram'}` : 'Ninguém votou ainda'}</div>
    </div>
  )
}

/** "Nova enquete": question, options (a new empty row appears as you type), one or several answers */
export function PollDialog({ chatId, onClose }: { chatId: string; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [opts, setOpts] = useState(['', ''])
  const [multi, setMulti] = useState(false)
  const [busy, setBusy] = useState(false)
  const inputs = useRef<(HTMLInputElement | null)[]>([])
  const filled = opts.map((o) => o.trim()).filter(Boolean)
  const dupes = new Set(filled).size !== filled.length
  const ok = !!q.trim() && filled.length >= 2 && !dupes && !busy
  const MAX = chatId.startsWith('tg:') ? 10 : 12

  const setOpt = (i: number, v: string) => {
    const next = opts.slice()
    next[i] = v
    // always one empty row at the end (up to the limit); empty rows in the middle go away
    const kept = next.filter((o, j) => o.trim() || j === next.length - 1 || j === i)
    if (kept[kept.length - 1].trim() && kept.length < MAX) kept.push('')
    while (kept.length < 2) kept.push('')
    setOpts(kept)
  }

  const submit = () => {
    if (!ok) return
    setBusy(true)
    zap
      .sendPoll(chatId, q.trim(), filled, multi)
      .then(onClose)
      .catch((e) => {
        setBusy(false)
        toast(cleanError(e) || 'Não enviou a enquete')
      })
  }

  return (
    <motion.div className="scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={onClose}>
      <motion.form
        className="dialog poll-dialog"
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.98 }}
        transition={{ type: 'spring', stiffness: 520, damping: 36 }}
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            onClose()
          }
        }}
      >
        <h3>Nova enquete</h3>
        <label className="poll-label">Pergunta</label>
        <input autoFocus value={q} maxLength={255} placeholder="Faça uma pergunta" onChange={(e) => setQ(e.target.value)} />
        <label className="poll-label">Opções</label>
        <div className="poll-opts-edit">
          {opts.map((o, i) => (
            <div key={i} className="poll-opt-edit">
              <input
                ref={(el) => {
                  inputs.current[i] = el
                }}
                value={o}
                maxLength={100}
                placeholder={i < 2 ? `Opção ${i + 1}` : '+ Adicionar opção'}
                onChange={(e) => setOpt(i, e.target.value)}
                onKeyDown={(e) => {
                  // Enter jumps to the next option; on the last one it sends
                  if (e.key === 'Enter' && i < opts.length - 1 && !(e.ctrlKey || e.metaKey)) {
                    e.preventDefault()
                    inputs.current[i + 1]?.focus()
                  }
                }}
              />
              {o && opts.length > 2 && (
                <button type="button" className="icon-btn sm" title="Tirar opção" onClick={() => setOpts((list) => list.filter((_, j) => j !== i))}>
                  <X size={12} />
                </button>
              )}
            </div>
          ))}
        </div>
        {dupes && <div className="poll-warn">Tem opção repetida</div>}
        <label className="poll-multi">
          <span>Permitir mais de uma resposta</span>
          <button type="button" className={'toggle' + (multi ? ' on' : '')} onClick={() => setMulti((v) => !v)} role="switch" aria-checked={multi}>
            <motion.i layout transition={{ type: 'spring', stiffness: 700, damping: 35 }} />
          </button>
        </label>
        <div className="dialog-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn primary" disabled={!ok}>
            {busy ? 'Enviando…' : 'Enviar'}
          </button>
        </div>
      </motion.form>
    </motion.div>
  )
}
