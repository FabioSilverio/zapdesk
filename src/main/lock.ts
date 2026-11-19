import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import type { AppMeta } from './accounts'

type Store = { meta: AppMeta; markMeta(): void; flush(): void }

/** PIN hashing + idle auto-lock. The lock state lives here (main), so reloading the renderer can't skip it. */
export class LockManager {
  locked = false
  private lastActivity = Date.now()
  private failures = 0
  private blockedUntil = 0
  private timer: NodeJS.Timeout

  constructor(
    private store: Store,
    private onChange: (locked: boolean) => void
  ) {
    this.locked = this.hasPin()
    this.timer = setInterval(() => this.tick(), 5000)
  }

  hasPin() {
    return !!this.store.meta.pinHash
  }

  pinLength() {
    return this.store.meta.pinLength ?? 0
  }

  activity() {
    this.lastActivity = Date.now()
  }

  private tick() {
    const mins = this.store.meta.settings.lockMinutes
    if (this.locked || !this.hasPin() || !mins) return
    if (Date.now() - this.lastActivity > mins * 60_000) this.lock()
  }

  lock() {
    if (!this.hasPin() || this.locked) return
    this.locked = true
    this.onChange(true)
  }

  setPin(pin: string): boolean {
    if (!/^(\d{4}|\d{6})$/.test(pin)) return false
    // changing an existing PIN requires being unlocked
    if (this.locked) return false
    const salt = randomBytes(16)
    this.store.meta.pinSalt = salt.toString('base64')
    this.store.meta.pinHash = scryptSync(pin, salt, 32).toString('base64')
    this.store.meta.pinLength = pin.length
    this.store.markMeta()
    this.store.flush()
    this.activity()
    return true
  }

  unlock(pin: string): { ok: boolean; waitMs?: number } {
    const now = Date.now()
    if (now < this.blockedUntil) return { ok: false, waitMs: this.blockedUntil - now }
    const { pinHash, pinSalt } = this.store.meta
    if (!pinHash || !pinSalt) {
      this.locked = false
      this.onChange(false)
      return { ok: true }
    }
    const got = scryptSync(pin, Buffer.from(pinSalt, 'base64'), 32)
    const want = Buffer.from(pinHash, 'base64')
    if (got.length === want.length && timingSafeEqual(got, want)) {
      this.failures = 0
      this.locked = false
      this.activity()
      this.onChange(false)
      return { ok: true }
    }
    this.failures++
    if (this.failures >= 5) {
      const wait = Math.min(5 * 60_000, 30_000 * 2 ** (this.failures - 5))
      this.blockedUntil = now + wait
      return { ok: false, waitMs: wait }
    }
    return { ok: false }
  }

  clearPin() {
    delete this.store.meta.pinHash
    delete this.store.meta.pinSalt
    delete this.store.meta.pinLength
    this.store.markMeta()
    this.locked = false
    this.onChange(false)
  }

  dispose() {
    clearInterval(this.timer)
  }
}
