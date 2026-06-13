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
// deadline auto-sync stays quiet so we don't re-hammer a pinned quota
// (maybeAutoSyncHealth fires on mount + every visibilitychange, so
// without a backoff a single rate-limit turned every app-foreground into
// another quota-draining retry). Manual `force` sync always bypasses it.
const RATE_LIMIT_BACKOFF_KEY = 'nimbus_health_rate_limit_until_v1'
// EXPONENTIAL backoff, not a flat wait. The old flat 3 min punished the
// common case — a single transient rate-limit (e.g. Health Sync happened
// to be writing at the same moment) — exactly as hard as a genuinely
// exhausted quota, so the health page felt "stuck" for 3 min after every
// little blip. Now we scale with the number of *consecutive* rate-limited
// syncs: 1st blip waits just 60s, then 2m, 4m, capped at 5m, and the
// count resets the moment a sync comes back clean. Transient blips
// recover fast; only a persistently saturated quota earns the long wait.
const RATE_LIMIT_COUNT_KEY = 'nimbus_health_rate_limit_count_v1'
const RATE_LIMIT_BACKOFF_BASE_MS = 60 * 1000 // 1 minute (first blip)
const RATE_LIMIT_BACKOFF_MAX_MS = 5 * 60 * 1000 // 5 minutes (cap)

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

const readRateLimitCount = (): number => {
  if (typeof window === 'undefined') return 0
  const raw = window.localStorage.getItem(RATE_LIMIT_COUNT_KEY)
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : 0
}

// Clear both the cooldown deadline and the consecutive-failure counter.
// Called on a clean sync and at the start of a manual force sync, so the
// next rate-limit (if any) starts the exponential ramp from 60s again.
const clearRateLimitBackoff = () => {
  if (typeof window === 'undefined') return
  window.localStorage.removeItem(RATE_LIMIT_BACKOFF_KEY)
  window.localStorage.removeItem(RATE_LIMIT_COUNT_KEY)
}

