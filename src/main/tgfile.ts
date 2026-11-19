// Fast Telegram file download, the way Telegram Desktop does it: 512 KB parts, 4 requests in flight on the
// file's own DC, written in place into a preallocated .part file. Playback doesn't wait for the end:
// a reader asks for the part it needs and that part jumps the queue (start, seek, mp4 index at the end).
import fs from 'node:fs'
import { Api, type TelegramClient } from 'telegram'
import bigInt from 'big-integer'

export const PART = 512 * 1024
const WORKERS = 4

type Locate = () => Promise<{ location: Api.TypeInputFileLocation; dcId: number }>

export class TgFile {
  readonly parts: number
  readonly done: Uint8Array
  private inflight = new Set<number>()
  private waiters = new Map<number, (() => void)[]>()
  private head = 0
  private fd: number
  private loc?: { location: Api.TypeInputFileLocation; dcId: number }
  private failed?: Error
  private resolveDone!: (file: string) => void
  private rejectDone!: (e: Error) => void
  readonly complete: Promise<string>
  private left: number

  constructor(
    private client: TelegramClient,
    private locate: Locate,
    readonly size: number,
    readonly file: string
  ) {
    this.parts = Math.max(1, Math.ceil(size / PART))
    this.done = new Uint8Array(this.parts)
    this.left = this.parts
    this.fd = fs.openSync(file + '.part', 'w+')
    fs.ftruncateSync(this.fd, size)
    this.complete = new Promise((res, rej) => {
      this.resolveDone = res
      this.rejectDone = rej
    })
    this.complete.catch(() => {})
    for (let i = 0; i < WORKERS; i++) void this.worker()
  }

  private next(): number {
    for (let i = this.head; i < this.parts; i++) if (!this.done[i] && !this.inflight.has(i)) return i
    for (let i = 0; i < this.head; i++) if (!this.done[i] && !this.inflight.has(i)) return i
    return -1
  }

  private async fetchPart(i: number, retry = 0): Promise<Buffer> {
    this.loc ??= await this.locate()
    const sender = await this.client.getSender(this.loc.dcId)
    try {
      const res = (await this.client.invokeWithSender(
        new Api.upload.GetFile({ location: this.loc.location, offset: bigInt(i * PART), limit: PART, precise: false, cdnSupported: false }),
        sender
      )) as Api.upload.File
      return Buffer.from(res.bytes)
    } catch (err: any) {
      const msg = String(err?.errorMessage ?? err?.message ?? err)
      if (retry < 3) {
        // expired file reference: ask Telegram for the message again (fresh reference) and retry
        if (/FILE_REFERENCE/.test(msg)) this.loc = undefined
        else if (err?.newDc) this.loc = { ...this.loc!, dcId: err.newDc }
        else await new Promise((r) => setTimeout(r, 600 * (retry + 1)))
        return this.fetchPart(i, retry + 1)
      }
      throw err
    }
  }

  private async worker() {
    for (;;) {
      if (this.failed) return
      const i = this.next()
      if (i < 0) return
      this.inflight.add(i)
      try {
        const bytes = await this.fetchPart(i)
        const len = Math.min(bytes.length, this.size - i * PART)
        if (len > 0) fs.writeSync(this.fd, bytes, 0, len, i * PART)
        this.done[i] = 1
        this.left--
        for (const w of this.waiters.get(i) ?? []) w()
        this.waiters.delete(i)
        if (this.left === 0) this.finish()
      } catch (err) {
        this.fail(err as Error)
        return
      } finally {
        this.inflight.delete(i)
      }
    }
  }

  private finish() {
    try {
      fs.closeSync(this.fd)
      fs.renameSync(this.file + '.part', this.file)
      this.resolveDone(this.file)
    } catch (err) {
      this.rejectDone(err as Error)
    }
  }

  private fail(err: Error) {
    if (this.failed) return
    this.failed = err
    for (const list of this.waiters.values()) for (const w of list) w()
    this.waiters.clear()
    try {
      fs.closeSync(this.fd)
    } catch {}
    fs.rmSync(this.file + '.part', { force: true })
    this.rejectDone(err)
  }

  /** resolves once part i is on disk; that part (and the ones after it) are fetched next */
  async waitPart(i: number) {
    if (this.done[i]) return
    if (this.failed) throw this.failed
    this.head = i
    await new Promise<void>((r) => {
      const l = this.waiters.get(i) ?? []
      l.push(r)
      this.waiters.set(i, l)
    })
    if (this.failed) throw this.failed
  }

  /** bytes start..end (inclusive) as they arrive: playback starts with the first part */
  stream(start: number, end: number): ReadableStream<Uint8Array> {
    let pos = start
    let cancelled = false
    return new ReadableStream<Uint8Array>({
      pull: async (ctrl) => {
        if (cancelled) return
        if (pos > end) return ctrl.close()
        const i = Math.floor(pos / PART)
        try {
          await this.waitPart(i)
        } catch (err) {
          return ctrl.error(err)
        }
        const stop = Math.min(end + 1, (i + 1) * PART, this.size)
        const n = stop - pos
        const buf = Buffer.allocUnsafe(n)
        // the .part handle is still open while downloading; once complete, read the final file
        const fd = this.left === 0 ? fs.openSync(this.file, 'r') : this.fd
        try {
          fs.readSync(fd, buf, 0, n, pos)
        } finally {
          if (fd !== this.fd) fs.closeSync(fd)
        }
        pos = stop
        ctrl.enqueue(new Uint8Array(buf.buffer, buf.byteOffset, n))
      },
      cancel: () => {
        cancelled = true
      }
    })
  }
}
