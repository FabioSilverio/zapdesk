import { fontStack } from './fonts'
import type { Appearance, ThemeId } from '@shared/types'
import { zap } from './state'

interface Theme {
  id: ThemeId
  name: string
  scheme: 'dark' | 'light'
  accent: string
  /** how much accent tints the outgoing bubble */
  outMix: number
  tokens: Record<string, string>
  swatches: { name: string; color: string }[]
}

const BASIC_SWATCHES = [
  { name: 'Esmeralda', color: '#2fd38a' },
  { name: 'WhatsApp', color: '#25d366' },
  { name: 'Azul', color: '#4c8dff' },
  { name: 'Roxo', color: '#a77bff' },
  { name: 'Rosa', color: '#ff5fa2' },
  { name: 'Vermelho', color: '#ff5c5c' },
  { name: 'Laranja', color: '#ff8a3d' },
  { name: 'Amarelo', color: '#f5c242' },
  { name: 'Ciano', color: '#2ac3de' }
]

const MOCHA = { rosewater: '#f5e0dc', flamingo: '#f2cdcd', pink: '#f5c2e7', mauve: '#cba6f7', red: '#f38ba8', maroon: '#eba0ac', peach: '#fab387', yellow: '#f9e2af', green: '#a6e3a1', teal: '#94e2d5', sky: '#89dceb', sapphire: '#74c7ec', blue: '#89b4fa', lavender: '#b4befe' }
const LATTE = { rosewater: '#dc8a78', flamingo: '#dd7878', pink: '#ea76cb', mauve: '#8839ef', red: '#d20f39', maroon: '#e64553', peach: '#fe640b', yellow: '#df8e1d', green: '#40a02b', teal: '#179299', sky: '#04a5e5', sapphire: '#209fb5', blue: '#1e66f5', lavender: '#7287fd' }
const ctpSwatches = (p: Record<string, string>) => Object.entries(p).map(([name, color]) => ({ name: name[0].toUpperCase() + name.slice(1), color }))

export const THEMES: Theme[] = [
  {
    id: 'verde',
    name: 'Verde escuro',
    scheme: 'dark',
    accent: '#2fd38a',
    outMix: 26,
    swatches: BASIC_SWATCHES,
    tokens: {
      bg: '#0f1a16',
      'bg-side': '#0b1411',
      'bg-elev': '#15241e',
      'bg-hover': '#16261f',
      'bg-active': '#1c3027',
      line: 'rgba(160, 220, 190, 0.08)',
      text: '#e2eee8',
      'text-2': '#8fa89c',
      'text-3': '#5d7469',
      'bubble-in': '#17271f',
      danger: '#ff6b6b'
    }
  },
  {
    id: 'grafite',
    name: 'Grafite',
    scheme: 'dark',
    accent: '#25d366',
    outMix: 16,
    swatches: BASIC_SWATCHES,
    tokens: {
      bg: '#1b1b1b',
      'bg-side': '#151515',
      'bg-elev': '#242424',
      'bg-hover': '#222222',
      'bg-active': '#2b2b2b',
      line: 'rgba(255, 255, 255, 0.07)',
      text: '#ececec',
      'text-2': '#a0a0a0',
      'text-3': '#6a6a6a',
      'bubble-in': '#2a2a2a',
      danger: '#ff6b6b'
    }
  },
  {
    id: 'mocha',
    name: 'Catppuccin Mocha',
    scheme: 'dark',
    accent: MOCHA.mauve,
    outMix: 24,
    swatches: ctpSwatches(MOCHA),
    tokens: {
      bg: '#1e1e2e',
      'bg-side': '#181825',
      'bg-elev': '#262637',
      'bg-hover': '#262637',
      'bg-active': '#313244',
      line: 'rgba(205, 214, 244, 0.08)',
      text: '#cdd6f4',
      'text-2': '#a6adc8',
      'text-3': '#6c7086',
      'bubble-in': '#313244',
      danger: MOCHA.red
    }
  },
  {
    id: 'latte',
    name: 'Catppuccin Latte',
    scheme: 'light',
    accent: LATTE.mauve,
    outMix: 16,
    swatches: ctpSwatches(LATTE),
    tokens: {
      bg: '#eff1f5',
      'bg-side': '#e6e9ef',
      'bg-elev': '#ffffff',
      'bg-hover': '#dce0e8',
      'bg-active': '#ccd0da',
      line: 'rgba(76, 79, 105, 0.12)',
      text: '#4c4f69',
      'text-2': '#6c6f85',
      'text-3': '#9ca0b0',
      'bubble-in': '#ffffff',
      danger: LATTE.red
    }
  },
  {
    id: 'claro',
    name: 'Claro',
    scheme: 'light',
    accent: '#14a861',
    outMix: 14,
    swatches: BASIC_SWATCHES,
    tokens: {
      bg: '#f4f5f2',
      'bg-side': '#ebede8',
      'bg-elev': '#ffffff',
      'bg-hover': '#e2e5df',
      'bg-active': '#d8dcd4',
      line: 'rgba(20, 40, 30, 0.1)',
      text: '#18201c',
      'text-2': '#5b665f',
      'text-3': '#929c95',
      'bubble-in': '#ffffff',
      danger: '#d93636'
    }
  }
]

export const themeOf = (id: ThemeId) => THEMES.find((t) => t.id === id) ?? THEMES[0]

function readableOn(hex: string) {
  const n = parseInt(hex.replace('#', '').slice(0, 6), 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return lum > 0.38 ? '#0b0f0d' : '#ffffff'
}

let lastChrome = ''
export function applyAppearance(a: Appearance) {
  const t = themeOf(a.theme)
  const accent = a.accent ?? t.accent
  const root = document.documentElement
  for (const [k, v] of Object.entries(t.tokens)) root.style.setProperty('--' + k, v)
  root.style.setProperty('--accent', accent)
  root.style.setProperty('--accent-text', readableOn(accent))
  root.style.setProperty('--out-mix', t.outMix + '%')
  root.style.setProperty('--font', fontStack(a))
  root.style.setProperty('--font-size', a.fontSize + 'px')
  root.style.setProperty('--sidebar-w', a.sidebarWidth + 'px')
  root.style.colorScheme = t.scheme
  root.dataset.scheme = t.scheme
  root.dataset.theme = t.id
  root.dataset.density = a.density
  root.dataset.messages = a.messages
  root.dataset.pinned = a.pinned
  root.dataset.radius = a.radius
  root.dataset.glass = a.glass !== false ? '1' : ''
  const chrome = t.tokens['bg-side'] + t.tokens['text-2'] + (a.glass !== false) + t.scheme
  if (chrome !== lastChrome) {
    lastChrome = chrome
    zap.setChrome(t.tokens['bg-side'], t.tokens['text-2'], a.glass !== false, t.scheme)
  }
}
