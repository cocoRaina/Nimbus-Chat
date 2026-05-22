import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import { Capacitor } from '@capacitor/core'
import { App as CapacitorApp } from '@capacitor/app'
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

// Keep the status bar visible (its own space at the top) so the app's
// header buttons aren't hidden under the notification area. Light icon
// theme since our app background is light.
if (Capacitor.getPlatform() === 'android') {
  StatusBar.setOverlaysWebView({ overlay: false }).catch(() => undefined)
  StatusBar.setStyle({ style: Style.Light }).catch(() => undefined)

  // Hardware back button: navigate within the app instead of exiting.
  // Only exit when there's nowhere left to go back to.
  CapacitorApp.addListener('backButton', () => {
    if (window.history.length > 1) {
      window.history.back()
    } else {
      CapacitorApp.exitApp()
    }
  })
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
