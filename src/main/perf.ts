// Performance diagnostics that travel with the app: on a PC we can't look at, zapdesk.log says what that
// machine is (CPU, RAM, GPU, disk) and where it stalled (main process blocks, slow renderer frames).
import { app } from 'electron'
import os from 'node:os'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'

type Log = (where: string, msg: unknown) => void

const loop = monitorEventLoopDelay({ resolution: 20 })
loop.enable()

/** what the main process was doing when it stalled (store writes, history sync…) */
const recent: { at: number; what: string; ms: number }[] = []
export function timed<T>(what: string, fn: () => T): T {
  const t = performance.now()
  try {
    return fn()
  } finally {
    const ms = performance.now() - t
    if (ms >= 40) {
      recent.push({ at: Date.now(), what, ms: Math.round(ms) })
      if (recent.length > 60) recent.shift()
    }
  }
}

export function systemInfo() {
  const cpus = os.cpus()
  return {
    app: app.getVersion(),
    electron: process.versions.electron,
    windows: os.release(),
    cpu: (cpus[0]?.model ?? '?').replace(/\s+/g, ' ').trim(),
    cores: cpus.length,
    ramGB: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    freeRamGB: Math.round((os.freemem() / 1024 ** 3) * 10) / 10,
    gpu: app.getGPUFeatureStatus(),
    uptimeMin: Math.round(process.uptime() / 60)
  }
}

/** a slow machine: few cores, little RAM or no GPU acceleration → the app turns its heavy effects down */
export function isLowEnd(withGpu = true) {
  const s = systemInfo()
  const gpu = s.gpu as unknown as Record<string, string>
  // right after launch Chromium still reports "software" for everything: only trust it once the GPU is up
  const noGpu = withGpu && (/disabled|software|unavailable/i.test(gpu.gpu_compositing ?? '') || /disabled|software|unavailable/i.test(gpu.rasterization ?? ''))
  return s.cores <= 4 || s.ramGB < 7.5 || noGpu
}

let renderer = { longTasks: 0, longMs: 0, worst: 0 }
export function rendererStall(ms: number) {
  renderer.longTasks++
  renderer.longMs += ms
  renderer.worst = Math.max(renderer.worst, ms)
}

export function perfSnapshot() {
  const mem = process.memoryUsage()
  return {
    mainLoop: { p99: Math.round(loop.percentile(99) / 1e6), max: Math.round(loop.max / 1e6), mean: Math.round(loop.mean / 1e6) },
    renderer: { ...renderer, longMs: Math.round(renderer.longMs) },
    mainHeapMB: Math.round(mem.heapUsed / 1024 ** 2),
    mainRssMB: Math.round(mem.rss / 1024 ** 2),
    slowOps: recent.slice(-12).map((r) => `${r.what} ${r.ms}ms`)
  }
}

/** startup line + a summary every 10 min (only when something was slow), so the log stays small */
export function startPerfLog(log: Log, extra: () => Record<string, unknown>) {
  log('perf', 'system ' + JSON.stringify({ ...systemInfo(), lowEnd: isLowEnd(), ...extra() }))
  setInterval(() => {
    const s = perfSnapshot()
    if (s.mainLoop.max > 250 || s.renderer.worst > 300 || s.slowOps.length) log('perf', JSON.stringify({ ...s, ...extra() }))
    loop.reset()
    renderer = { longTasks: 0, longMs: 0, worst: 0 }
    recent.length = 0
  }, 10 * 60_000).unref()
}
