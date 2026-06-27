import { useCallback, useEffect, useState } from 'react'
import type { User } from '@supabase/supabase-js'
import { useNavigate } from 'react-router-dom'
import { Capacitor } from '@capacitor/core'
import { Health, type HealthDataType, type HealthSample } from '@capgo/capacitor-health'
import { supabase } from '../supabase/client'
import {
  hasUsageStatsPermission,
  openUsageStatsSettings,
  readDailyUsage,
  type DailyUsageResult,
} from '../storage/usageStatsNative'
import {
  readLastSyncedAt,
  rateLimitCooldownMinutesLeft,
  syncHealthDataToSupabase,
  type SyncSummary,
} from '../storage/healthSync'
import { computeMedianCycleFromHistory } from '../hooks/useHomeWidgetData'
import {
  EMOTIONS,
  getMood,
  getMoodEnabled,
  decayMoodToNow,
  fetchMoodHistory,
  type MoodState,
  type MoodHistoryRow,
} from '../storage/moodSystem'
import './HealthSyncPage.css'

// 各情绪进度条配色（仅展示用）。
const MOOD_COLORS: Record<string, string> = {
  joy: '#f2b705', sadness: '#6c8ebf', anger: '#e06666', jealous: '#c27ba0',
  longing: '#9b7ede', venting: '#5fb89a', secure: '#7baf6e', belonging: '#e8915b',
}

type Props = { user: User | null }

const REQUESTED_TYPES: HealthDataType[] = [
  'steps',
  'sleep',
  'heartRate',
  'restingHeartRate',
  'distance',
  'totalCalories',
  'oxygenSaturation',
]

const TYPE_LABELS: Record<HealthDataType, string> = {
  steps: 'Steps',
  sleep: 'Sleep',
  heartRate: '心率',
  restingHeartRate: 'Resting HR',
  distance: '距离',
  totalCalories: '总卡路里',
  oxygenSaturation: 'Blood O₂',
  calories: '卡路里',
  weight: '体重',
  respiratoryRate: '呼吸频率',
  heartRateVariability: '心率变异',
  vo2Max: 'VO₂ Max',
  bloodPressure: '血压',
  bloodGlucose: '血糖',
  bodyTemperature: '体温',
  height: '身高',
  flightsClimbed: '楼层',
  exerciseTime: '运动时长',
  distanceCycling: '骑行距离',
  bodyFat: '体脂',
  basalBodyTemperature: '基础体温',
  basalCalories: '基础代谢',
  mindfulness: '正念',
  workouts: '锻炼',
}

const formatSampleValue = (s: HealthSample): string => {
  if (s.dataType === 'sleep' && s.sleepState) {
    return `${s.sleepState} · ${Math.round(s.value)} ${s.unit}`
  }
  return `${Math.round(s.value * 100) / 100} ${s.unit}`
}

const formatLastSync = (ts: number | null) => {
  if (!ts) return 'Never synced'
  const delta = Date.now() - ts
  const mins = Math.floor(delta / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} 分钟前`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} 小时前`
  return new Date(ts).toLocaleString('zh-CN')
}

type TodayPreview = {
  date: string
  steps: number | null
  sleep_hours: number | null
  heart_rate_avg: number | null
  heart_rate_max: number | null
  heart_rate_min: number | null
  heart_rate_rest: number | null
  oxygen_saturation_avg: number | null
}

