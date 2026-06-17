import { Capacitor } from '@capacitor/core'
import { StatusBar, Style } from '@capacitor/status-bar'

// Read --page-bg CSS variable and apply to status bar so the bar
// chameleon-matches whatever the current page's background is.
// Different routes may set different page bg; rgb()/hex/etc supported.

const cssToHex = (css: string): string => {
  if (/^#[0-9a-f]{6}$/i.test(css)) return css.toLowerCase()
  if (/^#[0-9a-f]{3}$/i.test(css)) {
    const r = css[1], g = css[2], b = css[3]
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase()
  }
  const m = css.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
  if (m) {
    const toHex = (n: string) => Number(n).toString(16).padStart(2, '0')
    return `#${toHex(m[1])}${toHex(m[2])}${toHex(m[3])}`
  }
  return '#EFF6FF' // fallback to app's nominal bg
}

// Pick dark icons for light backgrounds and vice versa.
const pickStyle = (hex: string): Style => {
  const n = parseInt(hex.slice(1), 16)
  const r = (n >> 16) & 0xff
  const g = (n >> 8) & 0xff
  const b = n & 0xff
  // Relative luminance, sRGB approximation
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return lum > 0.6 ? Style.Dark : Style.Light
}

// Toggle the Android status bar between "overlay" (transparent, WebView
// draws edge-to-edge behind it) and "inset" (its own solid-color band at
// the top). Home page uses overlay so the full-bleed background image
// reaches the very top of the screen; every other page keeps a solid bar
// that matches its header. Headers carry padding-top: env(safe-area-inset-top)
// so their content never hides under the notification icons in overlay mode.
export const setStatusBarOverlay = (overlay: boolean) => {
  if (Capacitor.getPlatform() !== 'android') return
  requestAnimationFrame(() => {
    try {
      void StatusBar.setOverlaysWebView({ overlay })
      if (overlay) {
        // Fully transparent so the background image shows through.
        void StatusBar.setBackgroundColor({ color: '#00000000' })
        // Home bg is light → dark icons stay legible.
        void StatusBar.setStyle({ style: Style.Dark })
      }
    } catch {
      // Best effort.
    }
  })
}

export const syncStatusBarToColor = (color: string) => {
  if (Capacitor.getPlatform() !== 'android') return
  requestAnimationFrame(() => {
    try {
      const hex = cssToHex(color)
      void StatusBar.setBackgroundColor({ color: hex })
      void StatusBar.setStyle({ style: pickStyle(hex) })
    } catch {
      // Best effort.
    }
  })
}

// Use this on the chat route so the status bar matches the chat header (--accent)
// instead of --page-bg, keeping them visually unified.
export const syncStatusBarToAccent = () => {
  if (Capacitor.getPlatform() !== 'android') return
  if (typeof window === 'undefined' || typeof document === 'undefined') return
  requestAnimationFrame(() => {
    try {
      const raw =
        getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() ||
        '#DBEAFE'
      const hex = cssToHex(raw)
      void StatusBar.setBackgroundColor({ color: hex })
      void StatusBar.setStyle({ style: pickStyle(hex) })
    } catch {
      // Best effort.
    }
  })
}

export const syncStatusBarToPage = () => {
  if (Capacitor.getPlatform() !== 'android') return
  if (typeof window === 'undefined' || typeof document === 'undefined') return
  // Defer to next frame so route-driven CSS variables have settled.
  requestAnimationFrame(() => {
    try {
      const root = document.documentElement
      const raw =
        getComputedStyle(root).getPropertyValue('--page-bg').trim() ||
        getComputedStyle(document.body).backgroundColor ||
        '#EFF6FF'
      // --page-bg might be a linear-gradient(); for those just sample the
      // first color stop.
      const firstColor = raw.match(/#[0-9a-f]{3,6}|rgba?\([^)]+\)/i)?.[0] ?? raw
      const hex = cssToHex(firstColor)
      void StatusBar.setBackgroundColor({ color: hex })
      void StatusBar.setStyle({ style: pickStyle(hex) })
    } catch {
      // Best effort.
    }
  })
}
