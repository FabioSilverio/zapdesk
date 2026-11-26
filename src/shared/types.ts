export type MsgKind =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'document'
  | 'sticker'
  | 'location'
  | 'contact'
  | 'poll'
  | 'system'
  | 'deleted'
  | 'unknown'

export interface Reaction {
  e: string
  by: string[]
}

export interface QuotedRef {
  id: string
  senderName: string
  text: string
}

export interface UiMessage {
  id: string
  chatId: string
  fromMe: boolean
  sender?: string
  senderName?: string
  ts: number
  kind: MsgKind
  text?: string
  thumb?: string
  w?: number
  h?: number
  mime?: string
  fileName?: string
  seconds?: number
  ptt?: boolean
  quoted?: QuotedRef
  reactions?: Reaction[]
  status?: number
  edited?: boolean
  hasMedia?: boolean
  stickerFav?: boolean
  /** deleted for everyone, but we kept what it said (anti-apagar) */
  revoked?: boolean
  /** text before it was edited */
  originalText?: string
  /** media size in bytes (decides what gets downloaded ahead of time) */
  size?: number
  /** people @mentioned in the text, by the token that appears after "@" */
  mentions?: Record<string, { id: string; name: string }>
  /** voice-note transcription (done on this PC) */
  transcript?: string
  /** a sharp first-frame picture of this video is stored (zap://poster/…) */
  poster?: boolean
  /** link preview the sender attached (WhatsApp sends title/description/thumbnail with the message) */
  link?: { url: string; title?: string; description?: string; thumb?: string }
  /** poll: options with vote counts (mine = you picked it) */
  poll?: PollInfo
  /** you can still edit this one (your own text, inside the app's edit window) */
  editable?: boolean
}

/** who someone is, for the contact card (click a name/photo) */
export interface PersonInfo {
  id: string
  /** what the app calls them */
  name: string
  /** name saved in your phone's contacts */
  savedName?: string
  /** the name they set for themselves */
  pushName?: string
  /** full number, formatted (+55 41 99876-5432) */
  phone?: string
  /** the same, digits only with + (what gets copied) */
  phoneRaw?: string
}

export interface PollInfo {
  name: string
  /** more than one option can be picked */
  multi: boolean
  options: { name: string; votes: number; mine: boolean }[]
  /** people who voted (one person can count in several options when multi) */
  voters: number
  closed?: boolean
}

export interface SharedLink {
  id: string
  msgId: string
  url: string
  title?: string
  description?: string
  thumb?: string
  text?: string
  senderName?: string
  fromMe: boolean
  ts: number
}

export interface SharedItems {
  media: UiMessage[]
  docs: UiMessage[]
  links: SharedLink[]
  totalMsgs: number
}

export interface LinkMeta {
  url: string
  /** og:site_name or hostname */
  site?: string
  domain?: string
  title?: string
  description?: string
  /** small JPEG as data URL for display */
  thumb?: string
  /** same JPEG, base64, attached when we send the link */
  jpeg?: string
  ts: number
}

export interface ScheduledMsg {
  id: string
  chatId: string
  text: string
  at: number
}

export interface Reminder {
  id: string
  chatId: string
  msgId: string
  text: string
  at: number
}

export interface QuickReply {
  key: string
  text: string
}

export interface OutFile {
  name: string
  mime: string
  /** on-disk path (drag & drop, file picker): streamed, no size copied through IPC */
  path?: string
  /** in-memory bytes (pasted screenshots) */
  data?: ArrayBuffer
  /** bytes, for the preview sheet */
  size?: number
  /** URL the preview sheet shows it from (zap://local/… or a blob: URL) */
  preview?: string
}

export interface UiChat {
  id: string
  name: string
  ts: number
  unread: number
  markedUnread?: boolean
  pinned: number
  section?: string
  muted: boolean
  archived: boolean
  preview?: string
  previewFromMe?: boolean
  previewSender?: string
  isGroup: boolean
  blocked?: boolean
  /** your own "message yourself" chat */
  self?: boolean
  /** Telegram broadcast channel (read-only for most people) */
  channel?: boolean
  /** Telegram folders this chat is in, and the ones where it's pinned */
  folders?: number[]
  folderPins?: number[]
}

export interface FavSticker {
  id: string
  ready: boolean
  w?: number
  h?: number
  source: 'account' | 'local'
}

export type ThemeId = 'verde' | 'grafite' | 'mocha' | 'latte' | 'claro'

export interface Appearance {
  theme: ThemeId
  /** null = the theme's own accent */
  accent: string | null
  density: 'compacto' | 'confortavel'
  /** bolhas = WhatsApp-like, lista = everything left-aligned like Slack/Discord */
  messages: 'bolhas' | 'lista'
  pinned: 'grade' | 'lista'
  radius: 'suave' | 'reto'
  fontSize: number
  sidebarWidth: number
  /** grow the whole UI as the window gets bigger */
  autoScale: boolean
  /** manual zoom on top of autoScale (Ctrl +/-) */
  zoom: number
  /** Liquid Glass: translucent window (Windows 11 acrylic) + glass surfaces */
  glass: boolean
  /** text font; unset = not chosen yet (first launch asks) */
  font?: FontId
  /** name of the font file you picked for "custom" */
  customFont?: string
}

