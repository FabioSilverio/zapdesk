import { createRoot } from 'react-dom/client'
performance.mark('js-start')
import './styles.css'
import { App } from './App'
import { AppSafe } from './components/Safe'

// anything that slips past React still ends up in the log file, never as a silent freeze
window.addEventListener('error', (e) => window.zap?.log(`[window] ${e.message} @ ${e.filename}:${e.lineno}`))
window.addEventListener('unhandledrejection', (e) => window.zap?.log(`[promise] ${(e.reason as Error)?.stack ?? e.reason}`))
// a page that stayed up for a minute is healthy again: reset the reload-loop guard
setTimeout(() => sessionStorage.removeItem('zap-reloads'), 60_000)
// frames that froze the screen (>150 ms) are reported to main and summed in the perf log
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (e.duration > 150) window.zap?.stall(Math.round(e.duration))
      ;((window as any).__longTasks ??= []).push(Math.round(e.startTime) + '+' + Math.round(e.duration))
    }
  }).observe({ type: 'longtask', buffered: true })
} catch {}

createRoot(document.getElementById('root')!).render(
  <AppSafe>
    <App />
  </AppSafe>
)
