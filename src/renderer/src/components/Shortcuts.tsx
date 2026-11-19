// Ctrl+/ : every keyboard shortcut in one place
import { useEffect } from 'react'
import { motion } from 'motion/react'

const GROUPS: { title: string; items: [string, string][] }[] = [
  {
    title: 'Contas',
    items: [
      ['Ctrl Tab', 'Próxima conta (WhatsApp ⇄ Telegram)'],
      ['Ctrl Shift Tab', 'Conta anterior'],
      ["Alt '", "Próxima conta (tecla abaixo do Esc) · com Shift volta"],
      ['Ctrl Alt 1…9', 'Ir direto pra conta 1, 2, 3…']
    ]
  },
  {
    title: 'Conversas',
    items: [
      ['Ctrl 1…9', 'Abrir a conversa da posição'],
      ['Alt ↑ · ↓', 'Conversa de cima / de baixo'],
      ['Ctrl K', 'Buscar conversas'],
      ['Esc', 'Sair da conversa (ou fechar o que estiver aberto)']
    ]
  },
  {
    title: 'Escrevendo',
    items: [
      ['Enter', 'Enviar · Shift Enter quebra linha'],
      ['Ctrl B · Ctrl I', 'Negrito · itálico'],
      ['Ctrl Shift X · Ctrl E', 'Tachado · código'],
      ['/', 'Respostas rápidas'],
      ['Ctrl V', 'Colar texto, print ou arquivos copiados']
    ]
  },
  {
    title: 'App',
    items: [
      ['Ctrl L', 'Bloquear com o PIN'],
      ['Ctrl Shift B', 'Modo privacidade (borra as mensagens)'],
      ['Ctrl + · − · 0', 'Zoom'],
      ['Ctrl ,', 'Configurações'],
      ['Ctrl /', 'Esta lista']
    ]
  }
]

export function Shortcuts({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', k, true)
    return () => window.removeEventListener('keydown', k, true)
  }, [onClose])
  return (
    <motion.div className="scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }} onClick={onClose}>
      <motion.div
        className="dialog shortcuts"
        initial={{ opacity: 0, y: 10, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 6, scale: 0.99 }}
        transition={{ type: 'spring', stiffness: 460, damping: 34 }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>Atalhos do teclado</h3>
        <div className="sc-grid">
          {GROUPS.map((g) => (
            <section key={g.title}>
              <h4>{g.title}</h4>
              {g.items.map(([keys, what]) => (
                <div key={keys} className="sc-row">
                  <span className="sc-keys">
                    {keys.split(' ').map((k, i) => (k === '·' ? <span key={i}>{k}</span> : <kbd key={i}>{k}</kbd>))}
                  </span>
                  <span className="sc-what">{what}</span>
                </div>
              ))}
            </section>
          ))}
        </div>
      </motion.div>
    </motion.div>
  )
}
