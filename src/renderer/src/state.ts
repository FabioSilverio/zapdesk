import { useSyncExternalStore } from 'react'
import type { Folder, UpdateInfo, WhisperState, AccountSummary, ConnState, FavSticker, MainEvent, Reminder, ScheduledMsg, Settings, UiChat, UiMessage, ZapApi } from '@shared/types'

declare global {
  interface Window {
    zap: ZapApi
  }
}
export const zap = window.zap

export interface Thread {
  list: UiMessage[]
  hasMore: boolean
  loading: boolean
  /** virtuoso firstItemIndex trick for stable prepends */
  firstIndex: number
  loadedAt: number
}

export interface State {
  ready: boolean
  conn: ConnState
  qr?: string
  me?: { id: string; name?: string }
  chats: Record<string, UiChat>
  settings?: Settings
  stickers: FavSticker[]
  locked: boolean
  hasPin: boolean
  pinLength: number
  active: string | null
  threads: Record<string, Thread>
  typing: Record<string, { who?: string; until: number }>
  fresh: Set<string>
  sync: { progress: number | null; done: boolean }
  toast?: { text: string; id: number }
  replyTo?: UiMessage
  /** your message being edited in the composer */
  editing?: UiMessage
  settingsOpen: boolean
  settingsTab?: string
  /** shared media/links/docs drawer open for the active chat */
  mediaOpen: boolean
  /** bumps every time WhatsApp (re)connects: lets failed avatars retry */
  connGen: number
  scheduled: ScheduledMsg[]
  reminders: Reminder[]
  accounts: AccountSummary[]
  version: string
  update: UpdateInfo | null
  whisper: WhisperState
  /** slow PC (from main): "auto" performance means lite mode */
  lowEnd: boolean
  folders: Folder[]
  /** Telegram folder tab on screen (null = all chats) */
  folder: number | null
  passwordHint?: string
  loginError?: string
}

let state: State = {
  ready: false,
  conn: 'loading',
  chats: {},
  stickers: [],
  locked: false,
  hasPin: false,
  pinLength: 0,
  active: null,
  threads: {},
  typing: {},
  fresh: new Set(),
  sync: { progress: null, done: true },
  settingsOpen: false,
  mediaOpen: false,
  connGen: 0,
  scheduled: [],
  reminders: [],
  accounts: [],
  version: '',
  update: null,
  lowEnd: false,
  whisper: { ready: false, progress: null },
  folders: [],
  folder: null
}

const subs = new Set<() => void>()
export const getState = () => state
export function setState(patch: Partial<State> | ((s: State) => Partial<State>)) {
  const p = typeof patch === 'function' ? patch(state) : patch
  state = { ...state, ...p }
  for (const fn of subs) fn()
}
const subscribe = (fn: () => void) => {
  subs.add(fn)
  return () => subs.delete(fn)
}
export function useStore<T>(sel: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => sel(state))
}

export const START_INDEX = 1_000_000

const byTs = (a: UiMessage, b: UiMessage) => a.ts - b.ts || (a.id < b.id ? -1 : 1)

function merge(t: Thread, incoming: UiMessage[], markFresh: boolean): Thread {
  if (!incoming.length) return t
  const map = new Map(t.list.map((m) => [m.id, m]))
  const firstTs = t.list[0]?.ts ?? Infinity
  const lastTs = t.list[t.list.length - 1]?.ts ?? 0
  let prepended = 0
  for (const m of incoming) {
    if (!map.has(m.id)) {
      if (m.ts < firstTs) prepended++
      // only genuinely new messages animate in (not history filling gaps)
      if (markFresh && m.ts >= lastTs) state.fresh.add(m.id)
    }
    map.set(m.id, m)
  }
  // the "just arrived" marks only matter for a few seconds: keep the set tiny
  if (state.fresh.size > 400) state.fresh = new Set([...state.fresh].slice(-100))
  return { ...t, list: [...map.values()].sort(byTs), firstIndex: t.firstIndex - prepended }
}

const KEEP_THREADS = 12
/** keep memory flat after hours of use: only the most recently opened chats stay in memory */
function prune(threads: Record<string, Thread>, keep: string | null): Record<string, Thread> {
  const ids = Object.keys(threads)
  if (ids.length <= KEEP_THREADS) return threads
  const drop = ids
    .filter((id) => id !== keep)
    .sort((a, b) => threads[a].loadedAt - threads[b].loadedAt)
    .slice(0, ids.length - KEEP_THREADS)
  const next = { ...threads }
  for (const id of drop) delete next[id]
  return next
}

