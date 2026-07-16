import { Capacitor } from '@capacitor/core'
import { Device } from '@capacitor/device'

// Snapshot of the user's phone state, shaped for the get_device_state
// tool result. Any field can be null when the underlying source is
// unavailable (web build, permission not granted, plugin error).
export type DeviceState = {
  battery_percent: number | null
  is_charging: boolean | null
  // Today's total foreground screen time across all apps, minutes.
  // Populated by the custom usage-stats Capacitor plugin once the
  // user grants "使用情况访问权限" in system settings.
  daily_screen_minutes: number | null
  // Top apps by foreground time today (max 5).
  top_apps?: Array<{ name: string; minutes: number }>
  // Ambient light in lux (light sensor). null = sensor absent / no reading.
  // Note: 0 lux can also mean the phone is face-down or in a pocket, not
  // necessarily lights-off — the envSnapshot wording accounts for this too.
  ambient_light_lux: number | null
  // Why each field might be null — lets the model phrase its reply
  // ("blocked by permission" vs "this build can't read that").
  notes: string[]
}

export const getDeviceState = async (): Promise<DeviceState> => {
  const notes: string[] = []
  if (Capacitor.getPlatform() !== 'android') {
    notes.push('non-android-build: 仅 APK 可读取设备状态')
    return {
      battery_percent: null,
      is_charging: null,
      daily_screen_minutes: null,
      ambient_light_lux: null,
      notes,
    }
  }

  let batteryPercent: number | null = null
  let isCharging: boolean | null = null
  try {
    const info = await Device.getBatteryInfo()
    if (typeof info.batteryLevel === 'number') {
      batteryPercent = Math.round(info.batteryLevel * 100)
    }
    if (typeof info.isCharging === 'boolean') {
      isCharging = info.isCharging
    }
  } catch (err) {
    notes.push(`battery: ${err instanceof Error ? err.message : String(err)}`)
  }

  // Usage-stats hook lives in usageStatsNative.ts. Imported lazily so
  // pure-battery callers don't have to await the native bridge probe.
  let dailyScreenMinutes: number | null = null
  let topApps: DeviceState['top_apps']
  try {
    const { readDailyUsage } = await import('./usageStatsNative')
    const usage = await readDailyUsage()
    if (usage) {
      dailyScreenMinutes = usage.total_minutes
      topApps = usage.top_apps
    } else {
      notes.push('usage-stats: 未授权 PACKAGE_USAGE_STATS 或未启用 plugin')
    }
  } catch (err) {
    notes.push(`usage-stats: ${err instanceof Error ? err.message : String(err)}`)
  }

  // Ambient light rides on the EnvState plugin (same foreground-cached lux
  // that feeds the per-message envSnapshot line).
  let ambientLightLux: number | null = null
  try {
    const { getEnvStateNative } = await import('../plugins/EnvState')
    const env = await getEnvStateNative()
    if (env && typeof env.lux === 'number' && env.lux >= 0) {
      ambientLightLux = Math.round(env.lux)
    } else {
      notes.push('ambient-light: 无光线传感器或暂无读数')
    }
  } catch (err) {
    notes.push(`ambient-light: ${err instanceof Error ? err.message : String(err)}`)
  }

  return {
    battery_percent: batteryPercent,
    is_charging: isCharging,
    daily_screen_minutes: dailyScreenMinutes,
    top_apps: topApps,
    ambient_light_lux: ambientLightLux,
    notes,
  }
}
