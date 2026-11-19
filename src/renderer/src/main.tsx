import { createRoot } from 'react-dom/client'
import './styles.css'
import { App } from './App'
import { AppSafe } from './components/Safe'

// anything that slips past React still ends up in the log file, never as a silent freeze
window.addEventListener('error', (e) => window.zap?.log(`[window] ${e.message} @ ${e.filename}:${e.lineno}`))
window.addEventListener('unhandledrejection', (e) => window.zap?.log(`[promise] ${(e.reason as Error)?.stack ?? e.reason}`))
// a page that stayed up for a minute is healthy again: reset the reload-loop guard
setTimeout(() => sessionStorage.removeItem('zap-reloads'), 60_000)

createRoot(document.getElementById('root')!).render(
  <AppSafe>
    <App />
  </AppSafe>
)