// Record a rate-limit hit: bump the consecutive counter and arm a cooldown
// that grows with it — 60s, 2m, 4m, capped at 5m.
const armRateLimitBackoff = () => {
  if (typeof window === 'undefined') return
  const count = readRateLimitCount() + 1
  const backoff = Math.min(
    RATE_LIMIT_BACKOFF_BASE_MS * 2 ** (count - 1),
    RATE_LIMIT_BACKOFF_MAX_MS,
  )
  window.localStorage.setItem(RATE_LIMIT_COUNT_KEY, String(count))
  writeRateLimitUntil(Date.now() + backoff)
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

// Types read via readSamples (raw record list). Steps AND heart rate are
// handled separately through the aggregate API — see
// syncHealthDataToSupabase. Steps because a daily *total* must not be
// truncated by a record limit; heart rate because its daily min/max/avg
// must see the WHOLE day, not just the newest ~100 samples readSamples
// returns (a wearable logging HR every few seconds fits only the last
// few minutes in 100 samples, so min/max came out absurdly narrow and
// earlier-in-the-day readings were missing). Health Connect aggregates
// HeartRateRecord natively (BPM_AVG/MIN/MAX), exposed by the plugin as
// queryAggregated heartRate + average/min/max.
const READ_SAMPLE_TYPES: HealthDataType[] = [
  'sleep',
  'restingHeartRate',
  'oxygenSaturation',
]

// Lesson from a long regression hunt: the ORIGINAL working sync (commit
// 41a5996) just called Health.readSamples with NO `limit`. The Capgo
// plugin then uses DEFAULT_LIMIT=100, which means pageSize=100 and
// exactly ONE Health Connect IPC call per type. Five types → five IPC
// calls total, far under the rate limiter — and that version worked.
//
// A later "fix" added `limit: 1500` to try to land "a whole day's
// records", not noticing the plugin paginates pageSize=500 and fires
// pages back-to-back with no gap. That turned each high-cap type into
// a 3-IPC burst → 5 types → ~9 near-simultaneous reads → tripping
// Health Connect's periodic QPS limiter on every sync. Every "fix"
// since then was treating the symptom of a regression introduced by
// the cap itself.
//
// So: drop the cap. Averages over the newest ~100 samples are fine
// (newest-first ordering means today is covered). Sleep sessions and
// resting HR are sparse anyway. For the one type that genuinely needs
// a full-day TOTAL (steps), we use queryAggregated, which doesn't
// paginate over records at all.
const PER_TYPE_WINDOW_HOURS: Record<HealthDataType, number> = {
  sleep: 48,
  restingHeartRate: 72,
  oxygenSaturation: 48,
} as Record<HealthDataType, number>

// Gap between successive Health Connect IPC calls. A full sync now fires
// 7 calls (steps + heart-rate avg/min/max aggregates + 3 readSamples).
// Health Connect's limiter is a refilling token bucket, so a tight burst
// is what trips it — especially when an external app (Huawei Health Sync)
// is consuming the same quota. 250ms between calls spreads the burst over
// ~1.5s, which measurably cuts how often we hit the limit, while still
// being invisible to the user (the whole sync is background + async).
const READ_GAP_MS = 250

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
//  - heartRate:         NOTE: no longer fed here — HR avg/min/max now come
//                       from the aggregate API (see syncHealthDataToSupabase).
//                       The case below is kept harmless but unreached.
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

  // Rate-limit backoff gate. The previous version of this code blocked
  // EVEN manual force syncs during the cooldown — that was defensive
  // armor against an earlier self-inflicted bug (oversized `limit` →
  // pagination burst → real rate-limit hits). That bug is fixed now
  // (each readSamples call is one IPC), so a manual sync is essentially
  // never the thing pinning the quota; instead the lock kept the user
  // staring at "限速冷却中" with no way out. So:
  //  - Manual sync (force=true): always proceed. We even clear the
  //    backoff stamp on the way in, since the user explicitly asked
  //    for a retry. If THIS attempt then trips a real rate-limit, the
  //    catch block below will arm a fresh backoff.
  //  - Auto sync (background): still gated, so we don't auto-hammer
  //    Health Connect when an external process (Huawei Health Sync etc.)
  //    has actually exhausted the quota.
  if (opts.force) {
    clearRateLimitBackoff()
  } else {
    const backoffUntil = readRateLimitUntil()
    if (backoffUntil && Date.now() < backoffUntil) {
      summary.skippedReason = 'rate-limited'
      return summary
    }
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

  // Steps: today AND yesterday — two independent single-day calls with
  // a 250ms gap between them. A multi-day bucket window would have the
  // Kotlin plugin firing buckets back-to-back with no gap (burst); two
  // explicit single-day calls let us insert our own READ_GAP_MS gap.
  const stepsByDay: Record<string, number> = {}
  for (const daysAgo of [0, 1]) {
    if (daysAgo > 0) await sleepMs(READ_GAP_MS)
    const dayStart = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate() - daysAgo)
    const dayEnd = daysAgo === 0 ? endDate : new Date(dayStart.getTime() + 24 * 3600 * 1000)
    // The bucket we asked for. Defensive: only accept samples whose day
    // matches this — guards against the plugin emitting a spurious empty
    // boundary bucket for the adjacent day.
    const expectedDay = isoToLocalDate(dayStart.toISOString())
    try {
      const agg = await Health.queryAggregated({
        dataType: 'steps',
        startDate: dayStart.toISOString(),
        endDate: dayEnd.toISOString(),
        bucket: 'day',
        aggregation: 'sum',
      })
      for (const s of agg.samples) {
        const day = isoToLocalDate(s.startDate)
        if (!day || day !== expectedDay) continue
        stepsByDay[day] = s.value
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      summary.errors.push(`steps(${daysAgo === 0 ? 'today' : 'yesterday'}): ${errMsg}`)
      if (isRateLimitErr(errMsg)) rateLimited = true
    }
  }
  summary.perType.steps = Object.keys(stepsByDay).length
  firstRead = false

  // Heart rate avg/min/max: today AND yesterday, each as a separate
  // single-day queryAggregated call (same burst-avoidance reason as steps).
  // 3 metrics × 2 days = 6 calls, each preceded by a 250ms gap.
  const hrByDay: Record<string, { avg?: number; min?: number; max?: number }> = {}
  const hrMetrics: Array<['average' | 'min' | 'max', 'avg' | 'min' | 'max']> = [
    ['average', 'avg'],
    ['min', 'min'],
    ['max', 'max'],
  ]
  for (const daysAgo of [0, 1]) {
    const dayStart = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate() - daysAgo)
    const dayEnd = daysAgo === 0 ? endDate : new Date(dayStart.getTime() + 24 * 3600 * 1000)
    const expectedDay = isoToLocalDate(dayStart.toISOString())
    for (const [aggregation, key] of hrMetrics) {
      await sleepMs(READ_GAP_MS)
      try {
        const agg = await Health.queryAggregated({
          dataType: 'heartRate',
          startDate: dayStart.toISOString(),
          endDate: dayEnd.toISOString(),
          bucket: 'day',
          aggregation,
        })
        for (const s of agg.samples) {
          const day = isoToLocalDate(s.startDate)
          // Only the day we asked for — never let a boundary bucket from
          // the yesterday call overwrite today's real value (and vice versa).
          if (!day || day !== expectedDay) continue
          if (!hrByDay[day]) hrByDay[day] = {}
          hrByDay[day][key] = s.value
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        summary.errors.push(`heartRate(${daysAgo === 0 ? 'today' : 'yesterday'},${aggregation}): ${errMsg}`)
        if (isRateLimitErr(errMsg)) rateLimited = true
      }
    }
  }
  summary.perType.heartRate = Object.keys(hrByDay).length

  for (const dataType of READ_SAMPLE_TYPES) {
    if (!firstRead) await sleepMs(READ_GAP_MS)
    firstRead = false
    const windowHours = opts.windowDays
      ? opts.windowDays * 24
      : PER_TYPE_WINDOW_HOURS[dataType] ?? 48
    const startDate = new Date(endDate.getTime() - windowHours * 3600 * 1000)
    try {
      // No `limit` — Capgo's DEFAULT_LIMIT=100 keeps each call to a
      // single Health Connect IPC. See the comment on PER_TYPE_WINDOW_HOURS
      // above for why this is the right shape.
      const res = await Health.readSamples({
        dataType,
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
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
    armRateLimitBackoff()
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
  // Overlay aggregate heart-rate metrics (today + yesterday).
  for (const [hrDay, hrData] of Object.entries(hrByDay)) {
    if (!byDay[hrDay]) byDay[hrDay] = { date: hrDay }
    if (hrData.avg != null) byDay[hrDay].heartRateAvg = Math.round(hrData.avg)
    if (hrData.min != null) byDay[hrDay].heartRateMin = Math.round(hrData.min)
    if (hrData.max != null) byDay[hrDay].heartRateMax = Math.round(hrData.max)
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
