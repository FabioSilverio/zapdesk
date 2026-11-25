import fs from 'node:fs'
import { randomBytes } from 'node:crypto'
import { isLowEnd, perfSnapshot, rendererStall, startPerfLog, systemInfo } from './perf'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  powerMonitor,
  protocol,
  shell,
  Tray
} from 'electron'
import type { AccountSummary, ChatAction, InitPayload, MainEvent, OutFile, Settings, UpdateInfo } from '@shared/types'
import { readJson, Store } from './store'
import { setErrorLogger, WaService } from './wa'
import { setTgErrorLogger, TgService } from './tg'
import type { TgFile } from './tgfile'
import type { ChatService } from './service'
import { AccountList, AppConfig, type AccountInfo, type AppMeta } from './accounts'
import { LockManager } from './lock'
import { demoLive, heavyLive, seedDemo, seedHeavy, seedTgDemo } from './demo'
import { getLinkMeta, initLinkCache } from './links'
import { checkGitHub, currentUpdate, downloadRemote, runInstaller, watchUpdates } from './updater'
import { Transcriber } from './transcribe'

const here = path.dirname(fileURLToPath(import.meta.url))
const DEMO = !!process.env.ZAP_DEMO
// dev/demo runs use the bare electron.exe (atom icon): give them their own taskbar identity
// so Windows never caches that icon for the installed app's identity
const APP_ID = app.isPackaged && !DEMO ? 'com.fabiosilverio.zapdesk' : 'com.fabiosilverio.zapdesk.dev'
if (process.env.ZAP_USERDATA) app.setPath('userData', process.env.ZAP_USERDATA)

// icons live outside app.asar (extraResources) so Windows toasts and the shell can read them
const RES = app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'build')
const ICON_ICO = path.join(RES, 'icon.ico')
const ICON_PNG = path.join(RES, 'icon.png')

if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

app.setAppUserModelId(APP_ID)
protocol.registerSchemesAsPrivileged([
  { scheme: 'zap', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true, corsEnabled: true } }
])

const userData = app.getPath('userData')

// ---------- logging: errors go to a rotating file instead of crashing the app ----------
const logFile = path.join(userData, 'zapdesk.log')
function log(where: string, err: unknown) {
  const line = `${new Date().toISOString()} [${where}] ${(err as Error)?.stack ?? (err as Error)?.message ?? String(err)}\n`
  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 1024 * 1024) fs.renameSync(logFile, logFile + '.1')
    fs.appendFileSync(logFile, line)
  } catch {}
  if (!app.isPackaged) console.error(line.trim())
}
setErrorLogger(log)
setTgErrorLogger(log)
process.on('uncaughtException', (err) => log('uncaught', err))
process.on('unhandledRejection', (err) => log('unhandled', err))
// event-loop watchdog: anything that blocks the main process for >2s gets written down
let lastTick = Date.now()
setInterval(() => {
  const lag = Date.now() - lastTick - 1000
  if (lag > 2000) log('main-blocked', new Error(`main process was frozen for ${lag} ms`))
  lastTick = Date.now()
}, 1000).unref()

let win: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
/** PIN screen up: nothing on screen counts as "seen" (no read receipts while locked) */
let screenLocked = true
let pendingUpdate: UpdateInfo | null = null
let transcriber: Transcriber | undefined
const whisper = () => (transcriber ??= new Transcriber((w) => send({ type: 'whisper', whisper: w })))
let unreadTotal = 0

const send = (ev: MainEvent) => {
  if (win && !win.isDestroyed()) win.webContents.send('zap:event', ev)
}

// ---------- accounts ----------
// Every WhatsApp account has its own folder + socket and stays connected in the background,
// so notifications from all of them arrive. `store`/`wa` always point at the one on screen.
const accounts = new AccountList(userData)
const config = new AppConfig(userData, () => {
  // first run with app.json: inherit settings + PIN from the original single-account data
  const first = readJson<Partial<AppMeta>>(path.join(accounts.dirOf(accounts.list[0]), 'meta.json'), {})
  return { settings: first.settings, pinHash: first.pinHash, pinSalt: first.pinSalt, pinLength: first.pinLength }
})
initLinkCache(userData)

interface Account {
  info: AccountInfo
  store: Store
  wa: ChatService
}
const live = new Map<string, Account>()
let store!: Store
let wa!: ChatService
let pendingOpen: string | undefined

function openAccount(info: AccountInfo): Account {
  const dir = accounts.dirOf(info)
  const s = new Store(dir)
  s.meta.settings = config.meta.settings
  const emit = (ev: MainEvent) => route(info.id, ev)
  const w: ChatService = info.kind === 'tg' ? new TgService(s, dir, emit) : new WaService(s, dir, emit)
  w.screenLocked = screenLocked
  const acc = { info, store: s, wa: w }
  attachHooks(acc)
  live.set(info.id, acc)
  return acc
}

function activate(id: string) {
  const acc = live.get(id) ?? openAccount(accounts.get(id)!)
  if (wa && wa !== acc.wa) {
    wa.setActive(null)
    wa.focused = false
  }
  accounts.active = id
  accounts.save()
  store = acc.store
  wa = acc.wa
  wa.focused = !!win?.isFocused()
}

/** same settings object everywhere (wa.ts reads ghost/keepDeleted/linkPreviews from its store) */
function setSettings(next: Settings) {
  config.meta.settings = next
  for (const a of live.values()) a.store.meta.settings = next
  config.markMeta()
}

let summaryTimer: NodeJS.Timeout | null = null
function accountSummaries(): AccountSummary[] {
  return accounts.list.map((info) => {
    const a = live.get(info.id)
    let unread = 0
    if (a)
      for (const c of a.store.chats.values()) {
        const m = c.muteUntil
        const muted = !!m && (m < 0 || (m < 1e12 ? m * 1000 : m) > Date.now())
        if (!c.archived && !muted) unread += c.unread || (c.markedUnread ? 1 : 0)
      }
    const me = a?.wa.me
    const phone = (me ? me.phone || me.id.split('@')[0] : undefined) ?? info.phone
    const kind = info.kind ?? 'wa'
    return {
      id: info.id,
      label: me?.name || info.label || (phone ? '+' + phone : kind === 'tg' ? 'Novo Telegram' : 'Nova conta'),
      phone,
      unread,
      conn: a?.wa.conn ?? 'offline',
      active: info.id === accounts.active,
      kind
    }
  })
}
function pushSummaries() {
  if (summaryTimer) return
  summaryTimer = setTimeout(() => {
    summaryTimer = null
    send({ type: 'accounts', accounts: accountSummaries() })
  }, 250)
}

