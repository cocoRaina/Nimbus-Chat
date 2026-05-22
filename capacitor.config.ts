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
      // Stay visible until JS calls SplashScreen.hide() (which we do
      // after React renders). Avoids the "boot → black flash → app"
      // jarring transition.
      launchShowDuration: 3000,
      launchAutoHide: false,
      backgroundColor: '#EFF6FF',
      androidSplashResourceName: 'splash',
      showSpinner: false,
      splashFullScreen: false,
      splashImmersive: false,
      androidScaleType: 'CENTER_CROP',
      useDialog: false,
      fadeOutDuration: 400,
    },
  },
}

export default config
