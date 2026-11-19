import { useCallback, useEffect, useState } from 'react'
import { motion, useAnimationControls } from 'motion/react'
import { setState, toast, useStore, zap } from '../state'
import { LockIcon } from './icons'

function PinPad({ length, onComplete, busy }: { length: number; onComplete: (pin: string) => Promise<boolean>; busy?: boolean }) {
  const [pin, setPin] = useState('')
  const shake = useAnimationControls()

  const press = useCallback(
    (d: string) => {
      if (busy) return
      setPin((p) => {
        if (d === 'del') return p.slice(0, -1)
        if (p.length >= length) return p
        const next = p + d
        if (next.length === length) {
          void onComplete(next).then((ok) => {
            if (!ok) {
              void shake.start({ x: [0, -12, 11, -8, 6, -3, 0], transition: { duration: 0.42 } })
              setTimeout(() => setPin(''), 260)
            }
          })
        }
        return next
      })
    },
    [length, onComplete, busy, shake]
  )

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) press(e.key)
      else if (e.key === 'Backspace') press('del')
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [press])

  useEffect(() => setPin(''), [length])

  return (
    <div className="pinpad">
      <motion.div className="pin-dots" animate={shake}>
        {Array.from({ length }, (_, i) => (
          <motion.i key={i} animate={{ scale: i < pin.length ? 1 : 0.55, opacity: i < pin.length ? 1 : 0.35 }} transition={{ type: 'spring', stiffness: 700, damping: 26 }} />
        ))}
      </motion.div>
      <div className="keys">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'].map((k, i) =>
          k ? (
            <motion.button key={i} whileTap={{ scale: 0.9 }} className={'key' + (k === 'del' ? ' del' : '')} onClick={() => press(k)}>
              {k === 'del' ? '⌫' : k}
            </motion.button>
          ) : (
            <span key={i} />
          )
        )}
      </div>
    </div>
  )
}

export function LockScreen() {
  const pinLength = useStore((s) => s.pinLength) || 4
  const [msg, setMsg] = useState('Digite seu PIN')
  const [busy, setBusy] = useState(false)
  const unlock = useCallback(async (pin: string) => {
    const r = await zap.unlock(pin)
    if (r.ok) return true
    if (r.waitMs) {
      setBusy(true)
      setMsg(`Muitas tentativas — espere ${Math.ceil(r.waitMs / 1000)}s`)
      setTimeout(() => {
        setBusy(false)
        setMsg('Digite seu PIN')
      }, r.waitMs)
    } else setMsg('PIN incorreto')
    return false
  }, [])
  return (
    <motion.div className="lock" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.22 } }}>
      <motion.div className="lock-card" initial={{ scale: 0.96, y: 10 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 1.03, opacity: 0 }} transition={{ type: 'spring', stiffness: 380, damping: 32 }}>
        <div className="lock-icon">
          <LockIcon size={26} />
        </div>
        <h2>Zapdesk bloqueado</h2>
        <p className="dim">{msg}</p>
        <PinPad length={pinLength} onComplete={unlock} busy={busy} />
        <button
          className="link-btn"
          onClick={async () => {
            if (!confirm('Esqueceu o PIN? Isso desconecta o WhatsApp deste PC e apaga as conversas salvas aqui. Você vai ler o QR de novo.')) return
            await zap.forgotPin()
            setState({ hasPin: false, pinLength: 0, locked: false })
          }}
        >
          Esqueci o PIN
        </button>
      </motion.div>
    </motion.div>
  )
}

export function PinSetup({ onDone, canCancel }: { onDone: () => void; canCancel?: boolean }) {
  const [len, setLen] = useState<4 | 6>(4)
  const [first, setFirst] = useState<string | null>(null)
  const done = useCallback(
    async (pin: string) => {
      if (!first) {
        setFirst(pin)
        return true
      }
      if (pin !== first) {
        setFirst(null)
        toast('Os PINs não batem, tenta de novo')
        return false
      }
      const ok = await zap.setPin(pin)
      if (ok) {
        setState({ hasPin: true, pinLength: pin.length })
        toast('PIN definido 🔒')
        onDone()
      }
      return ok
    },
    [first, onDone]
  )
  return (
    <motion.div className="lock setup" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <motion.div className="lock-card" initial={{ scale: 0.96, y: 10 }} animate={{ scale: 1, y: 0 }} transition={{ type: 'spring', stiffness: 380, damping: 32 }}>
        <div className="lock-icon">
          <LockIcon size={26} />
        </div>
        <h2>{first ? 'Confirme o PIN' : 'Crie um PIN'}</h2>
        <p className="dim">{first ? 'Digite de novo' : 'O Zapdesk bloqueia sozinho depois de um tempo parado'}</p>
        {!first && (
          <div className="seg small">
            {([4, 6] as const).map((n) => (
              <button key={n} className={len === n ? 'on' : ''} onClick={() => setLen(n)}>
                {n} dígitos
              </button>
            ))}
          </div>
        )}
        <PinPad key={first ? 'confirm' : 'first' + len} length={len} onComplete={done} />
        {canCancel && (
          <button className="link-btn" onClick={onDone}>
            Cancelar
          </button>
        )}
      </motion.div>
    </motion.div>
  )
}
