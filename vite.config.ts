import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'

// 构建身份戳：git 短 sha + 构建号 + 时间。烧进包里、设置页底部显示，
// 这样一眼能看出手机上跑的到底是哪个包（专治"装了新包却没更新"扯不清）。
const BUILD_ID = (() => {
  try {
    const sha = execSync('git rev-parse --short HEAD').toString().trim()
    const run = process.env.GITHUB_RUN_NUMBER ? `#${process.env.GITHUB_RUN_NUMBER}` : 'local'
    const when = new Date().toISOString().slice(0, 16).replace('T', ' ')
    return `${sha} ${run} · ${when}Z`
  } catch {
    return 'dev'
  }
})()

// BUILD_TARGET=pages → set base for GitHub Pages subpath
// BUILD_TARGET=app (or unset) → use root, for Capacitor APK / standalone host
// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  base: mode === 'production' && process.env.BUILD_TARGET === 'pages' ? '/Nimbus-Chat/' : '/',
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // Split heavy third-party deps into their own long-lived chunks so
        // (a) they download in parallel with the app chunk, and (b) they stay
        // cached across deploys — app code changes no longer invalidate the
        // ~500KB of vendor JS. Without this everything lands in one 754KB
        // chunk that re-downloads on every push.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler|react-router|react-router-dom)[\\/]/.test(id)) {
            return 'react-vendor'
          }
          if (id.includes('@supabase')) return 'supabase'
          // react-markdown pulls a large micromark/mdast/unified ecosystem.
          if (/[\\/]node_modules[\\/](react-markdown|remark-|micromark|mdast|unified|unist-|vfile|hast|property-information|space-separated-tokens|comma-separated-tokens|decode-named-character-reference|character-entities|trim-lines|devlop|bail|is-plain-obj|trough|ccount|escape-string-regexp|markdown-table|zwitch|longest-streak|html-url-attributes|estree-util-is-identifier-name|hast-util|mdast-util|micromark-)/.test(id)) {
            return 'markdown'
          }
          return 'vendor'
        },
      },
    },
  },
}))
