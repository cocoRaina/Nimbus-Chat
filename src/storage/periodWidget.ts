import { Capacitor, registerPlugin } from '@capacitor/core'
import { supabase } from '../supabase/client'
import { computePeriodMetrics, type PeriodRow } from '../hooks/useHomeWidgetData'

// Bridge to the custom PeriodWidget Android plugin (see
// android/app/src/main/java/.../PeriodWidgetPlugin.java). Pushes the latest
// period data into SharedPreferences and refreshes the home-screen widget.
// The widget recomputes phase/cycle-day itself from these raw inputs, so we
// only need to feed it the start/end dates + resolved cycle length.

type PeriodWidgetPlugin = {
  update(data: {
    hasData: boolean
    startDate: string
    endDate: string | null
    cycleLength: number
  }): Promise<void>
}

const PeriodWidget = registerPlugin<PeriodWidgetPlugin>('PeriodWidget')

const isAvailable = (): boolean =>
  Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('PeriodWidget')

export const updatePeriodWidget = async (data: {
  startDate: string | null | undefined
  endDate: string | null | undefined
  cycleLength: number | null | undefined
}): Promise<void> => {
  if (!isAvailable()) return
  try {
    await PeriodWidget.update({
      hasData: !!data.startDate,
      startDate: data.startDate ?? '',
      endDate: data.endDate ?? null,
      cycleLength: data.cycleLength ?? 28,
    })
  } catch (err) {
    console.warn('update period widget failed', err)
  }
}

// 自己拉库推送（不依赖任何页面被打开）。背景：原来只有 useHomeWidgetData
// （只挂在健康同步页）会推数据给桌面小组件——聊天里用 log_period 记完经期，
// 不去健康同步页桌面卡就一直吃灰（2026-07-18 实锤：卡上还是 6 月的周期、
// 显示"第 35 天已晚 3 天"，实际是新周期第 8 天）。调用时机：
//   1. log_period 写库成功后（force，立即）
//   2. App 启动/回前台（内部 6h 节流，兜底日期滚动和多设备写入）
// 查询/周期算法与 useHomeWidgetData 完全同源（computePeriodMetrics），
// 两边永远算出同一个数。
let lastDbSyncAt = 0
const DB_SYNC_TTL_MS = 6 * 60 * 60 * 1000

export const syncPeriodWidgetFromDb = async (opts?: { force?: boolean }): Promise<void> => {
  if (!isAvailable() || !supabase) return
  const now = Date.now()
  if (!opts?.force && now - lastDbSyncAt < DB_SYNC_TTL_MS) return
  lastDbSyncAt = now
  try {
    const { data, error } = await supabase
      .from('period_tracking')
      .select('start_date,end_date,cycle_length,notes')
      .order('start_date', { ascending: false })
      .order('created_at', { ascending: false, nullsFirst: false })
      .limit(6)
    if (error) {
      console.warn('sync period widget: query failed', error)
      return
    }
    const rows = (data ?? []) as PeriodRow[]
    const metrics = computePeriodMetrics(rows[0] ?? null, rows)
    await updatePeriodWidget({
      startDate: rows[0]?.start_date,
      endDate: rows[0]?.end_date,
      cycleLength: metrics?.cycleLength,
    })
  } catch (err) {
    console.warn('sync period widget failed', err)
  }
}