/** events of the account on screen go to the window; the others only update the switcher badges */
function route(id: string, ev: MainEvent) {
  if (id === accounts.active) send(ev)
  if (ev.type === 'conn' && ev.me) {
    const info = accounts.get(id)
    const phone = ev.me.phone || ev.me.id.split('@')[0]
    if (info && (info.phone !== phone || (ev.me.name && info.label !== ev.me.name))) accounts.update(id, { phone, label: ev.me.name || info.label })
  }
  if (ev.type === 'chats' || ev.type === 'conn' || ev.type === 'chatsRemoved') pushSummaries()
}

function switchAccount(id: string, openChatId?: string) {
  if (!accounts.get(id)) return
  if (id !== accounts.active) {
    activate(id)
    pendingOpen = openChatId
    // a clean renderer for the new account: nothing from the previous one can leak through
    win?.webContents.reload()
  } else if (openChatId) send({ type: 'openChat', chatId: openChatId })
  pushSummaries()
}

async function addAccount(kind: 'wa' | 'tg' = 'wa') {
  const info = accounts.add(kind)
  const acc = openAccount(info)
  acc.wa.startTimers()
  void acc.wa.start()
  switchAccount(info.id)
}

async function removeAccount(id: string) {
  const acc = live.get(id)
  const info = accounts.get(id)
  if (!info) return
  live.delete(id)
  if (acc) await acc.wa.destroy(acc.wa.conn === 'open').catch((err) => log('removeAccount', err))
  accounts.remove(id)
  try {
    fs.rmSync(accounts.dirOf(info), { recursive: true, force: true })
  } catch (err) {
    log('removeAccount:rm', err)
  }
  if (!accounts.list.length) {
    // never leave the app without an account: start a fresh one (shows the QR)
    const fresh = accounts.add()
    const a = openAccount(fresh)
    a.wa.startTimers()
    void a.wa.start()
  }
  if (!live.has(accounts.active) || wa === acc?.wa) {
    activate(accounts.list[0].id)
    win?.webContents.reload()
  }
  pushSummaries()
}

for (const info of accounts.list) openAccount(info)
activate(accounts.active)

const lock = new LockManager(config, (locked) => {
  screenLocked = locked
  for (const a of live.values()) a.wa.screenLocked = locked
  send({ type: 'lock', locked })
  updateTray()
  // unlocked with the chat already open in front of you: now it's really seen
  if (!locked && wa.focused && wa.activeChat) void wa.read(wa.activeChat)
})
screenLocked = lock.locked
for (const a of live.values()) a.wa.screenLocked = lock.locked

if (DEMO) {
  if (wa.kind === 'tg') seedTgDemo(store)
  else seedDemo(store)
  if (process.env.ZAP_HEAVY && wa.kind !== 'tg') seedHeavy(store)
  if (process.env.ZAP_SETTINGS) config.meta.settings = { ...config.meta.settings, ...JSON.parse(process.env.ZAP_SETTINGS) }
  if (process.env.ZAP_LOOK) config.meta.settings.appearance = { ...config.meta.settings.appearance, ...JSON.parse(process.env.ZAP_LOOK) }
  if (!lock.hasPin()) lock.setPin('1234')
  if (process.env.ZAP_LOCK) lock.lock()
  else if (lock.locked) lock.unlock('1234')
}

// ---------- window ----------

const boundsFile = path.join(app.getPath('userData'), 'window.json')
function loadBounds(): Electron.Rectangle | undefined {
  try {
    return JSON.parse(fs.readFileSync(boundsFile, 'utf8'))
  } catch {
    return undefined
  }
}

/** Windows 11 acrylic behind a transparent page = real glass, blurred by the OS compositor */
function applyGlass(on: boolean, bg: string) {
  if (!win || win.isDestroyed()) return
  try {
    win.setBackgroundMaterial(on ? 'acrylic' : 'none')
  } catch {
    /* older Windows: just no material */
  }
  win.setBackgroundColor(on ? '#00000000' : bg)
}

const chromeFile = path.join(app.getPath('userData'), 'chrome.json')
function loadChrome(): { bg: string; symbol: string; glass?: boolean } {
  try {
    return JSON.parse(fs.readFileSync(chromeFile, 'utf8'))
  } catch {
    return { bg: '#0d1613', symbol: '#8fa89c' }
  }
}

let chromeSymbol = loadChrome().symbol
let zoomTimer: NodeJS.Timeout | null = null

/** whole-UI zoom: grows with the window (base 1080×700), times the manual Ctrl +/- zoom */
function applyZoom() {
  if (!win || win.isDestroyed()) return
  const a = config.meta.settings.appearance
  const [w, h] = win.getContentSize()
  const auto = a.autoScale ? Math.min(Math.max(1, Math.min(w / 1080, h / 700)), 2) : 1
  const f = Math.round(Math.min(2.5, Math.max(0.6, auto * (a.zoom || 1))) * 100) / 100
  if (Math.abs(win.webContents.getZoomFactor() - f) > 0.004) win.webContents.setZoomFactor(f)
  win.setTitleBarOverlay({ color: '#00000000', symbolColor: chromeSymbol, height: Math.round(38 * f) })
}
const scheduleZoom = () => {
  if (zoomTimer) return
  zoomTimer = setTimeout(() => {
    zoomTimer = null
    applyZoom()
  }, 30)
}

