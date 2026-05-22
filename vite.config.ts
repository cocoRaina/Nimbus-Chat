import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// BUILD_TARGET=pages → set base for GitHub Pages subpath
// BUILD_TARGET=app (or unset) → use root, for Capacitor APK / standalone host
// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  base: mode === 'production' && process.env.BUILD_TARGET === 'pages' ? '/Nimbus-Chat/' : '/',
  plugins: [react()],
}))
