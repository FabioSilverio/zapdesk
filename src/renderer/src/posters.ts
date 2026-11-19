// Sharp first frame for video bubbles (instead of WhatsApp's tiny blurry thumbnail).
// Grabbed once from the downloaded video into a JPEG, then kept by main (zap://poster/…) for next time.
import type { UiMessage } from '@shared/types'
import { zap } from './state'

const enc = encodeURIComponent
export const posterUrl = (m: UiMessage) => `zap://poster/${enc(m.chatId)}/${enc(m.id)}`
const mediaUrl = (m: UiMessage) => `zap://media/${enc(m.chatId)}/${enc(m.id)}`

/** grabbed this session (object URLs), so scrolling back doesn't flash the blurry one again */
const done = new Map<string, string>()
const failed = new Set<string>()
const key = (m: UiMessage) => m.chatId + '/' + m.id
export const grabbedPoster = (m: UiMessage) => done.get(key(m))

type Job = { m: UiMessage; resolve: (url: string | null) => void }
const queue: Job[] = []
const pending = new Map<string, Promise<string | null>>()
let running = 0

export function grabPoster(m: UiMessage): Promise<string | null> {
  const k = key(m)
  const hit = done.get(k)
  if (hit) return Promise.resolve(hit)
  if (failed.has(k)) return Promise.resolve(null)
  const p = pending.get(k)
  if (p) return p
  const job = new Promise<string | null>((resolve) => {
    // newest on top of the queue: the bubble you just scrolled to goes first
    queue.unshift({ m, resolve })
    pump()
  })
  pending.set(k, job)
  void job.finally(() => pending.delete(k))
  return job
}

function pump() {
  // 2 at a time: each one is a short-lived video decoder
  while (running < 2 && queue.length) {
    const { m, resolve } = queue.shift()!
    running++
    grab(m)
      .then((url) => {
        if (url) done.set(key(m), url)
        else failed.add(key(m))
        resolve(url)
      })
      .catch(() => {
        failed.add(key(m))
        resolve(null)
      })
      .finally(() => {
        running--
        pump()
      })
  }
}

function once(v: HTMLVideoElement, ev: string, ms: number) {
  return new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout')), ms)
    v.addEventListener(ev, () => (clearTimeout(t), res()), { once: true })
    v.addEventListener('error', () => (clearTimeout(t), rej(new Error('video error'))), { once: true })
  })
}

/** average brightness 0-255 of a few sample rows: a fade-in from black makes a useless poster */
function brightness(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const d = ctx.getImageData(0, 0, w, h).data
  let sum = 0
  let n = 0
  for (let i = 0; i < d.length; i += 4 * 37) {
    sum += d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11
    n++
  }
  return n ? sum / n : 0
}

async function grab(m: UiMessage): Promise<string | null> {
  const v = document.createElement('video')
  v.muted = true
  v.playsInline = true
  v.preload = 'auto'
  // zap:// answers with CORS headers: without this the canvas is "tainted" and can't be exported
  v.crossOrigin = 'anonymous'
  try {
    v.src = mediaUrl(m)
    // the file may still be downloading (WhatsApp decrypts it whole first)
    await once(v, 'loadeddata', 60_000)
    const vw = v.videoWidth
    const vh = v.videoHeight
    if (!vw || !vh) return null
    const scale = Math.min(1, 640 / Math.max(vw, vh))
    const w = Math.round(vw * scale)
    const h = Math.round(vh * scale)
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const ctx = c.getContext('2d', { willReadFrequently: true })!
    ctx.drawImage(v, 0, 0, w, h)
    // first frame is (almost) black: take one a bit later
    if (brightness(ctx, w, h) < 10 && v.duration > 1.5) {
      v.currentTime = Math.min(1, v.duration * 0.1)
      await once(v, 'seeked', 8000)
      ctx.drawImage(v, 0, 0, w, h)
    }
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.82))
    if (!blob) return null
    zap.savePoster(m.chatId, m.id, await blob.arrayBuffer())
    return URL.createObjectURL(blob)
  } finally {
    v.removeAttribute('src')
    v.load()
  }
}
