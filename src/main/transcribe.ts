// Voice-note transcription, fully on this PC: whisper.cpp (CPU) + the multilingual "small" model.
// Downloaded once on demand (~200 MB) into userData/whisper. The renderer decodes the opus audio to
// 16 kHz mono PCM (Chromium has the decoder), we wrap it in a WAV and run whisper-cli at low priority.
import { app, net } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import type { WhisperState } from '@shared/types'

const BIN_URL = 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip'
// dev tests can point it at a local copy (file://) instead of downloading 190 MB again
const MODEL_URL = process.env.ZAP_WHISPER_MODEL_URL || 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin'
const MODEL_SIZE = 190085487
const BIN_FILES = ['whisper-cli.exe', 'whisper.dll', 'ggml.dll', 'ggml-base.dll', 'ggml-cpu-*.dll']

export class Transcriber {
  readonly dir = path.join(app.getPath('userData'), 'whisper')
  private cli = path.join(this.dir, 'Release', 'whisper-cli.exe')
  private model = path.join(this.dir, 'ggml-small-q5_1.bin')
  private progress: number | null = null
  private error?: string
  private abort?: AbortController

  constructor(private onState: (s: WhisperState) => void) {}

  ready() {
    try {
      return fs.existsSync(this.cli) && fs.statSync(this.model).size === MODEL_SIZE
    } catch {
      return false
    }
  }

  state(): WhisperState {
    return { ready: this.ready(), progress: this.progress, error: this.error }
  }

  private emit() {
    this.onState(this.state())
  }