function createWindow(show: boolean) {
  const b = loadBounds()
  const chrome = loadChrome()
  win = new BrowserWindow({
    width: b?.width ?? 1080,
    height: b?.height ?? 720,
    x: b?.x,
    y: b?.y,
    minWidth: 380,
    minHeight: 500,
    show: false,
    backgroundColor: chrome.glass ? '#00000000' : chrome.bg,
    backgroundMaterial: chrome.glass ? 'acrylic' : undefined,
    icon: ICON_ICO,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: chrome.symbol, height: 38 },
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(here, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      spellcheck: true,
      backgroundThrottling: false
    }
  })
  win.webContents.session.setSpellCheckerLanguages(['pt-BR', 'en-US'])
  // taskbar button identity + icon straight from the exe, not whatever the shell cached
  if (app.isPackaged && !DEMO)
    win.setAppDetails({ appId: APP_ID, appIconPath: process.execPath, appIconIndex: 0, relaunchCommand: `"${process.execPath}"`, relaunchDisplayName: 'Zapdesk' })
  win.once('ready-to-show', () => {
    applyZoom()
    if (show) win?.show()
  })
  win.webContents.on('did-finish-load', applyZoom)
  // dev-only: emulate a slower PC for the renderer (ZAP_CPU_THROTTLE=4 → 4x slower JS/layout)
  if (process.env.ZAP_CPU_THROTTLE)
    win.webContents.once('did-finish-load', () => {
      try {
        win!.webContents.debugger.attach('1.3')
        void win!.webContents.debugger.sendCommand('Emulation.setCPUThrottlingRate', { rate: Number(process.env.ZAP_CPU_THROTTLE) || 4 })
        // dev-only: ZAP_PROFILE=<file.json> records the renderer's first seconds as a CPU profile
        const out = process.env.ZAP_PROFILE
        if (out) {
          const dbg = win!.webContents.debugger
          void dbg
            .sendCommand('Profiler.enable')
            .then(() => dbg.sendCommand('Profiler.setSamplingInterval', { interval: 200 }))
            .then(() => dbg.sendCommand('Profiler.start'))
            .then(() => new Promise((r) => setTimeout(r, Number(process.env.ZAP_PROFILE_MS) || 4000)))
            .then(() => dbg.sendCommand('Profiler.stop'))
            .then((r: any) => fs.writeFileSync(out, JSON.stringify(r.profile)))
            .catch((e) => log('profile', e))
        }
      } catch {}
    })
  win.on('resize', scheduleZoom)
  win.on('maximize', applyZoom)
  win.on('unmaximize', applyZoom)
  // keep Chromium's own Ctrl+wheel zoom from fighting ours
  win.webContents.on('did-finish-load', () => void win?.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {}))
  win.webContents.on('zoom-changed', (_e, dir) => {
    const a = config.meta.settings.appearance
    a.zoom = Math.round(Math.min(1.6, Math.max(0.7, (a.zoom || 1) + (dir === 'in' ? 0.05 : -0.05))) * 100) / 100
    config.markMeta()
    applyZoom()
    send({ type: 'settings', settings: config.meta.settings })
  })
  // ---- self-healing window: a crashed or frozen page is reloaded instead of leaving you stuck ----
  let hangTimer: NodeJS.Timeout | null = null
  let crashes: number[] = []
  win.webContents.on('render-process-gone', (_e, d) => {
    log('renderer-gone', new Error(d.reason))
    if (quitting || d.reason === 'clean-exit') return
    crashes = [...crashes.filter((t) => Date.now() - t < 60_000), Date.now()]
    // crash loop guard: back off if it keeps dying
    setTimeout(() => win && !win.isDestroyed() && win.webContents.reload(), crashes.length > 3 ? 5000 : 300)
  })
  win.on('unresponsive', () => {
    log('renderer-hang', new Error('window unresponsive'))
    if (hangTimer) return
    hangTimer = setTimeout(() => {
      hangTimer = null
      if (win && !win.isDestroyed()) win.webContents.forcefullyCrashRenderer()
    }, 8000)
  })
  win.on('responsive', () => {
    if (hangTimer) clearTimeout(hangTimer)
    hangTimer = null
  })
  win.on('focus', () => {
    wa.focused = true
    lock.activity()
    win?.flashFrame(false)
    void wa.setOnline(true)
    if (wa.activeChat && !lock.locked) void wa.read(wa.activeChat)
  })
  win.on('blur', () => {
    wa.focused = false
    void wa.setOnline(false)
  })
  win.on('close', (e) => {
    if (win) fs.writeFileSync(boundsFile, JSON.stringify(win.getNormalBounds()))
    if (!quitting && config.meta.settings.closeToTray) {
      e.preventDefault()
      win?.hide()
    }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win?.webContents.getURL()) {
      e.preventDefault()
      if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    }
  })
  win.webContents.on('context-menu', (_e, p) => {
    // only editable fields: messages have their own menu (two menus at once otherwise)
    if (!p.isEditable) return
    const items: Electron.MenuItemConstructorOptions[] = []
    for (const s of p.dictionarySuggestions.slice(0, 5)) items.push({ label: s, click: () => win?.webContents.replaceMisspelling(s) })
    if (items.length) items.push({ type: 'separator' })
    if (p.isEditable) items.push({ role: 'cut', label: 'Recortar' })
    items.push({ role: 'copy', label: 'Copiar' })
    if (p.isEditable) items.push({ role: 'paste', label: 'Colar' }, { role: 'selectAll', label: 'Selecionar tudo' })
    Menu.buildFromTemplate(items).popup()
  })

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(path.join(here, '../renderer/index.html'))
}

function showWindow() {
  if (!win) createWindow(true)
  if (win!.isMinimized()) win!.restore()
  win!.show()
  win!.focus()
}

function updateTray() {
  if (!tray) return
  tray.setToolTip(unreadTotal ? `Zapdesk — ${unreadTotal} não lida${unreadTotal > 1 ? 's' : ''}` : 'Zapdesk')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Abrir Zapdesk', click: showWindow },
      { label: 'Bloquear agora', enabled: lock.hasPin() && !lock.locked, click: () => lock.lock() },
      { type: 'separator' },
      {
        label: 'Sair',
        click: () => {
          quitting = true
          app.quit()
        }
      }
    ])
  )
}

function createTray() {
  tray = new Tray(ICON_ICO)
  tray.on('click', showWindow)
  updateTray()
}

// ---------- notifications ----------

const liveNotes = new Map<string, Notification>()

/** "[Trabalho] " prefix when the toast comes from an account that isn't on screen */
function accountTag(acc: Account) {
  if (accounts.list.length < 2 || acc.info.id === accounts.active) return ''
  return `[${acc.wa.me?.name || acc.info.label || 'outra conta'}] `
}

function attachHooks(acc: Account) {
  const { wa: w, info } = acc
  const openIt = (chatId?: string) => {
    showWindow()
    switchAccount(info.id, chatId)
  }
  w.onIncoming = ({ chat, chatName, senderName, preview }) => {
    const s = config.meta.settings
    // never toast from dev/demo: Electron would create a Start-menu shortcut for the bare electron.exe
    if (DEMO || !app.isPackaged || !s.notifications || !Notification.isSupported()) return
    const hide = lock.locked || !s.notifyPreview
    const title = hide ? 'Zapdesk' : accountTag(acc) + chatName
    const body = hide ? 'Nova mensagem' : (senderName ? `${senderName}: ` : '') + preview
    const icon = hide ? ICON_PNG : (w.avatarCached(chat.id) ?? ICON_PNG)
    const key = info.id + '|' + chat.id
    liveNotes.get(key)?.close()
    const n = new Notification({ title, body, icon, silent: !s.sound, timeoutType: 'default' })
    n.on('click', () => openIt(chat.id))
    n.on('close', () => {
      if (liveNotes.get(key) === n) liveNotes.delete(key)
    })
    liveNotes.set(key, n)
    n.show()
    if (win && !win.isFocused()) win.flashFrame(true)
  }
  w.onCall = (from) => {
    if (DEMO || !app.isPackaged || !config.meta.settings.notifications) return
    const n = new Notification({ title: lock.locked ? 'Zapdesk' : `📞 ${accountTag(acc)}${from} está ligando`, body: 'Atenda pelo celular', icon: ICON_PNG })
    n.on('click', () => openIt())
    n.show()
  }
  w.onReminder = (r, chatName) => {
    toast(`⏰ Lembrete — ${accountTag(acc)}${chatName}`, r.text, () => openIt(r.chatId))
    if (info.id === accounts.active) send({ type: 'toast', text: `⏰ Lembrete: ${chatName} — ${r.text.slice(0, 60)}` })
  }
  w.onScheduledSent = (s, chatName) => toast(`✅ Mensagem agendada enviada`, `${accountTag(acc)}${chatName}: ${s.text}`, () => openIt(s.chatId))
}

