import { Capacitor, registerPlugin } from '@capacitor/core'

// Bridge to the custom UsageStats Android plugin defined in
// android/app/src/main/java/.../UsageStatsPlugin.kt.
//
// Requires PACKAGE_USAGE_STATS — a special "AppOps" permission the
// user has to enable in system Settings → 应用使用情况 → Nimbus
// (Settings.ACTION_USAGE_ACCESS_SETTINGS). hasPermission() returns
// false until that toggle is on; requestPermission() opens the
// system page so the user can grant it.

export type DailyUsageRow = {
  package_name: string
  app_name: string
  total_minutes: number
}

export type DailyUsageResult = {
  total_minutes: number
  top_apps: Array<{ name: string; minutes: number }>
}

type UsageStatsPlugin = {
  hasPermission(): Promise<{ granted: boolean }>
  requestPermission(): Promise<void>
  // Returns today's foreground time per package since 00:00 local.
  getDailyUsage(): Promise<{ apps: DailyUsageRow[] }>
}

const UsageStats = registerPlugin<UsageStatsPlugin>('UsageStats')

export const isUsageStatsAvailable = (): boolean =>
  Capacitor.isPluginAvailable('UsageStats') && Capacitor.getPlatform() === 'android'

export const hasUsageStatsPermission = async (): Promise<boolean> => {
  if (!isUsageStatsAvailable()) return false
  try {
    const res = await UsageStats.hasPermission()
    return !!res?.granted
  } catch {
    return false
  }
}

export const openUsageStatsSettings = async (): Promise<void> => {
  if (!isUsageStatsAvailable()) return
  try {
    await UsageStats.requestPermission()
  } catch {
    // Silent — user can navigate manually.
  }
}

export const readDailyUsage = async (): Promise<DailyUsageResult | null> => {
  if (!isUsageStatsAvailable()) return null
  const granted = await hasUsageStatsPermission()
  if (!granted) return null
  try {
    const { apps } = await UsageStats.getDailyUsage()
    if (!Array.isArray(apps)) return null
    const rows = apps
      .filter((row) => row && row.total_minutes > 0)
      .sort((a, b) => b.total_minutes - a.total_minutes)
    const total_minutes = rows.reduce((sum, row) => sum + row.total_minutes, 0)
    const top_apps = rows.slice(0, 5).map((row) => ({
      name: row.app_name || row.package_name,
      minutes: row.total_minutes,
    }))
    return { total_minutes, top_apps }
  } catch {
    return null
  }
}
