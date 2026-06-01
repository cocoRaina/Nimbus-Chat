import { Capacitor } from '@capacitor/core'
import { Health, type HealthDataType, type HealthSample } from '@capgo/capacitor-health'
import { supabase } from '../supabase/client'

// Per-day aggregate row mirroring the health_data table.
export type HealthDayAggregate = {
  date: string // YYYY-MM-DD
  steps?: number | null
  sleepHours?: number | null
  heartRateAvg?: number | null
  heartRateMax?: number | null
  heartRateMin?: number | null
  heartRateRest?: number | null
  oxygenSaturationAvg?: number | null
}

export type SyncSummary = {
  ok: boolean
  scannedDays: string[]
  upsertedDates: string[]
  perType: Record<string, number> // type → sample count fetched
  skippedReason?: string
  errors: string[]
}

// Storage key for throttling auto-sync triggers.
const LAST_SYNC_KEY = 'nimbus_health_last_sync_at_v1'
const AUTO_SYNC_MIN_INTERVAL_MS = 30 * 60 * 1000 // 30 minutes

export const readLastSyncedAt = (): number | null => {
  if (typeof window === 'undefined') return null
  const raw = window.localStorage.getItem(LAST_SYNC_KEY)
  if (!raw) return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

const writeLastSyncedAt = (timestamp: number) => {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(LAST_SYNC_KEY, String(timestamp))
}

// Local YYYY-MM-DD for any ISO date string. We bucket using the user's
// local timezone because the source rows are recorded that way.
const isoToLocalDate = (iso: string): string | null => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

const sampleDurationMinutes = (s: HealthSample): number => {
  const start = new Date(s.startDate).getTime()
  const end = new Date(s.endDate).getTime()
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0
  return (end - start) / 60000
}

const SYNC_TYPES: HealthDataType[] = [
  'steps',
  'sleep',
  'heartRate',
  'restingHeartRate',
  'oxygenSaturation',
]

// Per-type read budget. Capgo's plugin defaults to 100 records per
// page and keeps paginating until it has them all. For high-frequency
// sources like heart rate or steps (华为 Health Sync emits one record
// per minute) a 48h window with no limit fans out to dozens of Health
// Connect requests and trips the "rate limit" guard.
//
// We still need *enough* records to cover a full local day, since the
// plugin returns rows newest-first — too small and the early-morning
// hours fall off the bottom of the page. ~1500 covers 24h at one
// sample per minute with a safety buffer. The plugin caps pageSize at
// 500, so 1500 means three paginated requests; well below Health
// Connect's burst budget (~2000 reads / 5min for foreground apps).
//
// Sparse sources (sleep sessions, resting HR) keep tiny caps.
const PER_TYPE_OPTS: Record<HealthDataType, { limit: number; windowHours: number }> = {
  steps: { limit: 1500, windowHours: 48 },
  sleep: { limit: 50, windowHours: 48 },
  heartRate: { limit: 1500, windowHours: 24 },
  restingHeartRate: { limit: 30, windowHours: 72 },
  oxygenSaturation: { limit: 500, windowHours: 48 },
} as Record<HealthDataType, { limit: number; windowHours: number }>

// Deduplicate samples before aggregating. Capgo's plugin + Health
// Sync occasionally surface the same physical record twice (same
// platformId, same start/end, same value, same source), which the
// probe screen makes painfully visible on a Huawei → Health Sync →
// Health Connect chain: every steps sample appears as a perfect pair.
// Without de-dup the daily totals double.
const dedupeSamples = (samples: HealthSample[]): HealthSample[] => {
  const seen = new Set<string>()
  const out: HealthSample[] = []
  for (const s of samples) {
    // platformId is the Health Connect record's metadata id and is
    // the gold-standard unique key when present. Fall back to a
    // composite if the plugin happens not to return it.
    const key =
      s.platformId && s.platformId.length > 0
        ? `${s.dataType}|${s.platformId}`
        : `${s.dataType}|${s.startDate}|${s.endDate}|${s.value}|${s.sourceName ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(s)
  }
  return out
}

// Aggregates a list of samples into the per-day rows we store. The
// aggregation rule per type:
//  - steps:             sum of values bucketed by sample startDate
//  - sleep:             sum of segment durations (minutes → hours)
//                       bucketed by *endDate* — "the morning you woke
//                       up" is the day people associate sleep with.
//                       Filters out 'awake' / 'inBed' segments so we
//                       only count actual sleep stages.
//  - heartRate:         arithmetic mean of values bucketed by startDate
//  - restingHeartRate:  latest reading per day (one number per day in
//                       practice from most wearables)
//  - oxygenSaturation:  arithmetic mean per day
const aggregateSamples = (
  samples: HealthSample[],
): Record<string, HealthDayAggregate> => {
  const acc: Record<
    string,
    {
      steps: number
      sleepMinutes: number
      hrSum: number
      hrCount: number
      hrMax: number | null
      hrMin: number | null
      restingHr: number | null
      spo2Sum: number
      spo2Count: number
    }
  > = {}

  const bucket = (date: string) => {
    if (!acc[date]) {
      acc[date] = {
        steps: 0,
        sleepMinutes: 0,
        hrSum: 0,
        hrCount: 0,
        hrMax: null,
        hrMin: null,
        restingHr: null,
        spo2Sum: 0,
        spo2Count: 0,
      }
    }
    return acc[date]
  }

  for (const s of samples) {
    const startDate = isoToLocalDate(s.startDate)
    const endDate = isoToLocalDate(s.endDate)
    if (!startDate || !endDate) continue

    switch (s.dataType) {
      case 'steps': {
        bucket(startDate).steps += s.value
        break
      }
      case 'sleep': {
        // Skip awake / inBed segments — only actual sleep counts.
        if (
          s.sleepState === 'awake' ||
          s.sleepState === 'inBed'
        ) {
          break
        }
        const mins = sampleDurationMinutes(s)
        if (mins > 0) {
          bucket(endDate).sleepMinutes += mins
        }
        break
      }
      case 'heartRate': {
        const b = bucket(startDate)
        b.hrSum += s.value
        b.hrCount += 1
        if (b.hrMax == null || s.value > b.hrMax) b.hrMax = s.value
        if (b.hrMin == null || s.value < b.hrMin) b.hrMin = s.value
        break
      }
      case 'restingHeartRate': {
        bucket(startDate).restingHr = s.value
        break
      }
      case 'oxygenSaturation': {
        const b = bucket(startDate)
        // Source unit is 'percent'. Some platforms return 95 (95%),
        // others 0.95. Normalise to the larger scale so we always
        // store something humans recognise.
        const v = s.value <= 1 ? s.value * 100 : s.value
        b.spo2Sum += v
        b.spo2Count += 1
        break
      }
      default:
        break
    }
  }

  const out: Record<string, HealthDayAggregate> = {}
  for (const [date, b] of Object.entries(acc)) {
    out[date] = {
      date,
      steps: b.steps > 0 ? Math.round(b.steps) : null,
      sleepHours: b.sleepMinutes > 0 ? Math.round((b.sleepMinutes / 60) * 10) / 10 : null,
      heartRateAvg: b.hrCount > 0 ? Math.round(b.hrSum / b.hrCount) : null,
      heartRateMax: b.hrMax != null ? Math.round(b.hrMax) : null,
      heartRateMin: b.hrMin != null ? Math.round(b.hrMin) : null,
      heartRateRest: b.restingHr != null ? Math.round(b.restingHr) : null,
      oxygenSaturationAvg: b.spo2Count > 0 ? Math.round((b.spo2Sum / b.spo2Count) * 10) / 10 : null,
    }
  }
  return out
}

// Public entry. windowDays controls how far back we scan. 3 is a sweet
// spot: covers "user opens app at 1am" needing yesterday, plus a
// safety buffer for late-arriving samples from the wearable.
export const syncHealthDataToSupabase = async (
  opts: { windowDays?: number; force?: boolean } = {},
): Promise<SyncSummary> => {
  const summary: SyncSummary = {
    ok: false,
    scannedDays: [],
    upsertedDates: [],
    perType: {},
    errors: [],
  }

  if (Capacitor.getPlatform() !== 'android') {
    summary.skippedReason = 'not-native'
    return summary
  }

  // Throttle: don't auto-sync more than once per AUTO_SYNC_MIN_INTERVAL_MS.
  // `force` bypasses the gate for the manual button.
  if (!opts.force) {
    const last = readLastSyncedAt()
    if (last && Date.now() - last < AUTO_SYNC_MIN_INTERVAL_MS) {
      summary.skippedReason = 'throttled'
      return summary
    }
  }

  // Availability check — if Health Connect isn't installed we silently
  // bail. The probe page exposes a richer error for diagnostics.
  try {
    const avail = await Health.isAvailable()
    if (!avail.available) {
      summary.skippedReason = avail.reason ?? 'health-connect-unavailable'
      return summary
    }
  } catch (err) {
    summary.skippedReason = err instanceof Error ? err.message : 'availability-check-failed'
    return summary
  }

  const endDate = new Date()
  const allSamples: HealthSample[] = []
  for (const dataType of SYNC_TYPES) {
    const opt = PER_TYPE_OPTS[dataType]
    const windowHours = opts.windowDays
      ? opts.windowDays * 24
      : opt?.windowHours ?? 48
    const limit = opt?.limit ?? 500
    const startDate = new Date(endDate.getTime() - windowHours * 3600 * 1000)
    try {
      const res = await Health.readSamples({
        dataType,
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        limit,
      })
      summary.perType[dataType] = res.samples.length
      allSamples.push(...res.samples)
      // Small pause between types so Health Connect's burst-quota
      // counter has time to relax — measurable difference on
      // dense-source phones (e.g. 华为 with minute-level heart rate).
      await new Promise((resolve) => setTimeout(resolve, 250))
    } catch (err) {
      // A single type failing (e.g. permission not granted for that
      // type, or rate-limited) shouldn't kill the whole sync. Log
      // and continue.
      summary.errors.push(
        `${dataType}: ${err instanceof Error ? err.message : String(err)}`,
      )
      summary.perType[dataType] = 0
    }
  }

  const dedupedSamples = dedupeSamples(allSamples)
  const byDay = aggregateSamples(dedupedSamples)
  summary.scannedDays = Object.keys(byDay).sort()

  if (!supabase) {
    summary.skippedReason = 'no-supabase-client'
    return summary
  }

  const rowsToUpsert = Object.values(byDay)
    // Skip days with absolutely nothing to write so we don't smother
    // a previously-written value with NULLs.
    .filter(
      (row) =>
        row.steps != null ||
        row.sleepHours != null ||
        row.heartRateAvg != null ||
        row.heartRateMax != null ||
        row.heartRateMin != null ||
        row.heartRateRest != null ||
        row.oxygenSaturationAvg != null,
    )
    .map((row) => ({
      date: row.date,
      steps: row.steps,
      sleep_hours: row.sleepHours,
      heart_rate_avg: row.heartRateAvg,
      heart_rate_max: row.heartRateMax,
      heart_rate_min: row.heartRateMin,
      heart_rate_rest: row.heartRateRest,
      oxygen_saturation_avg: row.oxygenSaturationAvg,
    }))

  if (rowsToUpsert.length > 0) {
    const { error } = await supabase
      .from('health_data')
      .upsert(rowsToUpsert, { onConflict: 'date' })
    if (error) {
      summary.errors.push(`upsert: ${error.message}`)
      summary.ok = false
      return summary
    }
    summary.upsertedDates = rowsToUpsert.map((r) => r.date)
  }

  writeLastSyncedAt(Date.now())
  summary.ok = true
  return summary
}

// Best-effort auto-sync called by App.tsx on mount + foreground.
// Swallows errors; the probe page is where diagnostics live.
export const maybeAutoSyncHealth = async (): Promise<void> => {
  try {
    await syncHealthDataToSupabase({})
  } catch (err) {
    console.warn('auto health sync failed', err)
  }
}
