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

// Rate-limit backoff. When Health Connect rejects a read with its
// quota-exceeded error, we record a cooldown deadline. Until that
// deadline, NO sync runs — not even a manual `force` one. This is
// deliberate: during the rate-limit window every additional request
// fails AND keeps the rolling quota pinned, so the only way the quota
// refills is to stop touching Health Connect entirely. 10 min is
// comfortably above Health Connect's ~5 min rolling window.
//
// This is the fix for the foreground-retry death-loop: maybeAutoSyncHealth
// fires on mount + every visibilitychange, and the only thing stopping
// it from re-hammering the quota was last_synced_at — which we
// (correctly) stopped writing on failed syncs. Without a separate
// backoff, a single rate-limit turned every app-foreground into another
// quota-draining retry, so the quota never recovered. The backoff gives
// it an enforced quiet window.
const RATE_LIMIT_BACKOFF_KEY = 'nimbus_health_rate_limit_until_v1'
const RATE_LIMIT_BACKOFF_MS = 10 * 60 * 1000 // 10 minutes

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

const readRateLimitUntil = (): number | null => {
  if (typeof window === 'undefined') return null
  const raw = window.localStorage.getItem(RATE_LIMIT_BACKOFF_KEY)
  if (!raw) return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

const writeRateLimitUntil = (timestamp: number) => {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(RATE_LIMIT_BACKOFF_KEY, String(timestamp))
}

const clearRateLimitBackoff = () => {
  if (typeof window === 'undefined') return
  window.localStorage.removeItem(RATE_LIMIT_BACKOFF_KEY)
}

// How many whole minutes remain in the rate-limit cooldown, for UI hints.
export const rateLimitCooldownMinutesLeft = (): number => {
  const until = readRateLimitUntil()
  if (!until) return 0
  const ms = until - Date.now()
  return ms > 0 ? Math.ceil(ms / 60000) : 0
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

// Types read via readSamples (raw record list). Steps is handled
// separately through the aggregate API — see syncHealthDataToSupabase —
// because a daily step *total* must not be truncated by a record limit
// the way an average can tolerate it.
const READ_SAMPLE_TYPES: HealthDataType[] = [
  'sleep',
  'heartRate',
  'restingHeartRate',
  'oxygenSaturation',
]

// Per-type read budget. Health Connect enforces BOTH a periodic
// (short-window burst) rate limit AND a daily quota — exceeding either
// throws RateLimitException. The plugin paginates readRecords with
// pageSize = min(limit, 500), firing the pages back-to-back with no
// gap. So a `limit` above 500 turns one type into a 2-3 request *burst*,
// and five such types fan out to ~9 near-simultaneous reads — exactly
// what was tripping the limiter. (The diagnostic probe never trips it:
// one type, no limit → DEFAULT_LIMIT 100 → a single request, seconds
// apart between manual clicks.)
//
// Fix: keep every readSamples type at limit <= 500 so each is exactly
// ONE request (one page), and read them sequentially with a gap between
// types (see the sync loop). Averages (HR, SpO2) tolerate "newest 500
// samples" fine — they're returned newest-first so today is always
// covered. Sparse sources (sleep sessions, resting HR) need only tiny
// caps.
const PER_TYPE_OPTS: Record<HealthDataType, { limit: number; windowHours: number }> = {
  sleep: { limit: 50, windowHours: 48 },
  heartRate: { limit: 500, windowHours: 36 },
  restingHeartRate: { limit: 30, windowHours: 72 },
  oxygenSaturation: { limit: 300, windowHours: 48 },
} as Record<HealthDataType, { limit: number; windowHours: number }>

// Gap between sequential Health Connect reads. The periodic rate limit
// is QPS-style, so spacing a handful of single-page reads across ~1.5s
// keeps us comfortably under it. 300ms × ~5 reads ≈ 1.5s total — barely
// noticeable to the user, and the difference between "all 6 metrics
// sync" and "RateLimitException after the second one".
const READ_GAP_MS = 300

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
    // Series-style record types (heart rate especially) emit many
    // samples that share the same platformId (the parent record's
    // metadata.id). Keying on platformId alone collapses an entire
    // heart-rate series to a single sample — that's why "62-62"
    // showed up earlier. Always include startDate + value so
    // distinct samples inside the same series stay distinct, while
    // genuine duplicates (same time, same value, same record) still
    // collapse.
    const key =
      s.platformId && s.platformId.length > 0
        ? `${s.dataType}|${s.platformId}|${s.startDate}|${s.value}`
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

  // Rate-limit backoff gate. Checked BEFORE the force bypass — during a
  // Health Connect quota cooldown even a manual sync must not fire,
  // because each request restarts the rolling-window clock and the
  // quota would never refill. We surface 'rate-limited' so the UI shows
  // its wait-and-retry hint (with minutes-left).
  const backoffUntil = readRateLimitUntil()
  if (backoffUntil && Date.now() < backoffUntil) {
    summary.skippedReason = 'rate-limited'
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
  let rateLimited = false
  const isRateLimitErr = (msg: string) => /rate.?limit|quota|throttl|too many|429/i.test(msg)

  // Sequential reads with a gap between each — NOT parallel. Health
  // Connect's periodic rate limit is QPS-style, so a simultaneous burst
  // is the worst case; spacing single-page reads across ~1.5s is what
  // keeps us under it. We DON'T break the loop on a rate-limit error any
  // more: each type is one isolated request, so a later type may well
  // succeed after the inter-read gap. We just note it and arm the
  // backoff so the *next* whole sync waits.
  const sleepMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  let firstRead = true

  // Steps via the aggregate API. A daily step count is a SUM, so a
  // record limit that truncates the list would silently undercount —
  // unlike an average. queryAggregated returns one exact total per
  // calendar-day bucket in a single lightweight call per bucket, with
  // no pagination over thousands of minute-level records. Anchor the
  // window to LOCAL midnight so the plugin's fixed-24h buckets line up
  // with calendar days (an unaligned start would split one day's steps
  // across two buckets).
  const stepsByDay: Record<string, number> = {}
  {
    const daysBack = Math.max(1, opts.windowDays ?? 2)
    const midnightToday = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate())
    const stepsStart = new Date(midnightToday.getTime() - (daysBack - 1) * 24 * 3600 * 1000)
    try {
      const agg = await Health.queryAggregated({
        dataType: 'steps',
        startDate: stepsStart.toISOString(),
        endDate: endDate.toISOString(),
        bucket: 'day',
        aggregation: 'sum',
      })
      let stepDays = 0
      for (const s of agg.samples) {
        const day = isoToLocalDate(s.startDate)
        if (!day) continue
        stepsByDay[day] = (stepsByDay[day] ?? 0) + s.value
        stepDays += 1
      }
      summary.perType.steps = stepDays
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      summary.errors.push(`steps: ${errMsg}`)
      summary.perType.steps = 0
      if (isRateLimitErr(errMsg)) rateLimited = true
    }
    firstRead = false
  }

  for (const dataType of READ_SAMPLE_TYPES) {
    if (!firstRead) await sleepMs(READ_GAP_MS)
    firstRead = false
    const opt = PER_TYPE_OPTS[dataType]
    const windowHours = opts.windowDays ? opts.windowDays * 24 : opt?.windowHours ?? 48
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
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      summary.errors.push(`${dataType}: ${errMsg}`)
      summary.perType[dataType] = 0
      if (isRateLimitErr(errMsg)) rateLimited = true
    }
  }

  if (rateLimited) {
    summary.skippedReason = summary.skippedReason ?? 'rate-limited'
    writeRateLimitUntil(Date.now() + RATE_LIMIT_BACKOFF_MS)
  }

  const dedupedSamples = dedupeSamples(allSamples)
  const byDay = aggregateSamples(dedupedSamples)
  // Overlay the aggregate step totals onto the per-day rows. readSamples
  // no longer fetches steps, so aggregateSamples leaves steps null —
  // this is the single source of truth for the daily count.
  for (const [day, total] of Object.entries(stepsByDay)) {
    if (total <= 0) continue
    if (!byDay[day]) {
      byDay[day] = { date: day }
    }
    byDay[day].steps = Math.round(total)
  }
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
    // Build a partial-row payload that only includes the fields the
    // aggregator actually produced a value for. Earlier we always
    // emitted the full column set, including the nulls — and Supabase
    // upsert with onConflict translates each key in the payload into
    // an `excluded.col = ...` assignment in the ON CONFLICT DO UPDATE
    // clause. So a day where Health Connect happens to return only
    // step samples this round (because sleep / HR queries got
    // rate-limited, or the user hasn't synced their wearable yet)
    // ended up overwriting the previously-saved sleep_hours /
    // heart_rate / oxygen values with NULL. Excluding null keys from
    // the payload means Postgres just leaves those columns alone.
    .map((row) => {
      const out: Record<string, unknown> = { date: row.date }
      if (row.steps != null) out.steps = row.steps
      if (row.sleepHours != null) out.sleep_hours = row.sleepHours
      if (row.heartRateAvg != null) out.heart_rate_avg = row.heartRateAvg
      if (row.heartRateMax != null) out.heart_rate_max = row.heartRateMax
      if (row.heartRateMin != null) out.heart_rate_min = row.heartRateMin
      if (row.heartRateRest != null) out.heart_rate_rest = row.heartRateRest
      if (row.oxygenSaturationAvg != null) out.oxygen_saturation_avg = row.oxygenSaturationAvg
      return out
    })

  if (rowsToUpsert.length > 0) {
    const { error } = await supabase
      .from('health_data')
      .upsert(rowsToUpsert, { onConflict: 'date' })
    if (error) {
      summary.errors.push(`upsert: ${error.message}`)
      summary.ok = false
      return summary
    }
    summary.upsertedDates = rowsToUpsert.map((r) => r.date as string)
  }

  // If anything tripped a skippedReason (rate-limited, throttled,
  // unavailable, etc.) the sync isn't really "successful" even if no
  // exception bubbled up — and crucially, we shouldn't pin the
  // last-synced-at timestamp on a failed attempt because the
  // auto-sync throttle would then block the next 30 minutes of
  // retries. The UI ("⚠ 未完成: …") already handles the
  // ok=false + skippedReason combo.
  if (summary.skippedReason) {
    summary.ok = false
    return summary
  }

  // Clean run — clear any stale rate-limit backoff and arm the normal
  // 30-min auto-sync throttle.
  clearRateLimitBackoff()
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
