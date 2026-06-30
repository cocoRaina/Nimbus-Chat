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
    CapacitorHttp: {
      // Stays ON for CORS bypass: most 中转 don't allow the WebView origin
      // (https://localhost), so without native HTTP their requests fail with
      // "Failed to fetch". This routes window.fetch through native OkHttp,
      // bypassing the WebView CORS wall.
      //
      // CAVEAT (the trap an earlier comment got wrong): CapacitorHttp's native
      // fetch does NOT stream — it buffers the whole response, so the chat
      // reply used to arrive as "一大坨" after a long blank "正在输入…". The fix
      // is NOT to disable this (that would reintroduce "Failed to fetch" on
      // CORS-less relays). Instead the streaming chat request goes through the
      // StreamHttp plugin (android/.../StreamHttpPlugin.java + src/native/
      // streamHttp.ts), which does its own native HTTP that bypasses CORS AND
      // streams. Everything else keeps using this buffered native fetch.
      enabled: true,
    },
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