  private async download(url: string, dest: string, onBytes: (n: number) => void) {
    const res = await net.fetch(url, { signal: this.abort?.signal })
    if (!res.ok || !res.body) throw new Error('download falhou (' + res.status + ')')
    const part = dest + '.part'
    const out = fs.createWriteStream(part)
    const reader = res.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()))
        onBytes(value.byteLength)
      }
      await new Promise<void>((r, j) => out.end((e?: Error | null) => (e ? j(e) : r())))
    } catch (err) {
      out.destroy()
      fs.rmSync(part, { force: true })
      throw err
    }
    fs.renameSync(part, dest)
  }

  /** one-time download of the engine + model, with progress events */
  async install() {
    if (this.ready()) return this.emit()
    if (this.progress !== null) return
    this.error = undefined
    this.progress = 0
    this.abort = new AbortController()
    this.emit()
    let got = 0
    let lastEmit = 0
    const total = MODEL_SIZE + 9_000_000
    const tick = (n: number) => {
      got += n
      const now = Date.now()
      if (now - lastEmit > 250) {
        lastEmit = now
        this.progress = Math.min(99, Math.round((got / total) * 100))
        this.emit()
      }
    }
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      if (!fs.existsSync(this.cli)) {
        const zip = path.join(this.dir, 'bin.zip')
        await this.download(BIN_URL, zip, tick)
        // Windows' own bsdtar reads zip; only the files the CLI needs
        const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
        await new Promise<void>((r, j) =>
          execFile(tar, ['-xf', zip, '-C', this.dir, ...BIN_FILES.map((f) => 'Release/' + f)], { windowsHide: true }, (e) => (e ? j(e) : r()))
        )
        fs.rmSync(zip, { force: true })
        if (!fs.existsSync(this.cli)) throw new Error('motor não veio no pacote')
      } else got += 9_000_000
      if (!this.ready()) await this.download(MODEL_URL, this.model, tick)
      if (!this.ready()) throw new Error('modelo incompleto')
    } catch (err) {
      this.error = this.abort?.signal.aborted ? undefined : String((err as Error)?.message ?? err)
    } finally {
      this.progress = null
      this.abort = undefined
      this.emit()
    }
  }

  cancel() {
    this.abort?.abort()
  }

  remove() {
    this.cancel()
    // nothing may keep running from the folder being deleted (Windows refuses to delete a running .exe)
    for (const j of this.jobs.splice(0)) j.reject(new Error('Transcrição removida'))
    this.running?.child?.kill()
    fs.rmSync(this.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    this.emit()
  }

  /** you clicked one while an automatic one runs: pause that one (it starts over right after) */
  private preemptForUrgent() {
    const r = this.running
    if (r && !r.urgent && r.child) {
      r.preempted = true
      r.child.kill()
    }
  }

  /**
   * pcm = Int16 mono 16 kHz. One at a time, so a pile of voice notes never hogs the CPU.
   * urgent (you clicked it) jumps ahead of the automatic ones. onPartial gets the text so far
   * (whisper finishes a 30 s window at a time, so long audios fill in while you read).
   */
  transcribe(key: string, pcm: ArrayBuffer, opts: { urgent?: boolean; lang?: string; onPartial?: (text: string) => void } = {}): Promise<string> {
    const same = this.jobs.find((j) => j.key === key)
    if (same) {
      if (opts.urgent && !same.urgent) {
        // already waiting as an automatic one: move it up
        same.urgent = true
        this.jobs.splice(this.jobs.indexOf(same), 1)
        this.enqueue(same)
        this.preemptForUrgent()
      }
      if (opts.onPartial) same.onPartial = opts.onPartial
      return same.promise
    }
    const r = this.running
    if (r?.key === key) {
      // the one you clicked is already running in the background: give it full speed
      if (opts.urgent && !r.urgent) {
        r.urgent = true
        try {
          if (r.child?.pid) os.setPriority(r.child.pid, os.constants.priority.PRIORITY_NORMAL)
        } catch {}
      }
      if (opts.onPartial) r.onPartial = opts.onPartial
      return r.promise
    }
    let resolve!: (t: string) => void
    let reject!: (e: Error) => void
    const promise = new Promise<string>((res, rej) => {
      resolve = res
      reject = rej
    })
    this.enqueue({ key, pcm: Buffer.from(pcm), lang: opts.lang ?? 'pt', urgent: !!opts.urgent, onPartial: opts.onPartial, promise, resolve, reject })
    if (opts.urgent) this.preemptForUrgent()
    void this.pump()
    return promise
  }

  private jobs: Job[] = []
  private running?: Job

  private enqueue(job: Job) {
    // urgent: after the other urgent ones, before every automatic one
    const at = job.urgent ? this.jobs.findIndex((j) => !j.urgent) : -1
    if (at < 0) this.jobs.push(job)
    else this.jobs.splice(at, 0, job)
  }

  private async pump() {
    if (this.running) return
    const job = this.jobs.shift()
    if (!job) return
    this.running = job
    try {
      job.resolve(await this.run(job))
    } catch (err) {
      if (job.preempted) {
        job.preempted = false
        job.child = undefined
        // first in line among the automatic ones, behind what you clicked
        const at = this.jobs.findIndex((j) => !j.urgent)
        if (at < 0) this.jobs.push(job)
        else this.jobs.splice(at, 0, job)
      } else job.reject(err as Error)
    } finally {
      this.running = undefined
      void this.pump()
    }
  }

  private run(job: Job): Promise<string> {
    const { pcm, lang } = job
    if (!this.ready()) return Promise.reject(new Error('Transcrição não instalada'))
    if (pcm.length < 3200) return Promise.resolve('')
    const wav = path.join(os.tmpdir(), `zapdesk-tr-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`)
    fs.writeFileSync(wav, Buffer.concat([wavHeader(pcm.length), pcm]))
    const seconds = pcm.length / 32000
    const threads = String(Math.max(2, Math.min(10, os.cpus().length - 2)))
    const args = ['-m', this.model, '-f', wav, '-l', lang, '-nt', '-np', '-t', threads]
    // greedy decoding: ~25% faster than the 5-beam default, same text on voice notes
    args.push('-bs', '1', '-bo', '1')
    // the encoder always chews a full 30 s window; for a short note tell it how much is really there
    // (1 s of slack). 6 s note: 4.6 s → 1.3 s. Longer audio keeps the full window.
    if (seconds <= 29) args.push('-ac', String(Math.min(1500, Math.ceil(seconds * 50) + 50)))
    return new Promise<string>((resolve, reject) => {
      const child = spawn(this.cli, args, { windowsHide: true, cwd: path.dirname(this.cli) })
      job.child = child
      // clicked: full speed. automatic: below normal, so the chat stays smooth while it works
      if (!job.urgent)
        try {
          os.setPriority(child.pid!, os.constants.priority.PRIORITY_BELOW_NORMAL)
        } catch {
          /* ignore */
        }
      const out: Buffer[] = []
      child.stdout.on('data', (d: Buffer) => {
        out.push(d)
        if (job.onPartial && seconds > 29) {
          const t = cleanText(Buffer.concat(out).toString('utf8'))
          if (t) job.onPartial(t)
        }
      })
      child.stderr.on('data', () => {})
      const timer = setTimeout(() => child.kill(), Math.max(90_000, seconds * 8000))
      const done = (err?: Error) => {
        clearTimeout(timer)
        fs.rm(wav, { force: true }, () => {})
        if (err) return reject(err)
        resolve(cleanText(Buffer.concat(out).toString('utf8')))
      }
      child.on('error', (e) => done(e))
      child.on('close', (code) => (code === 0 ? done() : done(new Error('A transcrição falhou (código ' + code + ')'))))
    })
  }
}

type Job = {
  key: string
  pcm: Buffer
  lang: string
  urgent: boolean
  onPartial?: (text: string) => void
  child?: ChildProcess
  /** stopped to let a clicked one go first; goes back in the queue */
  preempted?: boolean
  promise: Promise<string>
  resolve: (t: string) => void
  reject: (e: Error) => void
}

function cleanText(s: string) {
  return s
    .split(/\r?\n/)
    .map((l) => l.trim())
    // whisper tags non-speech as a whole line in brackets: [BLANK_AUDIO], [MÚSICA DE FUNDO], (risos)…
    .filter((l) => l && !/^(\[[^\]]*\]|\([^)]*\))$/.test(l))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function wavHeader(dataLen: number) {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + dataLen, 4)
  h.write('WAVE', 8)
  h.write('fmt ', 12)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20) // PCM
  h.writeUInt16LE(1, 22) // mono
  h.writeUInt32LE(16000, 24)
  h.writeUInt32LE(32000, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(dataLen, 40)
  return h
}
