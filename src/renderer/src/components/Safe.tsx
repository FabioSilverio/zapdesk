import { Component, type ErrorInfo, type ReactNode } from 'react'
import { zap } from '../state'

/**
 * Contains render errors: a weird message (or any panel) that throws shows a small placeholder
 * instead of blanking the whole app. `resetKey` changing (e.g. another chat) clears the error.
 */
export class Safe extends Component<{ children: ReactNode; fallback?: ReactNode; resetKey?: unknown; name: string; autoRetryMs?: number }, { failed: boolean }> {
  state = { failed: false }
  private retry?: ReturnType<typeof setTimeout>

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    zap.log(`[${this.props.name}] ${error?.stack ?? error}\n${info.componentStack ?? ''}`)
    if (this.props.autoRetryMs) this.retry = setTimeout(() => this.setState({ failed: false }), this.props.autoRetryMs)
  }

  componentDidUpdate(prev: { resetKey?: unknown }) {
    if (this.state.failed && prev.resetKey !== this.props.resetKey) this.setState({ failed: false })
  }

  componentWillUnmount() {
    clearTimeout(this.retry)
  }

  render() {
    if (this.state.failed) return this.props.fallback ?? null
    return this.props.children
  }
}

/** last line of defence: the whole UI failed → reload the page (main keeps all state) */
export class AppSafe extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    zap.log(`[app] ${error?.stack ?? error}\n${info.componentStack ?? ''}`)
    const n = Number(sessionStorage.getItem('zap-reloads') ?? 0)
    // avoid a reload loop: after 3 quick failures, stay on the recovery screen
    if (n < 3) {
      sessionStorage.setItem('zap-reloads', String(n + 1))
      setTimeout(() => location.reload(), 1200)
    }
  }
  render() {
    if (this.state.failed)
      return (
        <div className="recover">
          <div className="empty-logo" />
          <h2>Recuperando o Zapdesk…</h2>
          <p>Algo deu errado na tela. Suas conversas estão salvas.</p>
          <button className="btn primary" onClick={() => location.reload()}>
            Recarregar agora
          </button>
        </div>
      )
    return this.props.children
  }
}