const HealthSyncPage = ({ user }: Props) => {
  const navigate = useNavigate()
  const isNative = Capacitor.getPlatform() === 'android'

  // 小机的情绪（只读展示）：当前值衰减到此刻 + 最近变化历史。
  const [mood, setMood] = useState<MoodState | null>(null)
  const [moodHistory, setMoodHistory] = useState<MoodHistoryRow[]>([])

  const [log, setLog] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [available, setAvailable] = useState<boolean | null>(null)
  const [samples, setSamples] = useState<HealthSample[]>([])
  const [lastSync, setLastSync] = useState<number | null>(readLastSyncedAt())
  const [lastSummary, setLastSummary] = useState<SyncSummary | null>(null)
  const [todayRow, setTodayRow] = useState<TodayPreview | null>(null)
  const [diagOpen, setDiagOpen] = useState(false)

  // Screen-time section state — populated from the custom UsageStats
  // Capacitor plugin (Android-only, requires the PACKAGE_USAGE_STATS
  // AppOp to be granted in system Settings → 使用情况).
  const [usageGranted, setUsageGranted] = useState<boolean | null>(null)
  const [usageData, setUsageData] = useState<DailyUsageResult | null>(null)

  // Period tracking section state — pulled directly from
  // period_tracking. We surface the most-recent row and compute
  // "today is day N" + "next due in M days" client-side.
  type PeriodRow = {
    start_date: string
    end_date: string | null
    cycle_length: number | null
    notes: string | null
  }
  const [periodRow, setPeriodRow] = useState<PeriodRow | null>(null)
  // Last 6 starts for adaptive cycle-length derivation. Same shape as
  // the home widget data hook so the UI here matches the home page.
  const [periodHistory, setPeriodHistory] = useState<Array<{ start_date: string }>>([])

  const pushLog = useCallback(
    (line: string) =>
      setLog((prev) => [`${new Date().toLocaleTimeString()}  ${line}`, ...prev].slice(0, 50)),
    [],
  )

  const refreshTodayRow = useCallback(async () => {
    if (!supabase) return
    const now = new Date()
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const { data, error } = await supabase
      .from('health_data')
      .select('date,steps,sleep_hours,heart_rate_avg,heart_rate_max,heart_rate_min,heart_rate_rest,oxygen_saturation_avg')
      .eq('date', today)
      .maybeSingle()
    if (!error) {
      setTodayRow((data as TodayPreview | null) ?? null)
    }
  }, [])

  useEffect(() => {
    void refreshTodayRow()
  }, [refreshTodayRow])

  // Load screen-time + period rows on mount and whenever we refresh
  // the today block (e.g. after a sync). Both are best-effort —
  // missing data degrades to "还没记录" placeholders.
  const refreshUsage = useCallback(async () => {
    if (!isNative) {
      setUsageGranted(false)
      setUsageData(null)
      return
    }
    const granted = await hasUsageStatsPermission()
    setUsageGranted(granted)
    if (!granted) {
      setUsageData(null)
      return
    }
    const result = await readDailyUsage()
    setUsageData(result)
  }, [isNative])

  const refreshPeriod = useCallback(async () => {
    if (!supabase) return
    const { data, error } = await supabase
      .from('period_tracking')
      .select('start_date,end_date,cycle_length,notes')
      .order('start_date', { ascending: false })
      .order('created_at', { ascending: false, nullsFirst: false })
      .limit(6)
    if (!error) {
      const rows = (data as PeriodRow[] | null) ?? []
      setPeriodRow(rows[0] ?? null)
      setPeriodHistory(rows)
    }
  }, [])

  useEffect(() => {
    void refreshUsage()
    void refreshPeriod()
  }, [refreshUsage, refreshPeriod])

  // 情绪：当前值每 20 秒衰减刷新一次（纯本地、不发请求）；历史拉一次。
  useEffect(() => {
    if (!getMoodEnabled()) return
    const tick = () => setMood(decayMoodToNow(getMood()))
    tick()
    const id = window.setInterval(tick, 20_000)
    if (user) void fetchMoodHistory(user.id, 12).then(setMoodHistory)
    return () => window.clearInterval(id)
  }, [user])

  // Derived period metrics for the section render. Hard-codes a 28-day
  // fallback cycle when the user hasn't supplied one (typical adult
  // baseline; the user can still override per row via cycle_length).
  const periodMetrics = (() => {
    if (!periodRow) return null
    const start = new Date(periodRow.start_date)
    if (Number.isNaN(start.getTime())) return null
    const today = new Date()
    const oneDay = 24 * 60 * 60 * 1000
    const daysSinceStart = Math.floor(
      (Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) -
        Date.UTC(start.getFullYear(), start.getMonth(), start.getDate())) /
        oneDay,
    )
    // Adaptive cycle length: median of historical gaps when we have
    // ≥2 cycles to compare; otherwise fall back to whatever Claude
    // logged on this row; finally 28d. Same priority order as the
    // home widget hook so HealthSyncPage + widget stay in sync.
    const adaptive = computeMedianCycleFromHistory(periodHistory)
    let cycleLength: number
    let cycleSource: 'history' | 'logged' | 'default'
    let cycleSampleSize = 0
    if (adaptive) {
      cycleLength = adaptive.median
      cycleSource = 'history'
      cycleSampleSize = adaptive.sampleSize
    } else if (periodRow.cycle_length && periodRow.cycle_length > 0) {
      cycleLength = periodRow.cycle_length
      cycleSource = 'logged'
    } else {
      cycleLength = 28
      cycleSource = 'default'
    }
    const daysToNext = cycleLength - daysSinceStart
    // Match the widget data hook — typical menstruation lasts < 7
    // days, so a row without end_date that's far in the past
    // shouldn't still report 经期中.
    let isInPeriod: boolean
    if (periodRow.end_date) {
      const [ey, em, ed] = periodRow.end_date.split('-').map(Number)
      const endTime = Date.UTC(ey, em - 1, ed)
      const todayStart = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())
      isInPeriod = Number.isFinite(endTime) && todayStart <= endTime
    } else {
      isInPeriod = daysSinceStart >= 0 && daysSinceStart < 7
    }
    let phase: string
    if (isInPeriod) {
      phase = 'Period'
    } else if (daysSinceStart < 12) {
      phase = 'Follicular'
    } else if (daysSinceStart >= 12 && daysSinceStart <= 16) {
      phase = 'Ovulation'
    } else {
      phase = 'Luteal'
    }
    const nextDate = new Date(start.getTime() + cycleLength * oneDay)
    return {
      daysSinceStart,
      daysToNext,
      phase,
      cycleLength,
      cycleSource,
      cycleSampleSize,
      nextDate,
    }
  })()

  const handleSyncNow = async () => {
    if (!isNative) {
      pushLog('⚠️ Cannot sync on web — use APK')
      return
    }
    setBusy(true)
    try {
      const summary = await syncHealthDataToSupabase({ force: true })
      setLastSummary(summary)
      setLastSync(readLastSyncedAt())
      const counts = Object.entries(summary.perType)
        .filter(([, n]) => n > 0)
        .map(([t, n]) => `${TYPE_LABELS[t as HealthDataType] ?? t} ${n}`)
        .join(' · ')
      if (summary.ok) {
        pushLog(`✅ Synced: ${summary.upsertedDates.length} days stored${counts ? ' · ' + counts : ''}`)
      } else {
        // Translate internal reason codes to actionable messages where
        // the user actually has something to do — "rate-limited" is
        // the only case worth phrasing as a wait-and-retry hint, the
        // rest just surface the code so we can debug from the log.
        const cooldownLeft = rateLimitCooldownMinutesLeft()
        const reasonText =
          summary.skippedReason === 'rate-limited'
            ? cooldownLeft > 0
              ? `Health Connect rate-limited — cooldown ~${cooldownLeft} min (Please wait for quota recovery)`
              : 'Health Connect rate-limited — wait a few minutes'
            : summary.skippedReason === 'throttled'
              ? 'Synced recently (< 30 min ago) — skipped (force button bypasses)'
              : (summary.skippedReason ?? '未知')
        // Even with skippedReason set we may have partial success — the
        // parallel-read path saves whatever types didn't rate-limit.
        // Show those counts so the user can see what made it through.
        const partialNote =
          summary.upsertedDates.length > 0
            ? `（部分入库 ${summary.upsertedDates.length} 天${counts ? ' · ' + counts : ''}）`
            : ''
        pushLog(`⚠️ Sync incomplete: ${reasonText}${partialNote}`)
      }
      for (const err of summary.errors) {
        pushLog(`  · ${err}`)
      }
      await refreshTodayRow()
    } catch (err) {
      pushLog(`同步失败: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  // ---- Diagnostic helpers (lower section) ----
  const handleAvailability = async () => {
    if (!isNative) {
      pushLog('⚠️ Web 端无法调用 Health Connect')
      return
    }
    setBusy(true)
    try {
      const res = await Health.isAvailable()
      setAvailable(res.available)
      pushLog(`可用性 = ${res.available}${res.reason ? ` (${res.reason})` : ''} platform=${res.platform ?? 'n/a'}`)
    } catch (err) {
      pushLog(`检查失败: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const handleAuthorize = async () => {
    if (!isNative) {
      pushLog('⚠️ Web 端无法授权')
      return
    }
    setBusy(true)
    try {
      const status = await Health.requestAuthorization({ read: REQUESTED_TYPES })
      pushLog(
        `授权完成: 允许 [${status.readAuthorized.join(', ') || '无'}]` +
          ` 拒绝 [${status.readDenied.join(', ') || '无'}]`,
      )
    } catch (err) {
      pushLog(`授权失败: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const readType = async (dataType: HealthDataType, hours: number) => {
    if (!isNative) {
      pushLog('⚠️ Web 端无法读取')
      return
    }
    setBusy(true)
    try {
      const endDate = new Date()
      const startDate = new Date(endDate.getTime() - hours * 3600 * 1000)
      const res = await Health.readSamples({
        dataType,
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
      })
      setSamples(res.samples)
      pushLog(`✅ ${TYPE_LABELS[dataType] ?? dataType}: 拿到 ${res.samples.length} 条样本`)
    } catch (err) {
      pushLog(`❌ ${TYPE_LABELS[dataType] ?? dataType} 读取失败: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="app-shell">
      <header className="page-header-bar">
        <button type="button" className="page-back-btn" onClick={() => navigate('/')}>‹</button>
        <h1 className="ui-title">Health Sync</h1>
        <span className="page-header-spacer" aria-hidden="true" />
      </header>
      <main className="app-shell__content health-sync">
        {getMoodEnabled() && mood ? (
          <section className="glass-card mood-panel">
            <h2>小机的心情</h2>
            {mood.tone ? <p className="mood-panel__tone">「{mood.tone}」</p> : null}
            <div className="mood-panel__bars">
              {EMOTIONS.map((e) => {
                const v = Math.round(mood[e.key])
                return (
                  <div className="mood-panel__row" key={e.key}>
                    <span className="mood-panel__label">{e.label}</span>
                    <span className="mood-panel__track">
                      <span
                        className="mood-panel__fill"
                        style={{ width: `${v}%`, background: MOOD_COLORS[e.key] ?? '#9aa' }}
                      />
                    </span>
                    <span className="mood-panel__num">{v}</span>
                  </div>
                )
              })}
            </div>
            {moodHistory.length > 0 ? (
              <details className="mood-panel__history">
                <summary>心情变化（最近 {moodHistory.length} 条）</summary>
                <ul>
                  {moodHistory.map((h, i) => (
                    <li key={i}>
                      <span className="mood-panel__hist-time">
                        {new Date(h.createdAt).toLocaleString('zh-CN', {
                          month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
                        })}
                      </span>
                      <span className="mood-panel__hist-note">{h.note || h.tone || '—'}</span>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            <p className="mood-panel__hint">这是小机自己的情绪，会随相处自然起落 · 你只能看 🦊</p>
          </section>
        ) : null}

        <section className="glass-card health-sync__sync-card">
          <header className="health-sync__sync-header">
            <div>
              <h2>Sync from Health Connect</h2>
              <p className="health-sync__sync-meta">Last synced: {formatLastSync(lastSync)}</p>
            </div>
            <button
              type="button"
              className="primary health-sync__sync-btn"
              disabled={busy || !isNative}
              onClick={() => void handleSyncNow()}
            >
              {busy ? 'Syncing…' : 'Sync Now'}
            </button>
          </header>
          {!isNative ? (
            <p className="health-sync__warn">⚠️ Not available on web — sync from APK</p>
          ) : null}
          {lastSummary && lastSummary.ok ? (
            <p className="health-sync__sync-result">
              ✓ 写入 {lastSummary.upsertedDates.length} 天：{lastSummary.upsertedDates.join('、') || '无新数据'}
            </p>
          ) : null}
          {lastSummary && !lastSummary.ok && lastSummary.skippedReason ? (
            <p className="health-sync__sync-result warn">
              ⚠️ Sync incomplete:{' '}
              {lastSummary.skippedReason === 'rate-limited'
                ? rateLimitCooldownMinutesLeft() > 0
                  ? `Health Connect rate-limited — ~${rateLimitCooldownMinutesLeft()} min until recovery (Please wait for quota recovery)`
                  : 'Health Connect rate-limited — wait a few minutes'
                : lastSummary.skippedReason === 'throttled'
                  ? 'Synced recently (< 30 min ago) — skipped'
                  : lastSummary.skippedReason}
            </p>
          ) : null}
        </section>

        <section className="glass-card health-sync__today">
          <h2>Today</h2>
          {todayRow ? (
            <div className="health-sync__today-grid">
              <div>
                <span className="label">Steps</span>
                <span className="value">{todayRow.steps ?? '—'}</span>
              </div>
              <div>
                <span className="label">Sleep</span>
                <span className="value">{todayRow.sleep_hours != null ? `${todayRow.sleep_hours} h` : '—'}</span>
              </div>
              <div>
                <span className="label">Avg Heart Rate</span>
                <span className="value">{todayRow.heart_rate_avg ?? '—'}</span>
              </div>
              <div>
                <span className="label">HR Range</span>
                <span className="value">
                  {todayRow.heart_rate_min != null && todayRow.heart_rate_max != null
                    ? todayRow.heart_rate_min === todayRow.heart_rate_max
                      // Only one sample synced today — "62–62" reads as
                      // a bug. Show single value with hint instead.
                      ? `${todayRow.heart_rate_min}（单次）`
                      : `${todayRow.heart_rate_min}–${todayRow.heart_rate_max}`
                    : '—'}
                </span>
              </div>
              <div>
                <span className="label">Resting HR</span>
                <span className="value">{todayRow.heart_rate_rest ?? '—'}</span>
              </div>
              <div>
                <span className="label">Blood O₂</span>
                <span className="value">{todayRow.oxygen_saturation_avg != null ? `${todayRow.oxygen_saturation_avg}%` : '—'}</span>
              </div>
            </div>
          ) : (
            <p className="health-sync__empty">
              No data yet today. Sync from Health Sync in the morning.
            </p>
          )}
        </section>

        <section className="glass-card health-sync__usage">
          <h2>📱 Screen Time</h2>
          {!isNative ? (
            <p className="health-sync__empty">Screen time unavailable on web — use APK.</p>
          ) : usageGranted === false ? (
            <div className="health-sync__usage-prompt">
              <p className="health-sync__empty">
                Usage stats permission not granted. Grant permission to see per-app usage.
              </p>
              <button
                type="button"
                className="primary"
                onClick={() => {
                  void openUsageStatsSettings()
                }}
              >
                Open Settings
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => void refreshUsage()}
              >
                Authorized — recheck
              </button>
            </div>
          ) : !usageData || usageData.total_minutes === 0 ? (
            <p className="health-sync__empty">No usage recorded today.</p>
          ) : (
            <div className="health-sync__usage-body">
              <div className="health-sync__usage-total">
                <span className="value">{Math.floor(usageData.total_minutes / 60)}h {usageData.total_minutes % 60}m</span>
                <span className="label">Total today</span>
              </div>
              <ol className="health-sync__usage-apps">
                {usageData.top_apps.map((app) => {
                  const hours = Math.floor(app.minutes / 60)
                  const mins = app.minutes % 60
                  return (
                    <li key={app.name}>
                      <span className="name">{app.name}</span>
                      <span className="dur">{hours > 0 ? `${hours}h ${mins}m` : `${mins}m`}</span>
                    </li>
                  )
                })}
              </ol>
            </div>
          )}
        </section>

        <section className="glass-card health-sync__period">
          <h2>🌸 Period Tracking</h2>
          {!periodMetrics ? (
            <p className="health-sync__empty">
              No period records yet. Ask Claude to help, or add a row to period_tracking in Supabase.
            </p>
          ) : (
            <div className="health-sync__period-body">
              <div className="health-sync__period-headline">
                <strong>第 {periodMetrics.daysSinceStart + 1} 天</strong>
                <span className="phase">{periodMetrics.phase}</span>
              </div>
              <div className="health-sync__period-meta">
                <div>
                  <span className="label">Next expected</span>
                  <span className="value">
                    {periodMetrics.daysToNext > 0
                      ? `${periodMetrics.daysToNext} 天后（${periodMetrics.nextDate.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })}）`
                      : periodMetrics.daysToNext === 0
                        ? '今天'
                        : `已超出 ${-periodMetrics.daysToNext} 天`}
                  </span>
                </div>
                <div>
                  <span className="label">Avg cycle</span>
                  <span className="value">
                    {periodMetrics.cycleLength} 天
                    {periodMetrics.cycleSource === 'history'
                      ? `（按你最近 ${periodMetrics.cycleSampleSize + 1} 个周期算的）`
                      : periodMetrics.cycleSource === 'logged'
                        ? 'Manual entry'
                        : '（默认值，需 ≥2 个周期才能自适应）'}
                  </span>
                </div>
              </div>
            </div>
          )}
        </section>

        <details className="glass-card health-sync__diag" open={diagOpen} onToggle={(e) => setDiagOpen((e.currentTarget as HTMLDetailsElement).open)}>
          <summary>🔧 Diagnostic Tools</summary>
          <p className="health-sync__hint">
            如果上面同步没反应，按顺序点：① 检查可用 → ② 请求授权（系统弹窗）→ ③ 读样本看是否拿到数据。
          </p>
          <div className="health-sync__diag-actions">
            <button type="button" className="ghost" disabled={busy} onClick={() => void handleAvailability()}>
              ① Check Health Connect{available === true ? ' ✅' : available === false ? ' ❌' : ''}
            </button>
            <button type="button" className="ghost" disabled={busy} onClick={() => void handleAuthorize()}>
              ② Request Permission
            </button>
            <div className="health-sync__row">
              <button type="button" className="ghost" disabled={busy} onClick={() => void readType('steps', 24)}>
                Read 24h steps
              </button>
              <button type="button" className="ghost" disabled={busy} onClick={() => void readType('sleep', 48)}>
                Read 48h sleep
              </button>
              <button type="button" className="ghost" disabled={busy} onClick={() => void readType('heartRate', 24)}>
                Read 24h HR
              </button>
              <button type="button" className="ghost" disabled={busy} onClick={() => void readType('oxygenSaturation', 24)}>
                Read 24h SpO₂
              </button>
            </div>
          </div>
          {samples.length > 0 ? (
            <div className="health-sync__samples">
              <h3>Raw samples ({samples.length})</h3>
              <ol>
                {samples.slice(0, 30).map((s, i) => (
                  <li key={`${s.platformId ?? i}`}>
                    <strong>{TYPE_LABELS[s.dataType] ?? s.dataType}</strong>{' '}
                    {formatSampleValue(s)}
                    <span className="health-sync__sample-meta">
                      · {new Date(s.startDate).toLocaleString('zh-CN')}
                      {s.sourceName ? ` · ${s.sourceName}` : ''}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
        </details>

        <section className="glass-card health-sync__log">
          <h2>Log</h2>
          {log.length === 0 ? <p className="health-sync__empty">No operations yet</p> : null}
          <pre>
            {log.map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </pre>
        </section>
      </main>
    </div>
  )
}

export default HealthSyncPage
