import { Device } from '@capacitor/device'
import { getEnvStateNative } from '../plugins/EnvState'

// Per-message ambient phone snapshot, injected into the chat prompt like the
// weather snapshot (UI never shows it; only the model sees it). Bundles battery
// + charging + ringer mode + audio output + Wi-Fi/cellular into one short line,
// e.g. "🔋32%充电中 · 静音 · 蓝牙:AirPods · Wi-Fi", so the companion can react
// naturally ("快没电了记得充" / "戴耳机听歌呢" / "在车上？慢点开").
//
// Cached so the send path reads it synchronously (peekEnvSnapshot); the cache
// is warmed on mount and on every foreground via refreshEnvSnapshot(). All
// sources are on-device reads — no network, no API cost.

let cached: string | null = null

export const peekEnvSnapshot = (): string | null => cached

export const refreshEnvSnapshot = async (): Promise<void> => {
  const parts: string[] = []

  // Battery + charging (works on APK; best-effort elsewhere).
  try {
    const info = await Device.getBatteryInfo()
    if (typeof info.batteryLevel === 'number') {
      const pct = Math.round(info.batteryLevel * 100)
      parts.push(`🔋${pct}%${info.isCharging ? '充电中' : ''}`)
    }
  } catch {
    // ignore — battery unavailable on this platform
  }

  // Ambient state (Android native plugin only; null elsewhere).
  const env = await getEnvStateNative()
  if (env) {
    if (env.ringer === 'silent') parts.push('静音')
    else if (env.ringer === 'vibrate') parts.push('震动')

    if (env.audio === 'bluetooth') parts.push(env.btName ? `蓝牙:${env.btName}` : '蓝牙音频')
    else if (env.audio === 'wired') parts.push('耳机')

    if (env.network === 'wifi') parts.push('Wi-Fi')
    else if (env.network === 'cellular') parts.push('流量')
    else if (env.network === 'none') parts.push('离线')
  }

  cached = parts.length > 0 ? parts.join(' · ') : null
}
