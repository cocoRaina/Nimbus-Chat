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
  plugins: {
    SplashScreen: {
      launchShowDuration: 1200,
      launchAutoHide: false,
      backgroundColor: '#FFFFFF',
      androidSplashResourceName: 'splash',
      showSpinner: false,
      splashFullScreen: true,
      splashImmersive: true,
      androidScaleType: 'CENTER_INSIDE',
      useDialog: false,
      fadeOutDuration: 250,
    },
  },
}

export default config
