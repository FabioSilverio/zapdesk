import { useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { useStore, zap } from '../state'

export function Login() {
  const kind = useStore((s) => s.accounts.find((a) => a.active)?.kind ?? 'wa')
  return kind === 'tg' ? <TgLogin /> : <WaLogin />
}

function BackToOther() {
  const accounts = useStore((s) => s.accounts)
  const others = accounts.filter((a) => !a.active)
  if (!others.length) return null
  return (
    <div className="login-back">
      <button
        className="btn ghost"
        onClick={async () => {
          const me = accounts.find((a) => a.active)
          // an account that never logged in is just discarded
          if (me && !me.phone) await zap.removeAccount(me.id)
          else await zap.switchAccount(others[0].id)
        }}
      >
        ← Cancelar e voltar pra {others[0].label}
      </button>
    </div>
  )
}

/** Telegram: 1) app keys from my.telegram.org (once)  2) QR from the phone  3) two-step password, if any */
function TgLogin() {
  const qr = useStore((s) => s.qr)
  const conn = useStore((s) => s.conn)
  const hint = useStore((s) => s.passwordHint)
  const loginError = useStore((s) => s.loginError)
  const [apiId, setApiId] = useState('')
  const [apiHash, setApiHash] = useState('')
  const [pw, setPw] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const shown = err || loginError
  const step = conn === 'setup' ? 'setup' : conn === 'password' ? 'password' : 'qr'
  return (
    <div className="login drag">
      <motion.div className="login-card no-drag" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ type: 'spring', stiffness: 300, damping: 30 }}>
        <div className="login-text">
          <h1>Telegram</h1>
          {step === 'setup' ? (
            <>
              <p>Uma vez só: crie a chave do seu Zapdesk no site do Telegram (leva 1 minuto).</p>
              <ol>
                <li>
                  Abra{' '}
                  <a href="https://my.telegram.org/apps" target="_blank" rel="noreferrer">
                    my.telegram.org/apps
                  </a>{' '}
                  e entre com seu número
                </li>
                <li>
                  Em <b>App title</b> coloque “Zapdesk”, em <b>Short name</b> “zapdesk”, plataforma <b>Desktop</b>
                </li>
                <li>
                  Copie o <b>api_id</b> e o <b>api_hash</b> pra cá
                </li>
              </ol>
            </>
          ) : step === 'password' ? (
            <p>Sua conta tem verificação em duas etapas. Digite a senha do Telegram{hint ? ` (dica: ${hint})` : ''}.</p>
          ) : (
            <>
              <p>Use seu Telegram aqui no PC.</p>
              <ol>
                <li>Abra o Telegram no celular</li>
                <li>
                  Vá em <b>Configurações</b> → <b>Dispositivos</b>
                </li>
                <li>
                  Toque em <b>Conectar dispositivo</b> e aponte pra este QR
                </li>
              </ol>
            </>
          )}
          <BackToOther />
        </div>
        <div className="login-qr">
          <AnimatePresence mode="wait">
            {step === 'setup' ? (
              <motion.form
                key="setup"
                className="phone-box"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onSubmit={async (e) => {
                  e.preventDefault()
                  setErr(null)
                  setBusy(true)
                  try {
                    await zap.tgSetup(apiId, apiHash)
                  } catch (x: any) {
                    setErr(String(x?.message ?? x).replace(/^Error invoking remote method '\w+': (Error: )?/, ''))
                  } finally {
                    setBusy(false)
                  }
                }}
              >
                <input autoFocus value={apiId} onChange={(e) => setApiId(e.target.value)} placeholder="api_id (ex: 1234567)" inputMode="numeric" />
                <input value={apiHash} onChange={(e) => setApiHash(e.target.value)} placeholder="api_hash (32 caracteres)" spellCheck={false} />
                <button className="btn primary" disabled={busy || !apiId || !apiHash}>
                  {busy ? 'Conectando…' : 'Continuar'}
                </button>
                {shown && <p className="err">{shown}</p>}
              </motion.form>
            ) : step === 'password' ? (
              <motion.form
                key="pw"
                className="phone-box"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onSubmit={(e) => {
                  e.preventDefault()
                  if (!pw) return
                  void zap.tgPassword(pw)
                  setPw('')
                }}
              >
                <input autoFocus type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Senha do Telegram" />
                <button className="btn primary" disabled={!pw}>
                  Entrar
                </button>
                {shown && <p className="err">{shown}</p>}
              </motion.form>
            ) : (
              <motion.div key={qr ?? 'wait'} initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
                {qr ? (
                  <img src={qr} alt="QR code" />
                ) : (
                  <div className="qr-wait">
                    <span className="media-spin" />
                    <span>{conn === 'reconnecting' ? 'Reconectando…' : 'Conectando ao Telegram…'}</span>
                  </div>
                )}
                {shown && <p className="err">{shown}</p>}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </div>
  )
}

function WaLogin() {
  const qr = useStore((s) => s.qr)
  const conn = useStore((s) => s.conn)
  const accounts = useStore((s) => s.accounts)
  const others = accounts.filter((a) => !a.active)
  const [mode, setMode] = useState<'qr' | 'phone'>('qr')
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const askCode = async () => {
    setErr(null)
    let digits = phone.replace(/\D/g, '')
    if (digits.length === 10 || digits.length === 11) digits = '55' + digits
    try {
      const c = await zap.pairingCode(digits)
      setCode(c.match(/.{1,4}/g)?.join('-') ?? c)
    } catch (e: any) {
      setErr(e?.message ?? 'Não consegui gerar o código')
    }
  }

  return (
    <div className="login drag">
      <motion.div className="login-card no-drag" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ type: 'spring', stiffness: 300, damping: 30 }}>
        <div className="login-text">
          <h1>Zapdesk</h1>
          <p>Use seu WhatsApp aqui no PC.</p>
          <ol>
            <li>Abra o WhatsApp no celular</li>
            <li>
              Toque em <b>Mais opções</b> ou <b>Configurações</b> → <b>Dispositivos conectados</b>
            </li>
            <li>
              Toque em <b>Conectar dispositivo</b> e {mode === 'qr' ? 'aponte pra este QR' : 'use o código abaixo'}
            </li>
          </ol>
          <button className="link-btn" onClick={() => setMode(mode === 'qr' ? 'phone' : 'qr')}>
            {mode === 'qr' ? 'Conectar com número de telefone' : 'Voltar pro QR code'}
          </button>
          {others.length > 0 && (
            <div className="login-back">
              <button
                className="btn ghost"
                onClick={async () => {
                  const me = accounts.find((a) => a.active)
                  // an account that never logged in is just discarded
                  if (me && !me.phone) await zap.removeAccount(me.id)
                  else await zap.switchAccount(others[0].id)
                }}
              >
                ← Cancelar e voltar pra {others[0].label}
              </button>
            </div>
          )}
        </div>
        <div className="login-qr">
          <AnimatePresence mode="wait">
            {mode === 'qr' ? (
              <motion.div key={qr ?? 'wait'} initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
                {qr ? <img src={qr} alt="QR code" /> : <div className="qr-wait"><span className="media-spin" /><span>{conn === 'reconnecting' ? 'Reconectando…' : 'Gerando QR…'}</span></div>}
              </motion.div>
            ) : (
              <motion.div key="phone" className="phone-box" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                {code ? (
                  <>
                    <div className="pair-code">{code}</div>
                    <p className="dim">Digite esse código no celular</p>
                  </>
                ) : (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault()
                      void askCode()
                    }}
                  >
                    <input autoFocus value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(11) 91234-5678" />
                    <button className="btn primary" disabled={!qr}>
                      Gerar código
                    </button>
                    {err && <p className="err">{err}</p>}
                  </form>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </div>
  )
}
