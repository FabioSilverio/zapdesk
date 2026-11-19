// Choosing the app font: asked once on a brand-new install, and always in Configurações → Aparência.
import { useMemo } from 'react'
import { motion } from 'motion/react'
import type { Appearance, FontId } from '@shared/types'
import { toast, zap } from '../state'
import { FONT_CHOICES, sfAvailable, sfBundled, stackOf } from '../fonts'
import { updateSettings } from './Settings'

const setFont = (p: Partial<Appearance>) => void updateSettings({ appearance: p as Appearance })

async function pickFile() {
  try {
    const name = await zap.importFont()
    if (!name) return false
    // the stamp makes the renderer load the new file even if the name is the same
    setFont({ font: 'custom', customFont: name + '|' + Date.now() })
    return true
  } catch (e: any) {
    toast(String(e?.message ?? 'Não deu pra usar essa fonte').replace(/^Error invoking remote method '\w+': (Error: )?/, ''))
    return false
  }
}

/** the four cards, each written in its own font */
export function FontChoices({ a }: { a: Appearance }) {
  const sfOk = useMemo(() => sfAvailable(), [])
  const current: FontId | undefined = a.font
  const customName = a.customFont?.split('|')[0]
  return (
    <div className="font-grid">
      {FONT_CHOICES.map((f) => {
        const disabled = f.id === 'sf' && !sfOk
        const on = current === f.id
        const hint = f.id === 'sf' ? (sfBundled ? 'A da Apple' : sfOk ? 'A da Apple (instalada no seu PC)' : 'Não está instalada neste PC') : f.id === 'custom' && customName ? customName : f.hint
        return (
          <button
            key={f.id}
            className={'font-card' + (on ? ' on' : '')}
            disabled={disabled}
            onClick={() => (f.id === 'custom' ? void pickFile() : setFont({ font: f.id }))}
            style={{ fontFamily: f.id === 'custom' && !customName ? undefined : stackOf(f.id) }}
          >
            <span className="font-aa">Aa</span>
            <span className="font-sample">Oi! Tudo certo pra amanhã? 👋</span>
            <span className="font-name">{f.label}</span>
            <span className="font-hint">{hint}</span>
          </button>
        )
      })}
    </div>
  )
}

/** first launch: pick a font (it changes live behind the card) */
export function FontPicker({ a, onDone }: { a: Appearance; onDone: () => void }) {
  return (
    <motion.div className="scrim font-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
      <motion.div
        className="dialog font-dialog"
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 8, scale: 0.99 }}
        transition={{ type: 'spring', stiffness: 420, damping: 34 }}
      >
        <h3>Escolha a fonte do Zapdesk</h3>
        <p className="font-lead">Dá pra trocar quando quiser em Configurações → Aparência.</p>
        <FontChoices a={a} />
        <div className="font-actions">
          <button
            className="btn primary"
            onClick={() => {
              setFont({ font: a.font ?? (sfBundled ? 'sf' : 'segoe') })
              onDone()
            }}
          >
            Pronto
          </button>
        </div>
      </motion.div>
    </motion.div>
  )
}