function toast(title: string, body: string, onClick?: () => void) {
  if (DEMO || !app.isPackaged || !Notification.isSupported()) return
  const n = new Notification({ title: lock.locked ? 'Zapdesk' : title, body: lock.locked ? 'Toque pra abrir' : body, icon: ICON_PNG, silent: !config.meta.settings.sound })
  n.on('click', () => (onClick ? onClick() : showWindow()))
  n.show()
}

/** what's on the OS clipboard right now: files copied in Explorer (CF_HDROP) or an image */
async function readClipboard(): Promise<{ paths: string[]; png?: Buffer }> {
  const items = await clipboard.read().catch(() => [] as Electron.ClipboardItem[])
  const types = items.flatMap((i) => i.types)
  const paths: string[] = []
  // file copies: uri-list when Chromium exposes it…
  for (const it of items) {
    if (!it.types.includes('text/uri-list')) continue
    const list = await (await it.getType('text/uri-list')).text()
    for (const line of list.split(/\r?\n/)) {
      if (!line.startsWith('file:')) continue
      try {
        const p = fileURLToPath(line.trim())
        if (fs.existsSync(p) && fs.statSync(p).isFile()) paths.push(p)
      } catch {}
    }
  }
  // …otherwise ask the shell for the file-drop list (only when no image/text is there)
  if (!paths.length && !types.some((t) => t.startsWith('image/') || t === 'text/plain')) {
    try {
      const out = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }'],
        { windowsHide: true, encoding: 'utf8', timeout: 5000 }
      )
      for (const p of out.split(/\r?\n/).map((s) => s.trim())) if (p && fs.existsSync(p) && fs.statSync(p).isFile()) paths.push(p)
    } catch {}
  }
  if (paths.length) return { paths }
  for (const it of items) {
    const t = it.types.find((x) => x.startsWith('image/'))
    if (t) return { paths, png: Buffer.from(await ((await it.getType(t)) as Blob).arrayBuffer()) }
  }
  return { paths }
}

// ---------- files waiting in the send preview ----------
// only paths you picked/copied get a token; zap://local/<token> serves them to the preview (nothing else on disk)
const staged = new Map<string, { file: string; at: number }>()
function stageLocal(file: string): OutFile {
  const now = Date.now()
  for (const [k, v] of staged) if (now - v.at > 3600_000) staged.delete(k)
  const token = randomBytes(12).toString('hex')
  staged.set(token, { file, at: now })
  let size: number | undefined
  try {
    size = fs.statSync(file).size
  } catch {}
  return { name: path.basename(file), mime: mimeFromName(file), path: file, size, preview: 'zap://local/' + token }
}

// ---------- media protocol ----------

/**
 * Serves a cached file with HTTP Range support: video/audio seeking and fast-start need 206 partial
 * responses, otherwise Chromium re-reads the whole file on every seek.
 */
function serveFile(file: string, mime: string | undefined, req: Request) {
  const size = fs.statSync(file).size
  const headers: Record<string, string> = {
    'content-type': mime || 'application/octet-stream',
    'accept-ranges': 'bytes',
    'cache-control': 'max-age=31536000, immutable',
    // the page is file://, media is zap:// → fetch() (copy image, etc.) needs CORS
    'access-control-allow-origin': '*'
  }
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') ?? '')
  let start = 0
  let end = size - 1
  let status = 200
  if (range && size) {
    if (range[1] === '' && range[2] !== '') start = Math.max(0, size - Number(range[2]))
    else {
      start = Number(range[1] || 0)
      if (range[2] !== '') end = Math.min(size - 1, Number(range[2]))
    }
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } })
    status = 206
    headers['content-range'] = `bytes ${start}-${end}/${size}`
  }
  headers['content-length'] = String(size ? end - start + 1 : 0)
  if (!size) return new Response(null, { status: 200, headers })
  const stream = Readable.toWeb(fs.createReadStream(file, { start, end, highWaterMark: 256 * 1024 })) as ReadableStream
  return new Response(stream, { status, headers })
}

// ---------- media prefetch: photos/videos that scroll into view download in the background ----------
const prefetchQ: { owner: ChatService; chatId: string; msgId: string; key: string; urgent?: boolean }[] = []
const prefetchSeen = new Set<string>()
let prefetching = 0
function prefetchMedia(chatId: string, msgId: string, urgent: boolean) {
  const key = accounts.active + '|' + chatId + '|' + msgId
  const queued = prefetchQ.findIndex((j) => j.key === key)
  if (queued >= 0) {
    // hovered/clicked: jump the queue
    if (urgent) {
      const [j] = prefetchQ.splice(queued, 1)
      j.urgent = true
      prefetchQ.unshift(j)
    }
    return
  }
  if (prefetchSeen.has(key)) return
  prefetchSeen.add(key)
  if (prefetchSeen.size > 3000) prefetchSeen.delete(prefetchSeen.values().next().value!)
  const job = { owner: wa, chatId, msgId, key, urgent }
  // newest first: what just came on screen (the bottom of a chat you open, or what you scrolled to)
  // goes before what was seen earlier; hovered/clicked ones stay ahead of everything
  if (urgent) prefetchQ.unshift(job)
  else {
    const at = prefetchQ.findIndex((j) => !j.urgent)
    prefetchQ.splice(at < 0 ? prefetchQ.length : at, 0, job)
  }
  // only the newest stuff matters: a long scroll doesn't queue hundreds of downloads (oldest dropped)
  if (prefetchQ.length > 40) for (const j of prefetchQ.splice(40)) prefetchSeen.delete(j.key)
  pumpPrefetch()
}
function pumpPrefetch() {
  while (prefetching < (liteMode() ? 1 : 3) && prefetchQ.length) {
    const j = prefetchQ.shift()!
    // the account on screen changed: its downloads wait for the next time it's opened
    if (j.owner !== wa) {
      prefetchSeen.delete(j.key)
      continue
    }
    prefetching++
    j.owner
      .media(j.chatId, j.msgId)
      .catch(() => prefetchSeen.delete(j.key))
      .finally(() => {
        prefetching--
        pumpPrefetch()
      })
  }
}

