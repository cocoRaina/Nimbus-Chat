import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.cocoraina.nimbuschat',
  appName: 'Nimbus Chat',
  webDir: 'dist',
  android: {
    // Allow the app to make HTTPS calls to Supabase / OpenRouter / 中转 /
    // SiliconFlow without being treated as cleartext.
    allowMixedContent: false,
  },
  server: {
    // Lets the webview keep working with our HashRouter setup. iOS would
    // need scheme: 'https' too — set this when we add iOS later.
    androidScheme: 'https',
  },
}

export default config
