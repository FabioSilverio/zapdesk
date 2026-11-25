import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { MainEvent, ZapApi } from '@shared/types'

const inv = (ch: string) => (...args: unknown[]) => ipcRenderer.invoke(ch, ...args)

const api: ZapApi = {
  init: inv('init') as ZapApi['init'],
  messages: inv('messages') as ZapApi['messages'],
  shared: inv('shared') as ZapApi['shared'],
  peek: inv('peek') as ZapApi['peek'],
  prefetch: (chatId, msgId, urgent) => ipcRenderer.send('prefetch', chatId, msgId, !!urgent),
  installUpdate: inv('installUpdate') as ZapApi['installUpdate'],
  checkUpdate: inv('checkUpdate') as ZapApi['checkUpdate'],
  whisperInstall: inv('whisperInstall') as ZapApi['whisperInstall'],
  whisperCancel: inv('whisperCancel') as ZapApi['whisperCancel'],
  whisperRemove: inv('whisperRemove') as ZapApi['whisperRemove'],
  transcribe: inv('transcribe') as ZapApi['transcribe'],
  send: inv('send') as ZapApi['send'],
  linkMeta: inv('linkMeta') as ZapApi['linkMeta'],
  sendSticker: inv('sendSticker') as ZapApi['sendSticker'],
  sendFiles: inv('sendFiles') as ZapApi['sendFiles'],
  pickFiles: inv('pickFiles') as ZapApi['pickFiles'],
  savePoster: (chatId, msgId, jpeg) => ipcRenderer.send('savePoster', chatId, msgId, jpeg),
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
  pasteClipboard: inv('pasteClipboard') as ZapApi['pasteClipboard'],
  schedule: inv('schedule') as ZapApi['schedule'],
  cancelScheduled: inv('cancelScheduled') as ZapApi['cancelScheduled'],
  remind: inv('remind') as ZapApi['remind'],
  cancelReminder: inv('cancelReminder') as ZapApi['cancelReminder'],
  exportChat: inv('exportChat') as ZapApi['exportChat'],
  readNow: inv('readNow') as ZapApi['readNow'],
  resend: inv('resend') as ZapApi['resend'],
  resolveNumber: inv('resolveNumber') as ZapApi['resolveNumber'],
  react: inv('react') as ZapApi['react'],
  read: inv('read') as ZapApi['read'],
  typing: inv('typing') as ZapApi['typing'],
  chatAction: inv('chatAction') as ZapApi['chatAction'],
  setActiveChat: (id) => ipcRenderer.send('activeChat', id),
  setSettings: inv('settings') as ZapApi['setSettings'],
  setPin: inv('setPin') as ZapApi['setPin'],
  unlock: inv('unlock') as ZapApi['unlock'],
  lockNow: inv('lockNow') as ZapApi['lockNow'],
  activity: () => ipcRenderer.send('activity'),
  logout: inv('logout') as ZapApi['logout'],
  forgotPin: inv('forgotPin') as ZapApi['forgotPin'],
  pairingCode: inv('pairingCode') as ZapApi['pairingCode'],
  resyncStickers: inv('resyncStickers') as ZapApi['resyncStickers'],
  favSticker: inv('favSticker') as ZapApi['favSticker'],
  removeSticker: inv('removeSticker') as ZapApi['removeSticker'],
  openMedia: inv('openMedia') as ZapApi['openMedia'],
  setBadge: (count, dataUrl) => ipcRenderer.send('badge', count, dataUrl),
  setChrome: (bg, symbol, glass, scheme) => ipcRenderer.send('chrome', bg, symbol, !!glass, scheme),
  importFont: inv('importFont') as ZapApi['importFont'],
  switchAccount: inv("switchAccount") as ZapApi["switchAccount"],
  addAccount: inv("addAccount") as ZapApi["addAccount"],
  tgSetup: inv("tgSetup") as ZapApi["tgSetup"],
  tgPassword: inv("tgPassword") as ZapApi["tgPassword"],
  removeAccount: inv("removeAccount") as ZapApi["removeAccount"],
  renameAccount: inv("renameAccount") as ZapApi["renameAccount"],
  log: (msg) => ipcRenderer.send("log", msg),
  booted: () => ipcRenderer.send("booted"),
  onEvent: (cb) => {
    const fn = (_e: unknown, ev: MainEvent) => cb(ev)
    ipcRenderer.on('zap:event', fn)
    return () => ipcRenderer.removeListener('zap:event', fn)
  }
}

contextBridge.exposeInMainWorld('zap', api)