export type FontId = 'sf' | 'segoe' | 'inter' | 'custom'

export interface Settings {
  appearance: Appearance
  sections: string[]
  /** Esc with nothing else open leaves the current chat */
  escClosesChat: boolean
  /** keep the content of messages deleted for everyone */
  keepDeleted: boolean
  ghost: { noReadReceipts: boolean; noTyping: boolean; hideOnline: boolean }
  privacyBlur: boolean
  quickReplies: QuickReply[]
  /** show links by their page title + preview card, and attach previews to links you send */
  linkPreviews: boolean
  /** hovering a chat in the list shows its last messages in a floating card */
  hoverPeek: boolean
  /** transcribe voice notes you receive as soon as they show up (needs the engine downloaded) */
  autoTranscribe: boolean
  /** leve = no glass/blur/animations, fewer background downloads; auto = leve on a slow PC */
  performance?: 'auto' | 'leve' | 'completo'
  lockMinutes: number
  notifications: boolean
  notifyPreview: boolean
  closeToTray: boolean
  startWithWindows: boolean
  sound: boolean
}

export interface AccountSummary {
  id: string
  label: string
  phone?: string
  unread: number
  conn: ConnState
  active: boolean
  kind: AccountKind
}

export type ConnState = 'loading' | 'qr' | 'connecting' | 'open' | 'reconnecting' | 'offline' | 'setup' | 'password'

export type AccountKind = 'wa' | 'tg'

/** a Telegram chat folder ("Trabalho", "Pessoal"…), straight from the account */
export interface Folder {
  id: number
  title: string
  emoji?: string
}

export interface WhisperState {
  ready: boolean
  /** 0-100 while downloading the engine, else null */
  progress: number | null
  error?: string
}

export interface UpdateInfo {
  version: string
  notes: string[]
  date: string
  /** installer path (for a GitHub update: where it gets downloaded) */
  file: string
  /** comes from the GitHub releases (downloaded on click) */
  remote?: boolean
  /** 0-100 while downloading it */
  progress?: number
}

export interface InitPayload {
  version: string
  update: UpdateInfo | null
  whisper: WhisperState
  folders: Folder[]
  /** Telegram two-step verification hint, while asking for the password */
  passwordHint?: string
  /** Telegram login problem to show on the setup/QR screen */
  loginError?: string
  chats: UiChat[]
  settings: Settings
  stickers: FavSticker[]
  conn: ConnState
  qr?: string
  me?: { id: string; name?: string }
  locked: boolean
  hasPin: boolean
  pinLength: number
  scheduled: ScheduledMsg[]
  reminders: Reminder[]
  accounts: AccountSummary[]
  /** chat to open right after boot (notification from another account) */
  openChat?: string
  /** this PC is slow (few cores, little RAM, no GPU acceleration): "auto" performance turns effects down */
  lowEnd?: boolean
}

export type MainEvent =
  | { type: 'conn'; conn: ConnState; qr?: string; me?: { id: string; name?: string; phone?: string }; passwordHint?: string; loginError?: string }
  | { type: 'folders'; folders: Folder[] }
  | { type: 'chats'; chats: UiChat[] }
  | { type: 'chatsRemoved'; ids: string[] }
  | { type: 'msgs'; chatId: string; messages: UiMessage[] }
  | { type: 'msgsRemoved'; chatId: string; ids: string[] }
  | { type: 'typing'; chatId: string; who?: string; on: boolean }
  | { type: 'stickers'; stickers: FavSticker[] }
  | { type: 'lock'; locked: boolean }
  | { type: 'openChat'; chatId: string }
  | { type: 'toast'; text: string }
  | { type: 'sync'; progress: number | null; done: boolean; label?: string }
  | { type: 'settings'; settings: Settings }
  | { type: 'scheduled'; scheduled: ScheduledMsg[]; reminders: Reminder[] }
  | { type: 'accounts'; accounts: AccountSummary[] }
  | { type: 'update'; update: UpdateInfo | null }
  | { type: 'whisper'; whisper: WhisperState }
  | { type: 'lowEnd'; lowEnd: boolean }
  /** text so far of a long voice note still being transcribed */
  | { type: 'transcript'; chatId: string; msgId: string; text: string }
  /** a voice note arrived in a chat that isn't open (automatic transcription) */
  | { type: 'voiceIn'; message: UiMessage }

export type ChatAction =
  | { pin: boolean }
  | { mute: boolean }
  | { archive: boolean }
  | { section: string | null }
  | { markUnread: boolean }
  | { block: boolean }
  /** local name for the chat (null = back to the WhatsApp name) */
  | { alias: string | null }
  | { delete: true }

