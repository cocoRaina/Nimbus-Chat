import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import { Capacitor } from '@capacitor/core'
import { StatusBar, Style } from '@capacitor/status-bar'
import './index.css'
import './styles/ui.css'
import App from './App.tsx'

const noFxEnabled =
  new URLSearchParams(window.location.search).get('noFx') === '1' ||
  import.meta.env.VITE_NO_FX === '1'

if (noFxEnabled) {
  document.documentElement.classList.add('no-fx')
}

// Make the webview draw under the system status bar on Android so the app
// looks fullscreen. Light icons since our background is mostly white.
if (Capacitor.getPlatform() === 'android') {
  StatusBar.setOverlaysWebView({ overlay: true }).catch(() => undefined)
  StatusBar.setStyle({ style: Style.Light }).catch(() => undefined)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </StrictMode>,
)

if ('serviceWorker' in navigator && Capacitor.getPlatform() === 'web') {
  // SW only useful for the PWA build. Inside Capacitor the assets are local
  // to the APK already, so registering one breaks more than it helps.
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch((error) => {
      console.error('Service worker registration failed:', error)
    })
  })
}
