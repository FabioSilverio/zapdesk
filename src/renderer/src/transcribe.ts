// Voice-note transcription (renderer side): decode the opus with Chromium's own decoder to 16 kHz mono,
// hand the PCM to the main process (whisper.cpp), keep results per message.
import { useSyncExternalStore } from 'react'
import type { UiMessage } from '@shared/types'
import { getState, isLite, toast, zap } from './state'
import { askConfirm } from './components/overlays'

/** partial: what a long note says so far, while it's still being transcribed */
type Entry = { text?: string; busy?: boolean; error?: string; partial?: string }
const entries = new Map<string, Entry>()
const subs = new Set<() => void>()
const emit = () => subs.forEach((f) => f())
const subscribe = (f: () => void) => {
  subs.add(f)
  return () => subs.delete(f)
}
const set = (id: string, e: Entry) => {
  entries.set(id, e)
  emit()
}

export function useTranscript(m: UiMessage): Entry {
  return useSyncExternalStore(subscribe, () => entries.get(key(m)) ?? (m.transcript !== undefined ? seed(m) : EMPTY))
}
const EMPTY: Entry = {}
function seed(m: UiMessage): Entry {
  const e = { text: m.transcript }
  entries.set(key(m), e)
  return e
}

/** per chat: Telegram channels number their messages separately, so ids repeat across chats */
const key = (m: UiMessage) => m.chatId + '/' + m.id

const mediaUrl = (m: UiMessage) => `zap://media/${encodeURIComponent(m.chatId)}/${encodeURIComponent(m.id)}`

async function pcm16(m: UiMessage): Promise<ArrayBuffer> {
  const res = await fetch(mediaUrl(m))
  if (!res.ok) throw new Error('Não deu pra baixar o áudio')
  const data = await res.arrayBuffer()
  // decodeAudioData resamples to the context rate: 16 kHz is what whisper wants
  const ctx = new OfflineAudioContext(1, 1, 16000)
  const buf = await ctx.decodeAudioData(data)
  const n = buf.length
  const a = buf.getChannelData(0)
  const b = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null
  const mono = b ? new Float32Array(n) : a
  if (b) for (let i = 0; i < n; i++) mono[i] = (a[i] + b[i]) * 0.5
  // cut the silence before and after the speech: less audio = faster, and no "[silêncio]" hallucinations
  const [from, to] = speechBounds(mono)
  const out = new Int16Array(to - from)
  for (let i = from; i < to; i++) {
    const v = mono[i] > 1 ? 1 : mono[i] < -1 ? -1 : mono[i]
    out[i - from] = v < 0 ? v * 0x8000 : v * 0x7fff
  }
  return out.buffer
}

/** first/last 20 ms frame that's louder than room noise, with a 0.3 s cushion on each side */
function speechBounds(x: Float32Array): [number, number] {
  const F = 320
  const frames = Math.floor(x.length / F)
  if (frames < 10) return [0, x.length]
  const rms = new Float32Array(frames)
  let peak = 0
  for (let f = 0; f < frames; f++) {
    let s = 0
    for (let i = f * F; i < (f + 1) * F; i++) s += x[i] * x[i]
    rms[f] = Math.sqrt(s / F)
    if (rms[f] > peak) peak = rms[f]
  }
  const gate = Math.max(0.004, peak * 0.06)
  let first = 0
  while (first < frames && rms[first] < gate) first++
  let last = frames - 1
  while (last > first && rms[last] < gate) last--
  if (first >= frames) return [0, 0]
  const pad = 15 // frames = 0.3 s
  return [Math.max(0, (first - pad) * F), Math.min(x.length, (last + 1 + pad) * F)]
}

/** messages waiting for the engine download to finish */
const waiting = new Map<string, UiMessage>()

export function onWhisperReady() {
  const list = [...waiting.values()]
  waiting.clear()
  // those bubbles are parked as "busy": clear that first or transcribeMsg would skip them
  for (const m of list) {
    entries.delete(key(m))
    void transcribeMsg(m)
  }
}

export async function transcribeMsg(m: UiMessage, auto = false) {
  const cur = entries.get(key(m))
  if (cur?.busy) return
  const w = getState().whisper
  if (!w.ready) {
    if (auto) return
    if (w.progress === null) {
      const ok = await askConfirm(
        'Ativar transcrição de áudios?',
        'O Zapdesk baixa uma vez o motor de transcrição (~200 MB). Ele roda 100% no seu PC: o áudio não sai daqui e não tem custo.\n\nDepois é só clicar em “Transcrever” em qualquer áudio.',
        'Baixar e transcrever'
      )
      if (!ok) return
      void zap.whisperInstall()
    }
    waiting.set(key(m), m)
    set(key(m), { busy: true })
    return
  }
  set(key(m), { busy: true })
  try {
    const pcm = await pcm16(m)
    const text = await zap.transcribe(m.chatId, m.id, pcm, !auto)
    set(key(m), { text })
  } catch (err) {
    const msg = String((err as Error)?.message ?? err).replace(/^Error invoking remote method '\w+': (Error: )?/, '')
    set(key(m), { error: msg || 'Não deu pra transcrever' })
    if (!auto) toast('Não deu pra transcrever esse áudio')
  }
}

/** download failed/cancelled: release the bubbles that were waiting */
export function onWhisperFailed() {
  for (const id of waiting.keys()) entries.delete(id)
  waiting.clear()
  emit()
}

/**
 * Voice notes that just arrived get transcribed right away (Configurações → Transcrever automaticamente),
 * even in chats you haven't opened: the chat list and the bubble already show the text.
 * Also shows long notes filling in while whisper works through them.
 */
export function watchTranscripts() {
  return zap.onEvent((ev) => {
    if (ev.type === 'transcript') {
      const k = ev.chatId + '/' + ev.msgId
      const cur = entries.get(k)
      if (cur?.busy) set(k, { busy: true, partial: ev.text })
      return
    }
    if (ev.type !== 'msgs' && ev.type !== 'voiceIn') return
    const st = getState()
    // lite mode: whisper eats the CPU of a slow PC — only the ones you click
    if (!st.settings?.autoTranscribe || !st.whisper.ready || isLite(st)) return
    const now = Date.now()
    for (const m of ev.type === 'msgs' ? ev.messages : [ev.message])
      if (isVoice(m) && !m.fromMe && m.transcript === undefined && now - m.ts < 10 * 60_000 && !entries.has(key(m))) void transcribeMsg(m, true)
  })
}

export const isVoice = (m: UiMessage) => m.kind === 'audio' && !!m.ptt && !!m.hasMedia