export interface ZapApi {
  init(): Promise<InitPayload>
  messages(chatId: string, beforeTs?: number): Promise<{ messages: UiMessage[]; hasMore: boolean }>
  /** photos, videos, links and documents stored for a chat (newest first) */
  shared(chatId: string): Promise<SharedItems>
  /** last few messages for the hover preview: doesn't mark as read or fetch history */
  peek(chatId: string): Promise<UiMessage[]>
  /** download media in the background (visible photos/videos) so opening them is instant */
  prefetch(chatId: string, msgId: string, urgent?: boolean): void
  installUpdate(): Promise<boolean>
  whisperInstall(): Promise<void>
  whisperCancel(): Promise<void>
  whisperRemove(): Promise<void>
  /** pcm: Int16 mono 16 kHz. urgent = you clicked it (goes ahead of the automatic ones) */
  transcribe(chatId: string, msgId: string, pcm: ArrayBuffer, urgent?: boolean): Promise<string>
  checkUpdate(): Promise<UpdateInfo | null>
  send(chatId: string, text: string, quotedId?: string, opts?: { noPreview?: boolean }): Promise<void>
  linkMeta(url: string): Promise<LinkMeta | null>
  sendSticker(chatId: string, stickerId: string): Promise<void>
  sendFiles(chatId: string, files: OutFile[], caption?: string): Promise<void>
  pathForFile(file: File): string
  /** files copied in Explorer / an image on the clipboard, for the preview sheet (nothing is sent) */
  pasteClipboard(): Promise<OutFile[]>
  schedule(chatId: string, text: string, at: number): Promise<void>
  cancelScheduled(id: string): Promise<void>
  remind(chatId: string, msgId: string, at: number): Promise<void>
  cancelReminder(id: string): Promise<void>
  exportChat(chatId: string): Promise<string | null>
  readNow(chatId: string): Promise<void>
  resend(chatId: string, msgId: string): Promise<void>
  /** asks WhatsApp which account a phone number really is (fixes the Brazilian extra 9) */
  resolveNumber(phone: string): Promise<string | null>
  /** file dialog → the preview sheet */
  pickFiles(): Promise<OutFile[]>
  /** first frame of a video grabbed by the renderer (JPEG), kept as its preview picture */
  savePoster(chatId: string, msgId: string, jpeg: ArrayBuffer): void
  react(chatId: string, msgId: string, emoji: string): Promise<void>
  /** name + full number of someone (resolves WhatsApp's hidden ids to the real number when possible) */
  person(id: string, pushName?: string): Promise<PersonInfo>
  /** your own text message, new text */
  editMessage(chatId: string, msgId: string, text: string): Promise<void>
  /** options = indexes picked (empty = take your vote back) */
  votePoll(chatId: string, msgId: string, options: number[]): Promise<void>
  sendPoll(chatId: string, name: string, options: string[], multi: boolean): Promise<void>
  read(chatId: string): Promise<void>
  typing(chatId: string, on: boolean): Promise<void>
  chatAction(chatId: string, action: ChatAction): Promise<void>
  setActiveChat(chatId: string | null): void
  setSettings(patch: Partial<Settings>): Promise<Settings>
  setPin(pin: string): Promise<boolean>
  unlock(pin: string): Promise<{ ok: boolean; waitMs?: number }>
  lockNow(): Promise<void>
  activity(): void
  logout(): Promise<void>
  forgotPin(): Promise<void>
  pairingCode(phone: string): Promise<string>
  resyncStickers(): Promise<void>
  favSticker(chatId: string, msgId: string, fav: boolean): Promise<void>
  removeSticker(stickerId: string): Promise<void>
  openMedia(chatId: string, msgId: string): Promise<void>
  setBadge(count: number, dataUrl: string | null): void
  setChrome(bg: string, symbol: string, glass?: boolean, scheme?: 'dark' | 'light'): void
  /** pick a .ttf/.otf/.woff2 to use as the app font; returns its name (null = cancelled) */
  importFont(): Promise<string | null>
  switchAccount(id: string): Promise<void>
  addAccount(kind?: AccountKind): Promise<void>
  /** Telegram login: app credentials from my.telegram.org, then the 2-step password if the account has one */
  tgSetup(apiId: string, apiHash: string): Promise<void>
  tgPassword(password: string): Promise<void>
  removeAccount(id: string): Promise<void>
  renameAccount(id: string, label: string): Promise<void>
  log(msg: string): void
  /** a renderer task that blocked the screen this long (ms) */
  stall(ms: number): void
  /** this PC + how the app has been performing (diagnostics) */
  perfStats(): Promise<Record<string, unknown>>
  /** writes a diagnostics file (PC info, performance, recent errors — no message content) to the Desktop */
  exportDiagnostics(): Promise<string | null>
  booted(): void
  onEvent(cb: (ev: MainEvent) => void): () => void
}
