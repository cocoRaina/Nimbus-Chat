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
  // How the cycleLength was derived — surfaces "is this fixed 28d
  // or my actual averaged history?" in the UI.
  cycleSource: 'history' | 'logged' | 'default'
  // How many historical gaps we used to derive the adaptive
  // cycle (0 when source !== 'history'). Surfaces in the period
  // section so the user knows the prediction is settling.
  cycleSampleSize: number
  phase: '经期中' | '滤泡期' | '排卵期' | '黄体期'
  nextDate: Date
  notes: string | null
}

// Computes the median gap (in days) between consecutive period
// start_dates. Used to derive an adaptive cycle length from history
// instead of hard-coding 28d. Median (not mean) so a single outlier
// cycle (skipped period, miscount) doesn't drag the prediction.
// Only considers gaps within a sane window (15-60d) — anything outside
// is almost certainly bad data or a missed entry.
export const computeMedianCycleFromHistory = (
  rows: Array<{ start_date: string }>,
): { median: number; sampleSize: number } | null => {
  if (rows.length < 2) return null
  // Sort by start_date DESC so the first row is most recent. We
  // don't trust the caller to have ordered the input.
  const sorted = [...rows].sort((a, b) =>
    a.start_date < b.start_date ? 1 : -1,
  )
  const gaps: number[] = []
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const a = new Date(sorted[i].start_date)
    const b = new Date(sorted[i + 1].start_date)
    if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) continue
    const gapDays = Math.round((a.getTime() - b.getTime()) / (24 * 60 * 60 * 1000))
    if (gapDays >= 15 && gapDays <= 60) gaps.push(gapDays)
  }
  if (gaps.length === 0) return null
  gaps.sort((a, b) => a - b)
  const mid = Math.floor(gaps.length / 2)
  const median =
    gaps.length % 2 === 1 ? gaps[mid] : Math.round((gaps[mid - 1] + gaps[mid]) / 2)
  return { median, sampleSize: gaps.length }
}

const computePeriodMetrics = (
  row: PeriodRow | null,
  historyRows: Array<{ start_date: string }>,
): PeriodMetrics | null => {
  if (!row) return null
  // Parse 'YYYY-MM-DD' as a calendar date (date-only, no time/zone). Using
  // `new Date('YYYY-MM-DD')` parses as UTC midnight, which in UTC+8 shifts
  // the local day and makes comparisons against `today` off by up to a day
  // (the "period ends a day early after 8am" bug).
  const parseDateNum = (s: string): number | null => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
    return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null
  }
  const startNum = parseDateNum(row.start_date)
  if (startNum === null) return null
  const today = new Date()
  const oneDay = 24 * 60 * 60 * 1000
  const todayNum = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())
  const daysSinceStart = Math.floor((todayNum - startNum) / oneDay)
  // Cycle length priority:
  //   1. Median of historical gaps (most accurate — adapts to user)
  //   2. cycle_length explicitly written by Claude via log_period
  //   3. 28d fallback (textbook average)
  const adaptive = computeMedianCycleFromHistory(historyRows)
  let cycleLength: number
  let cycleSource: PeriodMetrics['cycleSource']
  let cycleSampleSize = 0
  if (adaptive) {
    cycleLength = adaptive.median
    cycleSource = 'history'
    cycleSampleSize = adaptive.sampleSize
  } else if (row.cycle_length && row.cycle_length > 0) {
    cycleLength = row.cycle_length
    cycleSource = 'logged'
  } else {
    cycleLength = 28
    cycleSource = 'default'
  }
  const daysToNext = cycleLength - daysSinceStart

  // Decide "still bleeding" by the end_date when present, otherwise
  // assume typical menstruation tops out at 7 days. Without this
  // fallback, a row written without an end_date stays "经期中" forever
  // (the bug the user just hit — entry from May still showing as
  // current period in June).
  let isInPeriod: boolean
  if (row.end_date) {
    const endNum = parseDateNum(row.end_date)
    // Date-only comparison: on the end date itself (todayNum === endNum) the
    // user is still in their period.
    isInPeriod = endNum !== null && todayNum <= endNum
  } else {
    isInPeriod = daysSinceStart >= 0 && daysSinceStart < 7
  }

  let phase: PeriodMetrics['phase']
  if (isInPeriod) {
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
    cycleSource,
    cycleSampleSize,
    phase,
    nextDate: new Date(startNum + cycleLength * oneDay),
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
      // Pull up to 6 of the most recent cycles so we can derive an
      // adaptive cycle length (median gap between consecutive starts).
      // 6 is enough to smooth out a noisy month or two without
      // dragging in ancient history when the user's actual cycle has
      // shifted. The newest row is also the "current" one used by the
      // single-row UI.
      supabase
        .from('period_tracking')
        .select('start_date,end_date,cycle_length,notes')
        .order('start_date', { ascending: false })
        .order('created_at', { ascending: false, nullsFirst: false })
        .limit(6),
      readDailyUsage().catch(() => null),
    ])

    if (!healthRes.error) {
      setHealthRow((healthRes.data as HealthTodayRow | null) ?? null)
    }
    if (!periodRes.error) {
      const rows = (periodRes.data as PeriodRow[] | null) ?? []
      setPeriodMetrics(computePeriodMetrics(rows[0] ?? null, rows))
    }
    setScreenTime(usageRes)
  }, [])

  useEffect(() => {
    if (!userId) return
    void refresh()
  }, [userId, refresh])

  return { healthRow, periodMetrics, screenTime, refresh }
}
