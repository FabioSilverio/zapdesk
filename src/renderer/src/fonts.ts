// The app's text font. SF Pro is Apple's and can't be redistributed, so it isn't in the public repo:
// it's bundled only when the .otf files are present in assets/fonts (local builds). Everyone else picks
// on first launch: Windows' own Segoe UI Variable, Inter (free, bundled), SF Pro if installed, or any font file.
import interLatin from '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url'
import interLatinExt from '@fontsource-variable/inter/files/inter-latin-ext-wght-normal.woff2?url'
import type { Appearance, FontId } from '@shared/types'

const sfFiles = import.meta.glob('./assets/fonts/sf-pro-display-*.otf', { eager: true, query: '?url', import: 'default' }) as Record<string, string>
export const sfBundled = Object.keys(sfFiles).length > 0

const FALLBACK = "'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif"
const STACK: Record<FontId, string> = {
  sf: `'SF Pro Display', 'SF Pro Text', 'SF Pro', ${FALLBACK}`,
  segoe: FALLBACK,
  inter: `'Inter Variable', ${FALLBACK}`,
  custom: `'Zapdesk Custom', ${FALLBACK}`
}

let loaded = false
/** registers the bundled faces once (they only download/decode when actually used) */
export function loadFonts() {
  if (loaded) return
  loaded = true
  const add = (f: FontFace) => {
    try {
      document.fonts.add(f)
    } catch {}
  }
  for (const [file, url] of Object.entries(sfFiles)) {
    const m = /sf-pro-display-(\d+)(-italic)?\.otf$/.exec(file)
    if (!m) continue
    add(new FontFace('SF Pro Display', `url("${url}") format("opentype")`, { weight: m[1], style: m[2] ? 'italic' : 'normal', display: 'swap' }))
  }
  add(new FontFace('Inter Variable', `url("${interLatin}") format("woff2")`, { weight: '100 900', display: 'swap', unicodeRange: 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD' }))
  add(new FontFace('Inter Variable', `url("${interLatinExt}") format("woff2")`, { weight: '100 900', display: 'swap', unicodeRange: 'U+0100-024F, U+0259, U+1E00-1EFF, U+2020, U+20A0-20AB, U+20AD-20CF, U+2113, U+2C60-2C7F, U+A720-A7FF' }))
}

let customKey = ''
/** the font file you picked (kept by main, served as zap://font/custom) */
function loadCustom(a: Appearance) {
  const key = a.customFont ?? ''
  if (!key || key === customKey) return
  customKey = key
  for (const f of [...document.fonts]) if (f.family.replace(/"/g, '') === 'Zapdesk Custom') document.fonts.delete(f)
  const face = new FontFace('Zapdesk Custom', `url("zap://font/custom?v=${encodeURIComponent(key)}")`, { display: 'swap' })
  document.fonts.add(face)
  face.load().catch(() => {})
}

/** is this font installed in Windows? (wider/narrower than the fallback = it exists) */
export function installed(family: string) {
  const c = document.createElement('canvas').getContext('2d')!
  const probe = 'mmmmmmmmmmlliWWW@#0123'
  c.font = '32px monospace'
  const base = c.measureText(probe).width
  c.font = `32px '${family}', monospace`
  return c.measureText(probe).width !== base
}

export const sfAvailable = () => sfBundled || installed('SF Pro Display') || installed('SF Pro Text') || installed('SF Pro')

export function fontStack(a: Appearance) {
  loadFonts()
  const id: FontId = a.font ?? (sfBundled ? 'sf' : 'segoe')
  if (id === 'custom') loadCustom(a)
  return STACK[id] ?? FALLBACK
}

export const FONT_CHOICES: { id: FontId; label: string; hint: string }[] = [
  { id: 'segoe', label: 'Segoe UI', hint: 'A do Windows 11' },
  { id: 'inter', label: 'Inter', hint: 'Moderna, gratuita, vem com o app' },
  { id: 'sf', label: 'SF Pro', hint: 'A da Apple (precisa estar instalada)' },
  { id: 'custom', label: 'Outra…', hint: 'Escolher um arquivo .ttf / .otf' }
]
export const stackOf = (id: FontId) => STACK[id]
