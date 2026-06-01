import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../supabase/client'
import { readDailyUsage, type DailyUsageResult } from '../storage/usageStatsNative'

// Aggregated data for the three on-home content widgets (health,
// screen-time, period). Pulled together once and shared via this
// hook so the page doesn't re-fetch per widget instance — a user can
// drop multiple copies of the same widget across pages without
// hammering the supabase row + native bridge each time.

export type HealthTodayRow = {
  date: string
  steps: number | null
  sleep_hours: number | null
  heart_rate_avg: number | null
  heart_rate_max: number | null
  heart_rate_min: number | null
  heart_rate_rest: number | null
  oxygen_saturation_avg: number | null
}

export type PeriodRow = {
  start_date: string
  end_date: string | null
  cycle_length: number | null
  notes: string | null
}

export type PeriodMetrics = {
  // 1-indexed day of cycle the user is on. "Day 1" = start_date.
  cycleDay: number
  // -1 / 0 / +N: positive means days remain; 0 means due today;
  // negative means we're past the predicted next start (cycle late).
  daysToNext: number
  cycleLength: number
  phase: '经期中' | '滤泡期' | '排卵期' | '黄体期'
  nextDate: Date
  notes: string | null
}

const computePeriodMetrics = (row: PeriodRow | null): PeriodMetrics | null => {
  if (!row) return null
  const start = new Date(row.start_date)
  if (Number.isNaN(start.getTime())) return null
  const today = new Date()
  const oneDay = 24 * 60 * 60 * 1000
  const daysSinceStart = Math.floor(
    (Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) -
      Date.UTC(start.getFullYear(), start.getMonth(), start.getDate())) /
      oneDay,
  )
  const cycleLength = row.cycle_length ?? 28
  const daysToNext = cycleLength - daysSinceStart
  let phase: PeriodMetrics['phase']
  if (row.end_date == null) {
    phase = '经期中'
  } else if (daysSinceStart < 12) {
    phase = '滤泡期'
  } else if (daysSinceStart >= 12 && daysSinceStart <= 16) {
    phase = '排卵期'
  } else {
    phase = '黄体期'
  }
  return {
    cycleDay: daysSinceStart + 1,
    daysToNext,
    cycleLength,
    phase,
    nextDate: new Date(start.getTime() + cycleLength * oneDay),
    notes: row.notes,
  }
}

export type HomeWidgetData = {
  healthRow: HealthTodayRow | null
  periodMetrics: PeriodMetrics | null
  screenTime: DailyUsageResult | null
  refresh: () => Promise<void>
}

const todayDateString = (): string => {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

export const useHomeWidgetData = (userId: string | null | undefined): HomeWidgetData => {
  const [healthRow, setHealthRow] = useState<HealthTodayRow | null>(null)
  const [periodMetrics, setPeriodMetrics] = useState<PeriodMetrics | null>(null)
  const [screenTime, setScreenTime] = useState<DailyUsageResult | null>(null)

  const refresh = useCallback(async () => {
    if (!supabase) return
    const today = todayDateString()
    // Run all three fetches in parallel — they're independent and
    // each has its own permission / availability gate.
    const [healthRes, periodRes, usageRes] = await Promise.all([
      supabase
        .from('health_data')
        .select('date,steps,sleep_hours,heart_rate_avg,heart_rate_max,heart_rate_min,heart_rate_rest,oxygen_saturation_avg')
        .eq('date', today)
        .maybeSingle(),
      supabase
        .from('period_tracking')
        .select('start_date,end_date,cycle_length,notes')
        .order('start_date', { ascending: false })
        .limit(1)
        .maybeSingle(),
      readDailyUsage().catch(() => null),
    ])

    if (!healthRes.error) {
      setHealthRow((healthRes.data as HealthTodayRow | null) ?? null)
    }
    if (!periodRes.error) {
      setPeriodMetrics(computePeriodMetrics((periodRes.data as PeriodRow | null) ?? null))
    }
    setScreenTime(usageRes)
  }, [])

  useEffect(() => {
    if (!userId) return
    void refresh()
  }, [userId, refresh])

  return { healthRow, periodMetrics, screenTime, refresh }
}