export function toast(text: string) {
  setState({ toast: { text, id: Date.now() } })
}

export async function openChat(id: string | null, opts?: { keepMedia?: boolean }) {
  const switching = id !== state.active
  setState({ active: id, replyTo: undefined, editing: undefined, ...(switching && !opts?.keepMedia ? { mediaOpen: false } : {}) })
  zap.setActiveChat(id)
  if (!id) return
  void zap.read(id).catch(() => {})
  const t = state.threads[id]
  if (t && Date.now() - t.loadedAt < 5 * 60_000) return
  let res: Awaited<ReturnType<typeof zap.messages>>
  try {
    res = await zap.messages(id)
  } catch (err) {
    zap.log('openChat ' + String((err as Error)?.message ?? err))
    res = { messages: [], hasMore: false }
  }
  // user already moved on to another chat while this one loaded: still cache it, don't fight
  setState((s) => ({
    threads: prune(
      {
        ...s.threads,
        [id]: s.threads[id]
          ? merge({ ...s.threads[id], loadedAt: Date.now() }, res.messages, false)
          : { list: res.messages, hasMore: res.hasMore, loading: false, firstIndex: START_INDEX - res.messages.length, loadedAt: Date.now() }
      },
      s.active
    )
  }))
}

export function openChatMedia(id: string) {
  if (state.active !== id) void openChat(id, { keepMedia: true })
  setState({ mediaOpen: true })
}

const olderCooldown = new Map<string, number>()
export async function loadOlder(id: string) {
  const t = state.threads[id]
  if (!t || t.loading || !t.hasMore) return
  if ((olderCooldown.get(id) ?? 0) > Date.now()) return
  setState((s) => ({ threads: { ...s.threads, [id]: { ...t, loading: true } } }))
  const res = await zap.messages(id, t.list[0]?.ts)
  // nothing local left: the phone was asked for more, those arrive later as events
  if (!res.messages.length) olderCooldown.set(id, Date.now() + 8000)
  setState((s) => {
    const cur = s.threads[id] ?? t
    return { threads: { ...s.threads, [id]: { ...merge(cur, res.messages, false), hasMore: res.hasMore, loading: false } } }
  })
}

let syncTimer: ReturnType<typeof setTimeout> | undefined
export function handleEvent(ev: MainEvent) {
  switch (ev.type) {
    case 'conn':
      // a QR means logged out: forget the old identity so the login screen shows
      setState({
        conn: ev.conn,
        qr: ev.qr,
        me: ev.conn === 'qr' ? undefined : (ev.me ?? state.me),
        connGen: ev.conn === 'open' ? state.connGen + 1 : state.connGen,
        passwordHint: ev.passwordHint,
        loginError: ev.loginError
      })
      break
    case 'folders':
      setState({ folders: ev.folders, folder: ev.folders.some((f) => f.id === state.folder) ? state.folder : null })
      break
    case 'chats': {
      const chats = { ...state.chats }
      for (const c of ev.chats) chats[c.id] = c
      setState({ chats })
      break
    }
    case 'chatsRemoved': {
      if (ev.ids.includes('*')) {
        setState({ chats: {}, threads: {}, active: null })
        break
      }
      const chats = { ...state.chats }
      const threads = { ...state.threads }
      for (const id of ev.ids) {
        delete chats[id]
        delete threads[id]
      }
      const leaving = ev.ids.includes(state.active ?? '')
      setState({ chats, threads, active: leaving ? null : state.active, replyTo: leaving ? undefined : state.replyTo, editing: leaving ? undefined : state.editing })
      if (leaving) zap.setActiveChat(null)
      break
    }
    case 'msgs': {
      const t = state.threads[ev.chatId]
      if (!t) break
      // a new message also means that person stopped typing
      const typing = { ...state.typing }
      if (ev.messages.some((m) => !m.fromMe)) delete typing[ev.chatId]
      setState({ threads: { ...state.threads, [ev.chatId]: merge(t, ev.messages, true) }, typing })
      break
    }
    case 'msgsRemoved': {
      const t = state.threads[ev.chatId]
      if (!t) break
      const ids = new Set(ev.ids)
      setState({ threads: { ...state.threads, [ev.chatId]: { ...t, list: t.list.filter((m) => !ids.has(m.id)) } } })
      break
    }
    case 'typing': {
      const typing = { ...state.typing }
      if (ev.on) typing[ev.chatId] = { who: ev.who, until: Date.now() + 12_000 }
      else delete typing[ev.chatId]
      setState({ typing })
      break
    }
    case 'stickers':
      setState({ stickers: ev.stickers })
      break
    case 'lock':
      setState({ locked: ev.locked })
      break
    case 'openChat':
      void openChat(ev.chatId)
      break
    case 'toast':
      toast(ev.text)
      break
    case 'settings':
      setState({ settings: ev.settings })
      break
    case 'accounts':
      setState({ accounts: ev.accounts })
      break
    case 'update':
      setState({ update: ev.update })
      break
    case 'lowEnd':
      setState({ lowEnd: ev.lowEnd })
      break
    case 'whisper':
      setState({ whisper: ev.whisper })
      break
    case 'scheduled':
      setState({ scheduled: ev.scheduled, reminders: ev.reminders })
      break
    case 'sync':
      // WhatsApp doesn't always say "done": treat 20s of silence as finished
      clearTimeout(syncTimer)
      if (!ev.done) syncTimer = setTimeout(() => setState({ sync: { progress: 100, done: true } }), 20_000)
      setState({ sync: { progress: ev.progress, done: ev.done } })
      break
  }
}

