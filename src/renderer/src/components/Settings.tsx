import { FontChoices } from './FontPicker'
import { useEffect, useState, type ReactNode } from 'react'
import { motion } from 'motion/react'
import type { Appearance, Settings as S } from '@shared/types'
import { getState, setState, toast, useStore, zap } from '../state'
import { THEMES, themeOf } from '../themes'
import { PinSetup } from './Lock'
import { askConfirm, askText } from './overlays'
import { colorOf } from '../format'
import { fmtWhen } from '../tools'
import { X } from './icons'
import { installUpdate } from './Sidebar'

export async function updateSettings(patch: Partial<S>) {
  const cur = getState().settings!
  setState({ settings: { ...cur, ...patch, appearance: { ...cur.appearance, ...(patch.appearance ?? {}) } } })
  const saved = await zap.setSettings(patch)
  setState({ settings: saved })
}
const setLook = (p: Partial<Appearance>) => void updateSettings({ appearance: p as Appearance })

function Seg<T extends string | number>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {options.map(([v, label]) => (
        <button key={String(v)} className={value === v ? 'on' : ''} onClick={() => onChange(v)}>
          {value === v && <motion.i layoutId={'seg-' + options.map((o) => o[0]).join()} className="seg-pill" transition={{ type: 'spring', stiffness: 600, damping: 40 }} />}
          <span>{label}</span>
        </button>
      ))}
    </div>
  )
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button className={'toggle' + (on ? ' on' : '')} onClick={() => onChange(!on)} role="switch" aria-checked={on}>
      <motion.i layout transition={{ type: 'spring', stiffness: 700, damping: 35 }} />
    </button>
  )
}