function streamTg(f: TgFile, mime: string | undefined, req: Request) {
  const size = f.size
  const headers: Record<string, string> = {
    'content-type': mime || 'application/octet-stream',
    'accept-ranges': 'bytes',
    'access-control-allow-origin': '*'
  }
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') ?? '')
  let start = 0
  let end = size - 1
  let status = 200
  if (range) {
    if (range[1] === '' && range[2] !== '') start = Math.max(0, size - Number(range[2]))
    else {
      start = Number(range[1] || 0)
      if (range[2] !== '') end = Math.min(size - 1, Number(range[2]))
    }
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } })
    status = 206
    headers['content-range'] = `bytes ${start}-${end}/${size}`
  }
  headers['content-length'] = String(end - start + 1)
  return new Response(f.stream(start, end), { status, headers })
}

function registerProtocol() {
  protocol.handle('zap', async (req) => {
    const url = new URL(req.url)
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    try {
      if (url.host === 'media') {
        const [chatId, msgId] = parts
        // Telegram videos/audio play while they download (parallel parts, the needed part first)
        if (wa instanceof TgService) {
          const s = await wa.mediaStream(chatId, msgId)
          if (s && 'tg' in s) return streamTg(s.tg, wa.mimeOf(chatId, msgId), req)
          if (s && 'file' in s) return serveFile(s.file, wa.mimeOf(chatId, msgId), req)
        }
        const file = await wa.media(chatId, msgId)
        return serveFile(file, wa.mimeOf(chatId, msgId), req)
      }
      if (url.host === 'avatar') {
        const file = await wa.avatar(parts[0], url.searchParams.has('big'))
        if (!file) return new Response(null, { status: 404 })
        return serveFile(file, 'image/jpeg', req)
      }
      if (url.host === 'poster') {
        const file = await wa.poster(parts[0], parts[1])
        if (!file) return new Response(null, { status: 404 })
        return serveFile(file, 'image/jpeg', req)
      }
      if (url.host === 'font') {
        const dir = path.join(userData, 'fonts')
        const f = fs.existsSync(dir) ? fs.readdirSync(dir).find((x) => x.startsWith('custom.')) : undefined
        if (!f) return new Response(null, { status: 404 })
        const ext = path.extname(f).slice(1)
        const res = serveFile(path.join(dir, f), ext === 'woff2' ? 'font/woff2' : ext === 'woff' ? 'font/woff' : ext === 'otf' ? 'font/otf' : 'font/ttf', req)
        return res
      }
      if (url.host === 'local') {
        const hit = staged.get(parts[0])
        if (!hit || !fs.existsSync(hit.file)) return new Response(null, { status: 404 })
        return serveFile(hit.file, mimeFromName(hit.file), req)
      }
      if (url.host === 'sticker') {
        const file = wa.stickerPath(parts[0])
        if (!fs.existsSync(file)) return new Response(null, { status: 404 })
        return serveFile(file, 'image/webp', req)
      }
    } catch {
      return new Response(null, { status: 404 })
    }
    return new Response(null, { status: 400 })
  })
}

// ---------- IPC ----------

