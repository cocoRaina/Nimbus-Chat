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
    // 后台轮询：WorkManager 每 ~15min 拉起 runners/proactive.js 的 checkProactive
    // 事件，查沈暮有没有新主动消息、有就弹本地通知（App 关着也跑，华为需加电池白名单）。
    BackgroundRunner: {
      label: 'com.cocoraina.nimbuschat.proactive',
      src: 'runners/proactive.js',
      event: 'checkProactive',
      repeat: true,
      interval: 15,
      autoStart: true,
    },
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
    LocalNotifications: {
      // 状态栏通知小图标：专门的透明底单色 silhouette（两只猫）。安卓通知小图标
      // 只认 alpha 通道、不透明处一律被系统 tint 成单色，所以不能直接用彩色 launcher
      // 图标（会变一坨白）。iconColor 给通知点缀成品牌蓝。资源见
      // android/.../res/drawable-*/ic_stat_notify.png。
      smallIcon: 'ic_stat_notify',
      iconColor: '#5F7FB3',
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
