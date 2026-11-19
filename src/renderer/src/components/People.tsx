// @mentions and phone numbers inside messages: shown by name, clickable → photo, name, number, "Conversar".
import { createContext, useContext } from 'react'
import type { UiMessage } from '@shared/types'
import { getState, openChat, setState, toast, zap } from '../state'
import { Avatar } from './Avatar'
import { showMenu } from './overlays'
import { Copy, Eye, Reply } from './icons'

export const MentionCtx = createContext<UiMessage['mentions']>(undefined)

const isPhoneJid = (id: string) => id.endsWith('@s.whatsapp.net')
export const phoneOf = (id: string) => (isPhoneJid(id) ? '+' + id.split('@')[0] : undefined)

/** opens (or starts) the 1:1 chat with someone; numbers are checked with WhatsApp first (the extra-9 problem) */
export async function openPerson(id: string, name?: string) {
  if (!id || id.endsWith('@g.us')) return
  let target = id
  if (isPhoneJid(id) && getState().conn === 'open') {
    const real = await zap.resolveNumber(id.split('@')[0]).catch(() => undefined)
    if (real === null) return toast('Esse número não tem WhatsApp')
    if (real) target = real
  }
  const s = getState()
  if (!s.chats[target])
    setState({
      chats: {
        ...s.chats,
        [target]: { id: target, name: name || phoneOf(target) || target.split('@')[0], ts: Date.now(), unread: 0, pinned: 0, muted: false, archived: false, isGroup: false }
      }
    })
  void openChat(target)
}

export function personMenu(e: { clientX: number; clientY: number }, p: { id: string; name: string }) {
  const phone = phoneOf(p.id)
  const known = getState().chats[p.id]?.name
  const name = known || p.name
  showMenu(e, [
    {
      label: name + (phone && phone !== name ? '\n' + phone : ''),
      icon: <Avatar id={p.id} name={name} size={40} />,
      onClick: () => window.dispatchEvent(new CustomEvent('zap:image', { detail: `zap://avatar/${encodeURIComponent(p.id)}?big=1` }))
    },
    { divider: true, label: '' },
    { label: 'Conversar com ' + name.split(' ')[0], icon: <Reply size={15} />, onClick: () => void openPerson(p.id, name) },
    { label: 'Ver foto', icon: <Eye size={15} />, onClick: () => window.dispatchEvent(new CustomEvent('zap:image', { detail: `zap://avatar/${encodeURIComponent(p.id)}?big=1` })) },
    ...(phone ? [{ label: 'Copiar número', icon: <Copy size={15} />, onClick: () => void navigator.clipboard.writeText(phone).then(() => toast('Número copiado')) }] : [])
  ])
}

/** "@5511999…" / "@2658028…" (WhatsApp's hidden id) → "@Nome" */
export function Mention({ token, raw }: { token: string; raw: string }) {
  const mentions = useContext(MentionCtx)
  const who = mentions?.[token]
  if (!who) return <>{raw}</>
  return (
    <button
      className="mention"
      onClick={(e) => {
        e.stopPropagation()
        personMenu(e, who)
      }}
    >
      @{who.name}
    </button>
  )
}

/** a phone number typed in a message */
export function PhoneText({ raw }: { raw: string }) {
  let digits = raw.replace(/\D/g, '')
  if (digits.length === 10 || digits.length === 11) digits = '55' + digits
  // only on WhatsApp accounts a number is a chat address
  const wa = (getState().accounts.find((a) => a.active)?.kind ?? 'wa') === 'wa'
  if (!wa || digits.length < 12 || digits.length > 15) return <>{raw}</>
  const id = digits + '@s.whatsapp.net'
  return (
    <button
      className="mention phone"
      onClick={(e) => {
        e.stopPropagation()
        personMenu(e, { id, name: getState().chats[id]?.name || raw.trim() })
      }}
    >
      {raw}
    </button>
  )
}
