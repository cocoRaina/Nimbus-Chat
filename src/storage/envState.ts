import { Device } from '@capacitor/device'
import { getEnvStateNative } from '../plugins/EnvState'

// Per-message ambient phone snapshot, injected into the chat prompt like the
// weather snapshot (UI never shows it; only the model sees it). Bundles battery
// + charging + ringer mode + audio output + Wi-Fi/cellular + ambient light into
// one short line, e.g. "🔋32%充电中 · 静音 · 蓝牙:AirPods · Wi-Fi · 光线:漆黑",
// so the companion can react naturally ("快没电了记得充" / "戴耳机听歌呢" /
// "灯都关了还刷手机？").
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

    // 环境光：只报有信号量的两端，中间的普通室内光不占 token。
    // 措辞刻意不断言「关灯」——手机趴在桌上/揣兜里传感器被遮也是 0 lux，
    // 让模型自己结合时间判断是深夜关灯还是手机扣着放。
    const light = describeAmbientLight(env.lux)
    if (light) parts.push(light)
  }

  cached = parts.length > 0 ? parts.join(' · ') : null
}

// lux → 一小段中文描述（或 null = 不值得报）。阈值参考 Android 文档的
// 典型环境：<5 漆黑（深夜关灯/传感器被遮）、<50 昏暗（床头灯/夜灯档），
// >5000 强光（白天户外/阳光直射）。50~5000 的普通室内亮度是无信息量的
// 常态，不报，免得每条消息白白多几个 token。
const describeAmbientLight = (lux: number | undefined): string | null => {
  if (typeof lux !== 'number' || Number.isNaN(lux) || lux < 0) return null
  if (lux < 5) return '光线:漆黑'
  if (lux < 50) return '光线:昏暗'
  if (lux > 5000) return '光线:户外强光'
  return null
}