const Row = ({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) => (
  <div className="set-row">
    <div>
      <div className="set-label">{label}</div>
      {hint && <div className="set-hint">{hint}</div>}
    </div>
    {children}
  </div>
)

function AppearanceTab({ a }: { a: Appearance }) {
  const theme = themeOf(a.theme)
  return (
    <>
      <h4>Tema</h4>
      <div className="theme-grid">
        {THEMES.map((t) => (
          <button key={t.id} className={'theme-card' + (a.theme === t.id ? ' on' : '')} onClick={() => setLook({ theme: t.id, accent: null })}>
            <div className="theme-prev" style={{ background: t.tokens.bg }}>
              <div style={{ background: t.tokens['bg-side'] }} className="tp-side">
                <i style={{ background: t.accent }} />
                <i style={{ background: t.tokens['bg-active'] }} />
                <i style={{ background: t.tokens['bg-active'] }} />
              </div>
              <div className="tp-main">
                <i style={{ background: t.tokens['bubble-in'] }} />
                <i className="r" style={{ background: `color-mix(in oklab, ${t.accent} ${t.outMix + 10}%, ${t.tokens['bubble-in']})` }} />
                <i style={{ background: t.tokens['bubble-in'], width: '45%' }} />
              </div>
            </div>
            <span>{t.name}</span>
          </button>
        ))}
      </div>

      <h4>Cor de destaque</h4>
      <div className="swatches">
        <button className={'swatch auto' + (a.accent === null ? ' on' : '')} title="Padrão do tema" onClick={() => setLook({ accent: null })} style={{ ['--sw' as string]: theme.accent }}>
          A
        </button>
        {theme.swatches.map((s) => (
          <button key={s.color} title={s.name} className={'swatch' + (a.accent === s.color ? ' on' : '')} style={{ ['--sw' as string]: s.color }} onClick={() => setLook({ accent: s.color })} />
        ))}
        <label className="swatch custom" title="Cor personalizada">
          <input type="color" value={a.accent ?? theme.accent} onChange={(e) => setLook({ accent: e.target.value })} />+
        </label>
      </div>

      <h4>Layout</h4>
      <Row label="Densidade">
        <Seg value={a.density} options={[['compacto', 'Compacto'], ['confortavel', 'Confortável']]} onChange={(density) => setLook({ density })} />
      </Row>
      <Row label="Mensagens" hint="Bolhas estilo WhatsApp ou lista alinhada à esquerda">
        <Seg value={a.messages} options={[['bolhas', 'Bolhas'], ['lista', 'Lista']]} onChange={(messages) => setLook({ messages })} />
      </Row>
      <Row label="Conversas fixadas">
        <Seg value={a.pinned} options={[['lista', 'Seção em lista'], ['grade', 'Ícones grandes']]} onChange={(pinned) => setLook({ pinned })} />
      </Row>
      <Row label="Cantos">
        <Seg value={a.radius} options={[['suave', 'Suaves'], ['reto', 'Retos']]} onChange={(radius) => setLook({ radius })} />
      </Row>
      <Row label="Vidro (Liquid Glass)" hint="Janela translúcida com o fundo do Windows desfocado atrás e painéis de vidro. Leve: quem desfoca é o próprio Windows">
        <Toggle on={a.glass !== false} onChange={(glass) => setLook({ glass })} />
      </Row>
      <PerformanceRows />
      <h4>Escala</h4>
      <Row label="Crescer junto com a janela" hint="Arrastou a borda ou maximizou, tudo aumenta proporcionalmente">
        <Toggle on={a.autoScale} onChange={(autoScale) => setLook({ autoScale })} />
      </Row>
      <Row label="Zoom" hint={`${Math.round((a.zoom || 1) * 100)}% · Ctrl + / Ctrl − / Ctrl 0 · Ctrl + roda do mouse`}>
        <input type="range" min={0.7} max={1.6} step={0.05} value={a.zoom || 1} onChange={(e) => setLook({ zoom: +e.target.value })} />
      </Row>
      <h4>Fonte</h4>
      <FontChoices a={a} />
      <Row label="Tamanho do texto" hint={a.fontSize + 'px'}>
        <input type="range" min={12} max={18} step={1} value={a.fontSize} onChange={(e) => setLook({ fontSize: +e.target.value })} />
      </Row>
      <Row label="Largura da barra lateral" hint={a.sidebarWidth + 'px'}>
        <input type="range" min={220} max={380} step={4} value={a.sidebarWidth} onChange={(e) => setLook({ sidebarWidth: +e.target.value })} />
      </Row>
    </>
  )
}

function UpdatesSection() {
  const version = useStore((st) => st.version)
  const update = useStore((st) => st.update)
  const [checking, setChecking] = useState(false)
  return (
    <>
      <h4>Atualizações</h4>
      <Row label={'Zapdesk ' + (version || '')} hint={update ? `Versão ${update.version} pronta pra instalar${update.notes.length ? ': ' + update.notes.join(' · ') : ''}` : 'Quando sair versão nova aparece um botão verde no rodapé — um clique e pronto'}>
        {update ? (
          <button className="btn primary" onClick={() => void installUpdate()}>
            Atualizar
          </button>
        ) : (
          <button
            className="btn"
            disabled={checking}
            onClick={async () => {
              setChecking(true)
              const u = await zap.checkUpdate().catch(() => null)
              setState({ update: u })
              setChecking(false)
              if (!u) toast('Você já está na versão mais nova ✓')
            }}
          >
            {checking ? 'Procurando…' : 'Procurar'}
          </button>
        )}
      </Row>
    </>
  )
}

function AccountsSection() {
  const accounts = useStore((st) => st.accounts)
  const connLabel = (c: string) => (c === 'open' ? 'conectada' : c === 'qr' ? 'aguardando login' : c === 'offline' ? 'desligada' : 'conectando…')
  return (
    <>
      <h4>Contas do WhatsApp</h4>
      <p className="set-hint" style={{ margin: '0 0 8px' }}>
        Todas ficam conectadas ao mesmo tempo e mandam notificação. Troque pelo seu nome no canto de baixo.
      </p>
      {accounts.map((a) => (
        <div key={a.id} className={'acc-row' + (a.active ? ' on' : '')}>
          <span className="acc-dot big" style={{ background: colorOf(a.id) }} />
          <div className="acc-info">
            <b>
              {a.label} {a.active && <span className="acc-tag">na tela</span>}
            </b>
            <span>
              {a.phone ? '+' + a.phone + ' · ' : ''}
              {connLabel(a.conn)}
              {a.unread ? ` · ${a.unread} não lidas` : ''}
            </span>
          </div>
          {!a.active && (
            <button className="btn" onClick={() => void zap.switchAccount(a.id)}>
              Abrir
            </button>
          )}
          <button
            className="icon-btn sm"
            title="Renomear"
            onClick={async () => {
              const name = await askText('Nome desta conta', 'ex: Pessoal, Trabalho', a.label)
              if (name) await zap.renameAccount(a.id, name)
            }}
          >
            ✎
          </button>
          <button
            className="icon-btn sm"
            title="Remover do Zapdesk"
            onClick={async () => {
              const ok = await askConfirm(
                `Remover ${a.label} do Zapdesk?`,
                'Desconecta este PC dessa conta e apaga as conversas salvas aqui. Nada é apagado do celular — dá pra conectar de novo lendo o QR.',
                'Remover',
                true
              )
              if (ok) await zap.removeAccount(a.id).catch((e) => toast(String(e?.message ?? e)))
            }}
          >
            <X size={12} />
          </button>
        </div>
      ))}
      <button className="btn" style={{ marginTop: 8 }} onClick={() => void zap.addAccount()}>
        + Adicionar outra conta
      </button>
    </>
  )
}

function TranscriptionSection({ s }: { s: S }) {
  const w = useStore((st) => st.whisper)
  return (
    <>
      <h4>Transcrição de áudios 🎤</h4>
      <Row
        label="Motor de transcrição"
        hint={
          w.ready
            ? 'Instalado · roda no seu PC, o áudio não sai daqui. Clique no ícone ☰ de um áudio pra transcrever'
            : w.progress !== null
              ? `Baixando… ${w.progress}%`
              : 'Download único de ~200 MB (Whisper). Funciona offline, sem custo, em português'
        }
      >
        {w.ready ? (
          <button
            className="btn"
            onClick={async () => {
              if (await askConfirm('Remover a transcrição?', 'Apaga o motor (~200 MB). Os textos já transcritos continuam.', 'Remover', true)) void zap.whisperRemove()
            }}
          >
            Remover
          </button>
        ) : w.progress !== null ? (
          <button className="btn" onClick={() => void zap.whisperCancel()}>
            Cancelar
          </button>
        ) : (
          <button className="btn primary" onClick={() => void zap.whisperInstall()}>
            Baixar
          </button>
        )}
      </Row>
      {w.progress !== null && (
        <div className="dl-bar">
          <i style={{ transform: `scaleX(${w.progress / 100})` }} />
        </div>
      )}
      <Row label="Transcrever automaticamente" hint="Áudios que você recebe já chegam com o texto, até nas conversas fechadas (e na lista de conversas). Os que você clica passam na frente.">
        <Toggle on={!!s.autoTranscribe} onChange={(autoTranscribe) => void updateSettings({ autoTranscribe })} />
      </Row>
    </>
  )
}

function ToolsTab({ s }: { s: S }) {
  const scheduled = useStore((st) => st.scheduled)
  const reminders = useStore((st) => st.reminders)
  const chats = useStore((st) => st.chats)
  const ghost = (p: Partial<S['ghost']>) => void updateSettings({ ghost: { ...s.ghost, ...p } })
  const nameOf = (id: string) => chats[id]?.name ?? id.split('@')[0]
  return (
    <>
      <h4>Mensagens</h4>
      <Row label="Anti-apagar" hint="Quando alguém apaga uma mensagem pra todos, ela continua aqui marcada como apagada">
        <Toggle on={s.keepDeleted} onChange={(keepDeleted) => void updateSettings({ keepDeleted })} />
      </Row>
      <Row label="Links com nome e prévia" hint="Mostra o título do site no lugar da URL + cartão com imagem, e envia a prévia junto quando você manda um link">
        <Toggle on={s.linkPreviews} onChange={(linkPreviews) => void updateSettings({ linkPreviews })} />
      </Row>
      <Row label="Espiar ao passar o mouse" hint="Parar o mouse numa conversa da lista mostra as últimas mensagens num cartão, sem abrir nem marcar como lida">
        <Toggle on={s.hoverPeek !== false} onChange={(hoverPeek) => void updateSettings({ hoverPeek })} />
      </Row>
      <Row label="Formatação" hint="Selecione o texto pra ver a barrinha · Ctrl+B negrito · Ctrl+I itálico · Ctrl+Shift+X tachado · Ctrl+E código · > citação · - lista">
        <span />
      </Row>
      <Row label="Modo privacidade" hint="Borra prévias e mensagens até passar o mouse · Ctrl+Shift+B">
        <Toggle on={s.privacyBlur} onChange={(privacyBlur) => void updateSettings({ privacyBlur })} />
      </Row>

      <TranscriptionSection s={s} />

      <h4>Modo fantasma 👻</h4>
      <Row label="Ler sem enviar visto" hint="Os outros continuam vendo ✓✓ cinza. No menu da conversa tem “Enviar visto agora”">
        <Toggle on={s.ghost.noReadReceipts} onChange={(noReadReceipts) => ghost({ noReadReceipts })} />
      </Row>
      <Row label="Esconder “digitando…”">
        <Toggle on={s.ghost.noTyping} onChange={(noTyping) => ghost({ noTyping })} />
      </Row>
      <Row label="Não aparecer online">
        <Toggle on={s.ghost.hideOnline} onChange={(hideOnline) => ghost({ hideOnline })} />
      </Row>

      <h4>Respostas rápidas</h4>
      <p className="set-hint" style={{ margin: '0 0 8px' }}>
        Digite <b>/</b> + atalho no campo de mensagem (ex: <b>/oi</b>) e aperte Tab ou Enter.
      </p>
      <div className="quick-list">
        {s.quickReplies.map((q, i) => (
          <div key={q.key + i} className="quick-row">
            <b>/{q.key}</b>
            <span>{q.text}</span>
            <button
              className="icon-btn sm"
              title="Editar"
              onClick={async () => {
                const text = await askText(`Editar /${q.key}`, 'Texto da resposta', q.text, 'textarea')
                if (!text) return
                const list = s.quickReplies.slice()
                list[i] = { ...q, text }
                void updateSettings({ quickReplies: list })
              }}
            >
              ✎
            </button>
            <button className="icon-btn sm" title="Remover" onClick={() => void updateSettings({ quickReplies: s.quickReplies.filter((_, j) => j !== i) })}>
              <X size={12} />
            </button>
          </div>
        ))}
      </div>
      <button
        className="btn"
        style={{ marginTop: 8 }}
        onClick={async () => {
          const key = (await askText('Atalho (sem a barra)', 'ex: endereco'))?.replace(/^\//, '').replace(/\s+/g, '').toLowerCase()
          if (!key) return
          const text = await askText(`Texto de /${key}`, 'O que vai ser enviado', undefined, 'textarea')
          if (!text) return
          void updateSettings({ quickReplies: [...s.quickReplies.filter((q) => q.key !== key), { key, text }] })
        }}
      >
        + Nova resposta rápida
      </button>

      <h4>Agendadas</h4>
      {scheduled.length ? (
        scheduled.map((x) => (
          <Row key={x.id} label={`${nameOf(x.chatId)} · ${fmtWhen(x.at)}`} hint={x.text}>
            <button className="btn ghost" onClick={() => void zap.cancelScheduled(x.id)}>
              Cancelar
            </button>
          </Row>
        ))
      ) : (
        <p className="set-hint">Nada agendado. No campo de mensagem, clique no relógio (ou botão direito no enviar).</p>
      )}

      <h4>Lembretes</h4>
      {reminders.length ? (
        reminders.map((x) => (
          <Row key={x.id} label={`${nameOf(x.chatId)} · ${fmtWhen(x.at)}`} hint={x.text}>
            <button className="btn ghost" onClick={() => void zap.cancelReminder(x.id)}>
              Cancelar
            </button>
          </Row>
        ))
      ) : (
        <p className="set-hint">Nenhum lembrete. Botão direito numa mensagem → “Lembrar disso…”.</p>
      )}
      <p className="set-foot">Exportar conversa: botão direito na conversa → “Exportar conversa (.txt)”.</p>
    </>
  )
}

export function SettingsModal() {
  const s = useStore((st) => st.settings)!
  const hasPin = useStore((st) => st.hasPin)
  const me = useStore((st) => st.me)
  const [tab, setTab] = useState<'look' | 'tools' | 'notif' | 'sec' | 'geral'>(() => (getState().settingsTab as any) ?? 'look')
  const [changingPin, setChangingPin] = useState(false)
  const close = () => setState({ settingsOpen: false })
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !changingPin && !document.querySelector('.dialog, .menu')) {
        e.preventDefault()
        setState({ settingsOpen: false })
      }
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [changingPin])

  if (changingPin) return <PinSetup canCancel onDone={() => setChangingPin(false)} />

  return (
    <motion.div className="scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={close}>
      <motion.div
        className="settings"
        initial={{ opacity: 0, scale: 0.97, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.98, y: 6 }}
        transition={{ type: 'spring', stiffness: 460, damping: 36 }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <nav className="set-nav">
          <h3>Configurações</h3>
          {(
            [
              ['look', 'Aparência'],
              ['tools', 'Ferramentas'],
              ['notif', 'Notificações'],
              ['sec', 'Segurança'],
              ['geral', 'Geral']
            ] as const
          ).map(([id, label]) => (
            <button key={id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
              {tab === id && <motion.i layoutId="set-nav-pill" className="nav-pill" transition={{ type: 'spring', stiffness: 600, damping: 42 }} />}
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="set-body">
          <button className="icon-btn set-close" onClick={close}>
            <X />
          </button>
          {tab === 'look' && <AppearanceTab a={s.appearance} />}
          {tab === 'tools' && <ToolsTab s={s} />}
          {tab === 'notif' && (
            <>
              <h4>Notificações do Windows</h4>
              <Row label="Mostrar notificações">
                <Toggle on={s.notifications} onChange={(notifications) => void updateSettings({ notifications })} />
              </Row>
              <Row label="Mostrar prévia da mensagem" hint="Quando bloqueado, a prévia sempre fica escondida">
                <Toggle on={s.notifyPreview} onChange={(notifyPreview) => void updateSettings({ notifyPreview })} />
              </Row>
              <Row label="Som">
                <Toggle on={s.sound} onChange={(sound) => void updateSettings({ sound })} />
              </Row>
            </>
          )}
          {tab === 'sec' && (
            <>
              <h4>Bloqueio</h4>
              <Row label="Bloquear depois de inativo">
                <select value={s.lockMinutes} onChange={(e) => void updateSettings({ lockMinutes: +e.target.value })}>
                  {[1, 5, 10, 15, 30, 60].map((n) => (
                    <option key={n} value={n}>
                      {n} min
                    </option>
                  ))}
                  <option value={0}>Nunca</option>
                </select>
              </Row>
              <Row label={hasPin ? 'Trocar PIN' : 'Criar PIN'} hint="4 ou 6 dígitos">
                <button className="btn" onClick={() => setChangingPin(true)}>
                  {hasPin ? 'Trocar' : 'Criar'}
                </button>
              </Row>
              <Row label="Bloquear agora" hint="Atalho: Ctrl+L">
                <button className="btn" disabled={!hasPin} onClick={() => void zap.lockNow().then(close)}>
                  Bloquear
                </button>
              </Row>
            </>
          )}
          {tab === 'geral' && (
            <>
              <h4>Janela</h4>
              <Row label="Fechar minimiza pra bandeja" hint="Continua recebendo mensagens e alertas">
                <Toggle on={s.closeToTray} onChange={(closeToTray) => void updateSettings({ closeToTray })} />
              </Row>
              <Row label="Esc sai da conversa" hint="Volta pra tela inicial (fecha antes emoji, menu, foto ou resposta, se tiver algum aberto)">
                <Toggle on={s.escClosesChat} onChange={(escClosesChat) => void updateSettings({ escClosesChat })} />
              </Row>
              <Row label="Iniciar com o Windows">
                <Toggle on={s.startWithWindows} onChange={(startWithWindows) => void updateSettings({ startWithWindows })} />
              </Row>
              <h4>Seções</h4>
              <div className="chips">
                {s.sections.map((sec) => (
                  <span key={sec} className="chip">
                    {sec}
                    <button onClick={() => void updateSettings({ sections: s.sections.filter((x) => x !== sec) })}>
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>
              <AccountsSection />
              <UpdatesSection />
              <p className="set-foot">Ctrl+/ mostra todos os atalhos · Ctrl+Tab ou Alt+' troca de conta (WhatsApp ⇄ Telegram) · Ctrl+1…9 abre conversas · Ctrl+K busca · Alt+↑/↓ navega · Esc sai da conversa · Ctrl+L bloqueia · Ctrl+Shift+B modo privacidade · Ctrl +/− zoom · Ctrl+, configurações · Ctrl+C/Ctrl+V copiar e colar (inclusive arquivos e prints)</p>
            </>
          )}
        </div>
      </motion.div>
    </motion.div>
  )
}

/** Desempenho: lite mode + a diagnostics file to send when something feels slow on another PC */
function PerformanceRows() {
  const perf = useStore((st) => st.settings?.performance ?? 'auto')
  const lowEnd = useStore((st) => st.lowEnd)
  const [busy, setBusy] = useState(false)
  return (
    <>
      <Row
        label="Desempenho"
        hint={
          perf === 'auto'
            ? lowEnd
              ? 'Este PC é mais fraco (ou sem aceleração de vídeo): rodando no modo leve — sem vidro, desfoque e animações'
              : 'Este PC aguenta tudo: efeitos completos. Num PC fraco o modo leve liga sozinho'
            : perf === 'leve'
              ? 'Sem vidro, desfoque e animações; menos downloads e transcrições em segundo plano'
              : 'Todos os efeitos, mesmo num PC fraco'
        }
      >
        <Seg value={perf} options={[['auto', 'Automático'], ['leve', 'Leve'], ['completo', 'Completo']]} onChange={(performance) => void updateSettings({ performance })} />
      </Row>
      <Row label="Diagnóstico" hint="Salva na Área de Trabalho um arquivo com as informações do PC, como o app está rodando e os erros recentes (sem conteúdo de mensagens), pra você mandar">
        <button
          className="btn"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            try {
              const f = await zap.exportDiagnostics()
              if (f) toast('Diagnóstico salvo na Área de Trabalho ✓')
            } catch {
              toast('Não deu pra salvar o diagnóstico')
            } finally {
              setBusy(false)
            }
          }}
        >
          Exportar
        </button>
      </Row>
    </>
  )
}
