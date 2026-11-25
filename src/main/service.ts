// What the app needs from a messaging account. WhatsApp (wa.ts) and Telegram (tg.ts) both implement it,
// so everything above them (window, notifications, lock, renderer) doesn't care which one it is.
import type { AccountKind, ChatAction, ConnState, FavSticker, Folder, PersonInfo, Reminder, ScheduledMsg, SharedItems, UiChat, UiMessage } from '@shared/types'
import type { ChatRec } from './store'

export type { AccountKind }

export interface IncomingInfo {
  chat: ChatRec
  chatName: string
  senderName?: string
  preview: string
  msg?: unknown
}

export interface ChatService {
  readonly kind: AccountKind
  conn: ConnState
  qr?: string
  me?: { id: string; name?: string; phone?: string }
  activeChat: string | null
  focused: boolean
  screenLocked: boolean
  onIncoming?: (i: IncomingInfo) => void
  onCall?: (from: string) => void
  onReminder?: (r: Reminder, chatName: string) => void
  onScheduledSent?: (s: ScheduledMsg, chatName: string) => void

  start(): Promise<void>
  startTimers(): void
  destroy(logout: boolean): Promise<void>
  shutdown(): void
  nudge(): void
  logout(): Promise<void>
  pairingCode(phone: string): Promise<string>
  setOnline(on: boolean): Promise<void>
  setActive(chatId: string | null): void

  chatName(c: ChatRec): string
  allChats(): UiChat[]
  folders(): Folder[]
  peek(chatId: string): UiMessage[] | Promise<UiMessage[]>
  getMessages(chatId: string, beforeTs?: number): { messages: UiMessage[]; hasMore: boolean } | Promise<{ messages: UiMessage[]; hasMore: boolean }>
  getShared(chatId: string): SharedItems | Promise<SharedItems>
  send(chatId: string, text: string, quotedId?: string, opts?: { noPreview?: boolean }): Promise<void>
  /** a video's sharp preview picture: stored first frame (or Telegram's own thumbnail), null if none yet */
  poster(chatId: string, msgId: string): Promise<string | null>
  sendFiles(chatId: string, files: { name: string; mime: string; path?: string; data?: Buffer }[], caption?: string): Promise<void>
  sendSticker(chatId: string, stickerId: string): Promise<void>
  resend(chatId: string, msgId: string): Promise<void>
  react(chatId: string, msgId: string, emoji: string): Promise<void>
  editMessage(chatId: string, msgId: string, text: string): Promise<void>
  person(id: string, pushName?: string): Promise<PersonInfo>
  votePoll(chatId: string, msgId: string, options: number[]): Promise<void>
  sendPoll(chatId: string, name: string, options: string[], multi: boolean): Promise<void>
  read(chatId: string, force?: boolean): Promise<void>
  typing(chatId: string, on: boolean): Promise<void>
  chatAction(chatId: string, a: ChatAction): Promise<void>
  resolveNumber(input: string): Promise<string | null>

  emitScheduled(): void
  schedule(chatId: string, text: string, at: number): void
  cancelScheduled(id: string): void
  remind(chatId: string, msgId: string, at: number): void
  cancelReminder(id: string): void
  exportText(chatId: string): string
  setTranscript(msgId: string, text: string, chatId?: string): void

  media(chatId: string, msgId: string): Promise<string>
  mimeOf(chatId: string, msgId: string): string | undefined
  fileNameOf(chatId: string, msgId: string): string | undefined
  avatar(raw: string, big?: boolean): Promise<string | null>
  avatarCached(id: string): string | undefined

  stickers(): FavSticker[]
  stickerPath(id: string): string
  resyncStickers(): Promise<void>
  favSticker(chatId: string, msgId: string, fav: boolean): Promise<void>
  removeSticker(id: string): void | Promise<void>
}