function registerIpc() {
  ipcMain.handle('init', (): InitPayload => ({
    version: app.getVersion(),
    update: pendingUpdate,
    whisper: whisper().state(),
    chats: wa.allChats(),
    settings: config.meta.settings,
    stickers: wa.stickers(),
    conn: wa.conn,
    qr: wa.qr,
    me: wa.me,
    folders: wa.folders(),
    passwordHint: wa instanceof TgService ? wa.passwordHint : undefined,
    loginError: wa instanceof TgService ? wa.loginError : undefined,
    locked: lock.locked,
    hasPin: lock.hasPin(),
    pinLength: lock.pinLength(),
    scheduled: store.meta.scheduled,
    reminders: store.meta.reminders,
    accounts: accountSummaries(),
    openChat: pendingOpen,
    lowEnd
  }))
  ipcMain.on('booted', () => {
    pendingOpen = undefined
    // re-sync window focus for the account on screen after a reload/switch
    wa.focused = !!win?.isFocused()
    void wa.setOnline(wa.focused)
  })
  ipcMain.handle('switchAccount', (_e, id: string) => switchAccount(id))
  ipcMain.handle('addAccount', (_e, kind?: 'wa' | 'tg') => addAccount(kind === 'tg' ? 'tg' : 'wa'))
  ipcMain.handle('tgSetup', (_e, apiId: string, apiHash: string) => {
    if (!(wa instanceof TgService)) throw new Error('Essa conta não é do Telegram')
    return wa.setup(apiId, apiHash)
  })
  ipcMain.handle('tgPassword', (_e, pw: string) => {
    if (wa instanceof TgService) wa.password(String(pw ?? ''))
  })
  ipcMain.handle('removeAccount', (_e, id: string) => removeAccount(id))
  ipcMain.handle('renameAccount', (_e, id: string, label: string) => {
    accounts.update(id, { label: label.trim().slice(0, 40) || undefined })
    pushSummaries()
  })
  ipcMain.on('log', (_e, msg: string) => log('renderer', new Error(String(msg).slice(0, 4000))))
  // renderer frames that took too long (PerformanceObserver longtask), summed into the perf log
  ipcMain.on('stall', (_e, ms: number) => rendererStall(Number(ms) || 0))
  ipcMain.handle('perfStats', () => ({ system: systemInfo(), lowEnd: isLowEnd(), ...perfSnapshot() }))
  ipcMain.handle('exportDiagnostics', () => {
    const s = config.meta.settings
    const lines = [
      'Zapdesk — diagnóstico (' + new Date().toLocaleString('pt-BR') + ')',
      '',
      'PC: ' + JSON.stringify({ ...systemInfo(), lowEnd: isLowEnd() }, null, 1),
      '',
      'Desempenho: ' + JSON.stringify(perfSnapshot(), null, 1),
      '',
      'Contas: ' + JSON.stringify([...live.values()].map((a) => ({ kind: a.info.kind ?? 'wa', conn: a.wa.conn, chats: a.store.chats.size, loaded: a.store.buckets.size }))),
      'Ajustes: ' + JSON.stringify({ performance: s.performance ?? 'auto', glass: s.appearance.glass, font: s.appearance.font, autoTranscribe: s.autoTranscribe, hoverPeek: s.hoverPeek, zoom: s.appearance.zoom, autoScale: s.appearance.autoScale }),
      '',
      '--- log (últimas linhas) ---'
    ]
    let tail = ''
    try {
      tail = fs.readFileSync(logFile, 'utf8').split(/\r?\n/).slice(-400).join('\r\n')
    } catch {}
    const file = path.join(app.getPath('desktop'), `Zapdesk-diagnostico-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.txt`)
    // BOM so Notepad on any Windows reads the accents right
    fs.writeFileSync(file, '﻿' + lines.join('\r\n') + '\r\n' + tail)
    shell.showItemInFolder(file)
    return file
  })
  ipcMain.handle('messages', (_e, chatId: string, beforeTs?: number) => wa.getMessages(chatId, beforeTs))
  ipcMain.handle('shared', (_e, chatId: string) => wa.getShared(chatId))
  ipcMain.handle('whisperInstall', () => void whisper().install())
  ipcMain.handle('whisperCancel', () => whisper().cancel())
  ipcMain.handle('whisperRemove', () => whisper().remove())
  ipcMain.handle('transcribe', async (_e, chatId: string, msgId: string, pcm: ArrayBuffer, urgent?: boolean) => {
    const owner = wa
    const text = await whisper().transcribe(chatId + '/' + msgId, pcm, {
      urgent: !!urgent,
      onPartial: (partial) => send({ type: 'transcript', chatId, msgId, text: partial })
    })
    owner.setTranscript(msgId, text, chatId)
    return text
  })
  ipcMain.handle('checkUpdate', async () => {
    await checkGitHub()
    pendingUpdate = currentUpdate()
    return pendingUpdate
  })
  ipcMain.handle('installUpdate', async () => {
    const u = currentUpdate()
    if (!u) return false
    if (u.remote) {
      // from GitHub: download first (the button shows the %), then the same silent install
      log('update', 'downloading ' + u.version)
      try {
        await downloadRemote((progress) => send({ type: 'update', update: { ...u, progress } }))
      } catch (err) {
        log('update', err)
        send({ type: 'update', update: u })
        throw new Error('Não deu pra baixar a atualização. Tente de novo em instantes.')
      }
      if (process.env.ZAP_UPDATE_NOINSTALL) {
        log('update', 'downloaded ' + u.file + ' (not installing: test)')
        return true
      }
    }
    log('update', 'installing ' + u.version)
    config.flush()
    runInstaller(u)
    // the installer waits for us to close; it reopens the new version when done
    setTimeout(() => {
      quitting = true
      app.quit()
    }, 300)
    return true
  })
  ipcMain.handle('peek', (_e, chatId: string) => wa.peek(chatId))
  ipcMain.on('prefetch', (_e, chatId: string, msgId: string, urgent?: boolean) => prefetchMedia(chatId, msgId, !!urgent))
  ipcMain.handle('send', (_e, chatId: string, text: string, quotedId?: string, opts?: { noPreview?: boolean }) => wa.send(chatId, text, quotedId, opts))
  ipcMain.handle('linkMeta', (_e, url: string) => (config.meta.settings.linkPreviews ? getLinkMeta(url) : null))
  ipcMain.handle('sendSticker', (_e, chatId: string, id: string) => wa.sendSticker(chatId, id))
  ipcMain.handle('sendFiles', (_e, chatId: string, files: OutFile[], caption?: string) =>
    wa.sendFiles(
      chatId,
      files.map((f) =>
        f.path
          ? { name: f.name || path.basename(f.path), mime: f.mime || mimeFromName(f.path), path: f.path }
          : { name: f.name, mime: f.mime || mimeFromName(f.name), data: Buffer.from(f.data!) }
      ),
      caption
    )
  )
  // picked / Explorer-copied files come back to the preview sheet first; nothing is sent until you confirm
  ipcMain.handle('pickFiles', async (): Promise<OutFile[]> => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openFile', 'multiSelections'], title: 'Enviar arquivos' })
    if (r.canceled || !r.filePaths.length) return []
    return r.filePaths.map(stageLocal)
  })
  // Ctrl+V of files copied in Explorer (Chromium only exposes images from the clipboard)
  ipcMain.handle('pasteClipboard', async (): Promise<OutFile[]> => {
    const { paths, png } = await readClipboard()
    if (paths.length) return paths.map(stageLocal)
    if (png?.length) return [{ name: 'imagem.png', mime: 'image/png', data: png.buffer.slice(png.byteOffset, png.byteOffset + png.length) as ArrayBuffer, size: png.length }]
    return []
  })
  // "Outra fonte…": the file is copied into userData/fonts and served as zap://font/custom
  ipcMain.handle('importFont', async () => {
    const r = await dialog.showOpenDialog(win!, { title: 'Escolher fonte', properties: ['openFile'], filters: [{ name: 'Fontes', extensions: ['ttf', 'otf', 'woff', 'woff2'] }] })
    if (r.canceled || !r.filePaths[0]) return null
    const src = r.filePaths[0]
    const dir = path.join(userData, 'fonts')
    fs.mkdirSync(dir, { recursive: true })
    for (const f of fs.readdirSync(dir)) if (f.startsWith('custom.')) fs.rmSync(path.join(dir, f), { force: true })
    fs.copyFileSync(src, path.join(dir, 'custom' + path.extname(src).toLowerCase()))
    return path.basename(src).replace(/\.(ttf|otf|woff2?)$/i, '')
  })
  ipcMain.on('savePoster', (_e, chatId: string, msgId: string, jpeg: ArrayBuffer) => {
    try {
      store.savePoster(chatId, msgId, Buffer.from(jpeg))
    } catch (err) {
      log('poster', err as Error)
    }
  })
  ipcMain.handle('schedule', (_e, chatId: string, text: string, at: number) => wa.schedule(chatId, text, at))
  ipcMain.handle('cancelScheduled', (_e, id: string) => wa.cancelScheduled(id))
  ipcMain.handle('remind', (_e, chatId: string, msgId: string, at: number) => wa.remind(chatId, msgId, at))
  ipcMain.handle('cancelReminder', (_e, id: string) => wa.cancelReminder(id))
  ipcMain.handle('readNow', (_e, chatId: string) => wa.read(chatId, true))
  ipcMain.handle('resend', (_e, chatId: string, msgId: string) => wa.resend(chatId, msgId))
  ipcMain.handle('resolveNumber', (_e, phone: string) => wa.resolveNumber(phone))
  ipcMain.handle('exportChat', async (_e, chatId: string) => {
    const name = wa.chatName(store.chats.get(chatId) ?? { id: chatId, ts: 0, unread: 0 })
    const r = await dialog.showSaveDialog(win!, {
      title: 'Exportar conversa',
      defaultPath: path.join(app.getPath('documents'), `Conversa - ${name.replace(/[<>:"/\\|?*]/g, '_')}.txt`),
      filters: [{ name: 'Texto', extensions: ['txt'] }]
    })
    if (r.canceled || !r.filePath) return null
    fs.writeFileSync(r.filePath, '﻿' + wa.exportText(chatId), 'utf8')
    shell.showItemInFolder(r.filePath)
    return r.filePath
  })
  ipcMain.handle('react', (_e, chatId: string, msgId: string, emoji: string) => wa.react(chatId, msgId, emoji))
  ipcMain.handle('editMessage', (_e, chatId: string, msgId: string, text: string) => wa.editMessage(chatId, msgId, text))
  ipcMain.handle('votePoll', (_e, chatId: string, msgId: string, options: number[]) => wa.votePoll(chatId, msgId, options))
  ipcMain.handle('sendPoll', (_e, chatId: string, name: string, options: string[], multi: boolean) => wa.sendPoll(chatId, name, options, multi))
  ipcMain.handle('read', (_e, chatId: string) => (win?.isFocused() && !lock.locked ? wa.read(chatId) : undefined))
  ipcMain.handle('typing', (_e, chatId: string, on: boolean) => wa.typing(chatId, on))
  ipcMain.handle('chatAction', (_e, chatId: string, a: ChatAction) => wa.chatAction(chatId, a))
  ipcMain.on('activeChat', (_e, chatId: string | null) => wa.setActive(chatId))
  ipcMain.handle('settings', (_e, patch: Partial<Settings>): Settings => {
    setSettings({
      ...config.meta.settings,
      ...patch,
      appearance: { ...config.meta.settings.appearance, ...(patch.appearance ?? {}) },
      ghost: { ...config.meta.settings.ghost, ...(patch.ghost ?? {}) }
    })
    if (patch.ghost) for (const a of live.values()) void a.wa.setOnline(a.wa === wa && !!win?.isFocused())
    if ('startWithWindows' in patch) app.setLoginItemSettings({ openAtLogin: !!patch.startWithWindows, args: ['--hidden'] })
    if (patch.appearance) applyZoom()
    return config.meta.settings
  })
  ipcMain.handle('setPin', (_e, pin: string) => {
    const ok = lock.setPin(pin)
    updateTray()
    return ok
  })
  ipcMain.handle('unlock', (_e, pin: string) => lock.unlock(pin))
  ipcMain.handle('lockNow', () => lock.lock())
  ipcMain.on('activity', () => lock.activity())
  ipcMain.handle('logout', () => wa.logout())
  // escape hatch: forgetting the PIN wipes EVERY account (otherwise the PIN could be bypassed by switching)
  ipcMain.handle('forgotPin', async () => {
    for (const a of live.values()) await a.wa.logout().catch((err) => log('forgotPin', err))
    for (const info of accounts.list.slice(1)) await removeAccount(info.id)
    lock.clearPin()
  })
  ipcMain.handle('pairingCode', (_e, phone: string) => wa.pairingCode(phone))
  ipcMain.handle('resyncStickers', () => wa.resyncStickers())
  ipcMain.handle('favSticker', (_e, chatId: string, msgId: string, fav: boolean) => wa.favSticker(chatId, msgId, fav))
  ipcMain.handle('removeSticker', (_e, id: string) => wa.removeSticker(id))
  ipcMain.handle('openMedia', async (_e, chatId: string, msgId: string) => {
    const file = await wa.media(chatId, msgId)
    const name = wa.fileNameOf(chatId, msgId)
    let target = file
    if (name) {
      const dir = path.join(app.getPath('downloads'), 'Zapdesk')
      fs.mkdirSync(dir, { recursive: true })
      target = path.join(dir, name.replace(/[<>:"/\\|?*]/g, '_'))
      if (!fs.existsSync(target)) fs.copyFileSync(file, target)
    }
    await shell.openPath(target)
  })
  ipcMain.on('chrome', (_e, bg: string, symbol: string, glass?: boolean, scheme?: 'dark' | 'light') => {
    if (!win || win.isDestroyed()) return
    // the acrylic tint follows the app theme, not Windows' light/dark setting (keeps text readable)
    if (scheme === 'dark' || scheme === 'light') nativeTheme.themeSource = scheme
    applyGlass(!!glass, bg)
    chromeSymbol = symbol
    applyZoom()
    try {
      fs.writeFileSync(chromeFile, JSON.stringify({ bg, symbol, glass: !!glass }))
    } catch {}
  })
  ipcMain.on('badge', (_e, count: number, dataUrl: string | null) => {
    unreadTotal = count
    if (win && !win.isDestroyed())
      win.setOverlayIcon(dataUrl ? nativeImage.createFromDataURL(dataUrl) : null, count ? `${count} não lidas` : '')
    updateTray()
  })
}

function mimeFromName(p: string) {
  const ext = path.extname(p).slice(1).toLowerCase()
  const map: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    webm: 'video/webm',
    mp3: 'audio/mpeg',
    ogg: 'audio/ogg',
    m4a: 'audio/mp4',
    wav: 'audio/wav',
    pdf: 'application/pdf',
    zip: 'application/zip',
    txt: 'text/plain',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  }
  return map[ext] ?? 'application/octet-stream'
}

// ---------- lifecycle ----------

app.on('second-instance', showWindow)
app.on('before-quit', () => {
  quitting = true
  for (const a of live.values()) {
    try {
      a.wa.shutdown()
    } catch (err) {
      log('shutdown', err)
    }
  }
  config.flush()
  lock.dispose()
})
app.on('window-all-closed', () => {
  if (!config.meta.settings.closeToTray) app.quit()
})

/** slow-PC verdict: CPU/RAM right away, the GPU part once Chromium's GPU process has started */
let lowEnd = isLowEnd(false)
function liteMode() {
  const p = config.meta.settings.performance ?? 'auto'
  return p === 'leve' || (p === 'auto' && lowEnd)
}

app.whenReady().then(() => {
  setTimeout(() => {
    const full = isLowEnd(true)
    if (full !== lowEnd) {
      lowEnd = full
      send({ type: 'lowEnd', lowEnd })
    }
  }, 6000)
  // after the GPU process is up (earlier it reports "software" for everything)
  setTimeout(() => startPerfLog(log, () => ({ accounts: live.size, chats: store?.chats.size ?? 0, loadedChats: store?.buckets.size ?? 0 })), 8000)
  Menu.setApplicationMenu(null)
  registerProtocol()
  registerIpc()
  createTray()
  createWindow(!process.argv.includes('--hidden'))
  powerMonitor.on('lock-screen', () => lock.lock())
  powerMonitor.on('suspend', () => lock.lock())
  powerMonitor.on('resume', () => {
    for (const a of live.values()) a.wa.nudge()
  })
  for (const a of live.values()) a.wa.startTimers()
  if ((app.isPackaged && !DEMO) || process.env.ZAP_UPDATE_DIR)
    watchUpdates((u) => {
      pendingUpdate = u
      if (u) log('update', 'available ' + u.version)
      send({ type: 'update', update: u })
    })
  if (!DEMO) for (const a of live.values()) void a.wa.start()
  else if (wa.kind === 'tg') {
    wa.conn = 'open'
    wa.me = { id: 'tg:777', name: 'Fabio', phone: '5511988887777' }
  } else {
    wa.conn = 'open'
    wa.me = { id: '5511999999999@s.whatsapp.net', name: 'Fabio Silverio' }
    ;(wa as any).blocked.add('5511900000003@s.whatsapp.net')
    ;(wa as any).fixSelfChat()
    if (process.env.ZAP_HEAVY_LIVE) win!.webContents.once('did-finish-load', () => setTimeout(() => heavyLive((m, live) => (wa as any).ingest(m, live)), 6000))
    if (process.env.ZAP_LIVE) win!.webContents.once('did-finish-load', () => demoLive((m, live) => (wa as any).ingest(m, live), (wa as any).store?.dir))
    // dev-only (ZAP_SYNCTEST): a history batch whose chats carry the protobuf defaults (pinned/mute = null)
    // must not unpin/unmute; then a PC clock 10 min behind WhatsApp's
    if (process.env.ZAP_SYNCTEST)
      setTimeout(async () => {
        const w = wa as any
        const { proto } = await import('baileys')
        const id = '5511900000005@s.whatsapp.net'
        const rec = w.store.chats.get(id)
        rec.waPinned = 1700000000
        rec.muteUntil = Date.now() + 3600_000
        const conv = proto.Conversation.decode(proto.Conversation.encode({ id }).finish())
        await w.handleEvents({ 'messaging-history.set': { chats: [conv], contacts: [], messages: [], isLatest: false, progress: 50 } }, w.sock)
        log('synctest', `after history: pinned=${!!rec.waPinned} muted=${!!rec.muteUntil}`)
        await w.handleEvents({ 'chats.update': [{ id, pinned: null }] }, w.sock)
        log('synctest', `after real unpin: pinned=${!!rec.waPinned}`)
        w.setServerTime(Math.floor((Date.now() + 10 * 60_000) / 1000))
        const stamp = w.sendStamp('120363000000000001@g.us').getTime()
        log('synctest', `clock offset=${Math.round(w.clockOffset / 1000)}s stampAhead=${Math.round((stamp - Date.now()) / 1000)}s`)
      }, 3000)
    // dev-only: group receipts for one of your messages (ZAP_GROUPTEST): stuck "pending" → delivered → read by all
    if (process.env.ZAP_GROUPTEST)
      setTimeout(() => {
        const w = wa as any
        const grp = '120363000000000001@g.us'
        const mine = w.store.sorted(grp).filter((m: any) => m.key.fromMe).at(-1)
        mine.status = 1
        w.groups.set(grp, { id: grp, participants: [{ id: '5511999999999@s.whatsapp.net' }, { id: '5511911110001@s.whatsapp.net' }, { id: '5511911110002@s.whatsapp.net' }] })
        ;(globalThis as any).__grpMsg = mine.key.id
        const rc = (who: string, kind: string) => ({ key: { remoteJid: grp, fromMe: true, id: mine.key.id }, receipt: { userJid: who, [kind]: Math.floor(Date.now() / 1000) } })
        const ui = () => w.getMessages(grp).messages.filter((m: any) => m.fromMe).at(-1)?.status
        log('grouptest', 'stuck(old) ui=' + ui() + ' raw=' + mine.status)
        const step = (label: string, who: string, kind: string) =>
          void w.handleEvents({ 'message-receipt.update': [rc(who, kind)] }, w.sock).then(() => log('grouptest', label + ' ui=' + ui()))
        setTimeout(() => step('delivered1', '5511911110001@s.whatsapp.net', 'receiptTimestamp'), 500)
        setTimeout(() => step('read1of2', '5511911110001@s.whatsapp.net', 'readTimestamp'), 1000)
        setTimeout(() => step('readAll', '5511911110002@s.whatsapp.net', 'readTimestamp'), 1500)
      }, 3000)
    // dev-only: the phone reads a 1:1 chat and a group (read receipts from your own device)
    if (process.env.ZAP_READTEST)
      setTimeout(() => {
        const w = wa as any
        const dm = '5511900000002@s.whatsapp.net'
        const grp = '120363000000000001@g.us'
        const last = (id: string) => w.store.sorted(id).filter((m: any) => !m.key.fromMe).at(-1)?.key.id
        void w.handleEvents(
          {
            'messages.update': [{ key: { remoteJid: dm, fromMe: false, id: last(dm) }, update: { status: 4 } }],
            'message-receipt.update': [{ key: { remoteJid: grp, fromMe: true, id: last(grp) }, receipt: { userJid: '5511999999999@s.whatsapp.net', readTimestamp: Math.floor(Date.now() / 1000) } }]
          },
          w.sock
        )
      }, 5000)
  }
  // dev-only: ZAP_SHOT=<file.png> captures the window and quits
  const shot = process.env.ZAP_SHOT
  if (shot) {
    win!.webContents.once('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, Number(process.env.ZAP_WAIT ?? 1200)))
      if (process.env.ZAP_CRASH) {
        // self-healing check: kill the page, it must come back on its own
        const back = new Promise<void>((r) => win!.webContents.once('did-finish-load', () => r()))
        win!.webContents.forcefullyCrashRenderer()
        await back
        await new Promise((r) => setTimeout(r, 1500))
      }
      if (process.env.ZAP_OPEN) send({ type: 'openChat', chatId: process.env.ZAP_OPEN })
      if (process.env.ZAP_JS) await win!.webContents.executeJavaScript(process.env.ZAP_JS).catch((e) => console.error(e))
      // ZAP_MOUSE="x,y;x,y;…": real mouse moves (hover states), 700ms apart
      for (const pt of (process.env.ZAP_MOUSE ?? '').split(';').filter(Boolean)) {
        const [x, y] = pt.split(',').map(Number)
        win!.webContents.sendInputEvent({ type: 'mouseMove', x, y })
        await new Promise((r) => setTimeout(r, 700))
      }
      await new Promise((r) => setTimeout(r, 1500))
      const img = await win!.webContents.capturePage()
      fs.writeFileSync(shot, img.toPNG())
      quitting = true
      app.quit()
    })
  }
})
