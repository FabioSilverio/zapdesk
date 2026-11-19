import { askText } from './components/overlays'

const at = (d: Date, h: number, m = 0) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime()

/** quick "when" options shared by Agendar and Lembrar */
export function timeChoices(): { label: string; at: number }[] {
  const now = new Date()
  const list = [
    { label: 'Em 30 minutos', at: Date.now() + 30 * 60_000 },
    { label: 'Em 1 hora', at: Date.now() + 60 * 60_000 },
    { label: 'Em 3 horas', at: Date.now() + 3 * 60 * 60_000 }
  ]
  const tonight = at(now, 18)
  if (tonight - Date.now() > 45 * 60_000) list.push({ label: 'Hoje às 18:00', at: tonight })
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  list.push({ label: 'Amanhã às 9:00', at: at(tomorrow, 9) })
  return list
}

const pad = (n: number) => String(n).padStart(2, '0')
function localInput(ts: number) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export async function pickCustomTime(title: string): Promise<number | null> {
  const v = await askText(title, undefined, localInput(Date.now() + 60 * 60_000), 'datetime-local')
  if (!v) return null
  const ts = new Date(v).getTime()
  return Number.isFinite(ts) ? ts : null
}

const fmt = new Intl.DateTimeFormat('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
const fmtTime = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' })
export function fmtWhen(ts: number) {
  const d = new Date(ts)
  const today = new Date()
  if (d.toDateString() === today.toDateString()) return 'hoje ' + fmtTime.format(ts)
  return fmt.format(ts)
}