export async function boot() {
  zap.onEvent(handleEvent)
  const init = await zap.init()
  const chats: Record<string, UiChat> = {}
  for (const c of init.chats) chats[c.id] = c
  setState({
    ready: true,
    conn: init.conn,
    qr: init.qr,
    me: init.me,
    chats,
    settings: init.settings,
    stickers: init.stickers,
    locked: init.locked,
    hasPin: init.hasPin,
    pinLength: init.pinLength,
    scheduled: init.scheduled ?? [],
    reminders: init.reminders ?? [],
    accounts: init.accounts ?? [],
    version: init.version ?? '',
    update: init.update ?? null,
    whisper: init.whisper ?? { ready: false, progress: null },
    lowEnd: !!init.lowEnd,
    folders: init.folders ?? [],
    passwordHint: init.passwordHint,
    loginError: init.loginError
  })
  performance.mark('booted')
  zap.booted()
  if (init.openChat) void openChat(init.openChat)
}

/** visual order of chats: pinned first, then sections, used by Ctrl+1..9 */
export function orderedChats(s: State, filter = ''): { pinned: UiChat[]; groups: { label: string; chats: UiChat[] }[]; archived: UiChat[] } {
  const q = filter.trim().toLowerCase()
  const all = Object.values(s.chats).filter((c) => !q || c.name.toLowerCase().includes(q) || c.preview?.toLowerCase().includes(q))
  const byRecent = (a: UiChat, b: UiChat) => b.ts - a.ts
  // a Telegram folder tab: exactly the chats Telegram puts in it, with that folder's own pins
  const f = s.folder
  if (f != null && !q && s.folders.some((x) => x.id === f)) {
    const inF = all.filter((c) => c.folders?.includes(f))
    const fp = inF.filter((c) => c.folderPins?.includes(f)).sort(byRecent)
    const rest = inF.filter((c) => !c.folderPins?.includes(f)).sort(byRecent)
    return { pinned: fp, groups: rest.length ? [{ label: 'conversas', chats: rest }] : [], archived: [] }
  }
  const pinned = q ? [] : all.filter((c) => c.pinned && !c.archived).sort((a, b) => a.pinned - b.pinned)
  const rest = all.filter((c) => (q || !c.pinned) && (q || !c.archived))
  const sections = s.settings?.sections ?? []
  const groups = sections
    .map((label) => ({ label, chats: rest.filter((c) => c.section === label).sort(byRecent) }))
    .filter((g) => g.chats.length)
  const loose = rest.filter((c) => !c.section || !sections.includes(c.section)).sort(byRecent)
  if (loose.length) groups.push({ label: groups.length ? 'sem seção' : 'conversas', chats: loose })
  // pinned-inside-the-archive chats (Telegram allows it) used to fall through both lists and vanish
  const archived = q ? [] : all.filter((c) => c.archived).sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.ts - a.ts)
  return { pinned, groups, archived }
}

export function flatOrder(s: State): string[] {
  const o = orderedChats(s)
  return [...o.pinned, ...o.groups.flatMap((g) => g.chats)].map((c) => c.id)
}

/** lite mode: no glass/blur/animations and fewer background jobs — on a slow PC (auto) or when chosen */
export const isLite = (s: { settings?: { performance?: string } | null; lowEnd: boolean }) =>
  s.settings?.performance === 'leve' || (s.settings?.performance !== 'completo' && s.lowEnd)
