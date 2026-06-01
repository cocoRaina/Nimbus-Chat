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
  syncHealthDataToSupabase,
  type SyncSummary,
} from '../storage/healthSync'
import './HealthSyncPage.css'

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
  steps: '步数',
  sleep: '睡眠',
  heartRate: '心率',
  restingHeartRate: '静息心率',
  distance: '距离',
  totalCalories: '总卡路里',
  oxygenSaturation: '血氧',
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
  if (!ts) return '从未同步'
  const delta = Date.now() - ts
  const mins = Math.floor(delta / 60000)
  if (mins < 1) return '刚刚'
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

const HealthSyncPage = ({ user: _user }: Props) => {
  const navigate = useNavigate()
  const isNative = Capacitor.getPlatform() === 'android'

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
      .limit(1)
      .maybeSingle()
    if (!error) {
      setPeriodRow((data as PeriodRow | null) ?? null)
    }
  }, [])

  useEffect(() => {
    void refreshUsage()
    void refreshPeriod()
  }, [refreshUsage, refreshPeriod])

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
    const cycleLength = periodRow.cycle_length ?? 28
    const daysToNext = cycleLength - daysSinceStart
    let phase: string
    if (periodRow.end_date == null) {
      phase = '经期中'
    } else if (daysSinceStart < 12) {
      phase = '滤泡期'
    } else if (daysSinceStart >= 12 && daysSinceStart <= 16) {
      phase = '排卵期'
    } else {
      phase = '黄体期'
    }
    const nextDate = new Date(start.getTime() + cycleLength * oneDay)
    return { daysSinceStart, daysToNext, phase, cycleLength, nextDate }
  })()

  const handleSyncNow = async () => {
    if (!isNative) {
      pushLog('⚠️ Web 端无法同步，请用 APK')
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
        pushLog(`✅ 同步成功：${summary.upsertedDates.length} 天入库${counts ? ' · ' + counts : ''}`)
      } else {
        pushLog(`⚠️ 同步未完成：${summary.skippedReason ?? '未知'}`)
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
        <button type="button" className="ghost" onClick={() => navigate('/')}>
          返回聊天
        </button>
        <h1 className="ui-title">健康同步</h1>
        <span className="page-header-spacer" aria-hidden="true" />
      </header>
      <main className="app-shell__content health-sync">
        <section className="glass-card health-sync__sync-card">
          <header className="health-sync__sync-header">
            <div>
              <h2>从 Health Connect 拉取</h2>
              <p className="health-sync__sync-meta">上次同步：{formatLastSync(lastSync)}</p>
            </div>
            <button
              type="button"
              className="primary health-sync__sync-btn"
              disabled={busy || !isNative}
              onClick={() => void handleSyncNow()}
            >
              {busy ? '同步中…' : '立即同步'}
            </button>
          </header>
          {!isNative ? (
            <p className="health-sync__warn">⚠️ Web 端不可用，请在 APK 里同步</p>
          ) : null}
          {lastSummary && lastSummary.ok ? (
            <p className="health-sync__sync-result">
              ✓ 写入 {lastSummary.upsertedDates.length} 天：{lastSummary.upsertedDates.join('、') || '无新数据'}
            </p>
          ) : null}
          {lastSummary && !lastSummary.ok && lastSummary.skippedReason ? (
            <p className="health-sync__sync-result warn">⚠ 未完成：{lastSummary.skippedReason}</p>
          ) : null}
        </section>

        <section className="glass-card health-sync__today">
          <h2>今天</h2>
          {todayRow ? (
            <div className="health-sync__today-grid">
              <div>
                <span className="label">步数</span>
                <span className="value">{todayRow.steps ?? '—'}</span>
              </div>
              <div>
                <span className="label">睡眠</span>
                <span className="value">{todayRow.sleep_hours != null ? `${todayRow.sleep_hours} h` : '—'}</span>
              </div>
              <div>
                <span className="label">平均心率</span>
                <span className="value">{todayRow.heart_rate_avg ?? '—'}</span>
              </div>
              <div>
                <span className="label">心率范围</span>
                <span className="value">
                  {todayRow.heart_rate_min != null && todayRow.heart_rate_max != null
                    ? `${todayRow.heart_rate_min}–${todayRow.heart_rate_max}`
                    : '—'}
                </span>
              </div>
              <div>
                <span className="label">静息心率</span>
                <span className="value">{todayRow.heart_rate_rest ?? '—'}</span>
              </div>
              <div>
                <span className="label">血氧</span>
                <span className="value">{todayRow.oxygen_saturation_avg != null ? `${todayRow.oxygen_saturation_avg}%` : '—'}</span>
              </div>
            </div>
          ) : (
            <p className="health-sync__empty">
              今天还没数据。早上记得开一下 Health Sync 把华为运动健康的数据搬到 Health Connect，再点上面"立即同步"。
            </p>
          )}
        </section>

        <section className="glass-card health-sync__usage">
          <h2>📱 屏幕使用时间</h2>
          {!isNative ? (
            <p className="health-sync__empty">Web 端无法读取屏幕时间，请用 APK。</p>
          ) : usageGranted === false ? (
            <div className="health-sync__usage-prompt">
              <p className="health-sync__empty">
                还没授权读取「使用情况访问权限」。授权后才能看到今天每个 app 的使用时长。
              </p>
              <button
                type="button"
                className="primary"
                onClick={() => {
                  void openUsageStatsSettings()
                }}
              >
                打开系统设置授权
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => void refreshUsage()}
              >
                我已授权，重新检查
              </button>
            </div>
          ) : !usageData || usageData.total_minutes === 0 ? (
            <p className="health-sync__empty">今天还没记录到使用时间。</p>
          ) : (
            <div className="health-sync__usage-body">
              <div className="health-sync__usage-total">
                <span className="value">{Math.floor(usageData.total_minutes / 60)}h {usageData.total_minutes % 60}m</span>
                <span className="label">今日总时长</span>
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
          <h2>🌸 经期跟踪</h2>
          {!periodMetrics ? (
            <p className="health-sync__empty">
              还没记录过经期。让 Claude 帮你记，或者去 Supabase 表里手动加 period_tracking 一行。
            </p>
          ) : (
            <div className="health-sync__period-body">
              <div className="health-sync__period-headline">
                <strong>第 {periodMetrics.daysSinceStart + 1} 天</strong>
                <span className="phase">{periodMetrics.phase}</span>
              </div>
              <div className="health-sync__period-meta">
                <div>
                  <span className="label">下次预计</span>
                  <span className="value">
                    {periodMetrics.daysToNext > 0
                      ? `${periodMetrics.daysToNext} 天后（${periodMetrics.nextDate.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })}）`
                      : periodMetrics.daysToNext === 0
                        ? '今天'
                        : `已超出 ${-periodMetrics.daysToNext} 天`}
                  </span>
                </div>
                <div>
                  <span className="label">平均周期</span>
                  <span className="value">{periodMetrics.cycleLength} 天</span>
                </div>
              </div>
              {periodRow?.notes ? (
                <p className="health-sync__period-notes">{periodRow.notes}</p>
              ) : null}
            </div>
          )}
        </section>

        <details className="glass-card health-sync__diag" open={diagOpen} onToggle={(e) => setDiagOpen((e.currentTarget as HTMLDetailsElement).open)}>
          <summary>🔧 诊断工具</summary>
          <p className="health-sync__hint">
            如果上面同步没反应，按顺序点：① 检查可用 → ② 请求授权（系统弹窗）→ ③ 读样本看是否拿到数据。
          </p>
          <div className="health-sync__diag-actions">
            <button type="button" className="ghost" disabled={busy} onClick={() => void handleAvailability()}>
              ① 检查 Health Connect{available === true ? ' ✅' : available === false ? ' ❌' : ''}
            </button>
            <button type="button" className="ghost" disabled={busy} onClick={() => void handleAuthorize()}>
              ② 请求授权
            </button>
            <div className="health-sync__row">
              <button type="button" className="ghost" disabled={busy} onClick={() => void readType('steps', 24)}>
                读 24h 步数
              </button>
              <button type="button" className="ghost" disabled={busy} onClick={() => void readType('sleep', 48)}>
                读 48h 睡眠
              </button>
              <button type="button" className="ghost" disabled={busy} onClick={() => void readType('heartRate', 24)}>
                读 24h 心率
              </button>
              <button type="button" className="ghost" disabled={busy} onClick={() => void readType('oxygenSaturation', 24)}>
                读 24h 血氧
              </button>
            </div>
          </div>
          {samples.length > 0 ? (
            <div className="health-sync__samples">
              <h3>原始样本 ({samples.length})</h3>
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
          <h2>日志</h2>
          {log.length === 0 ? <p className="health-sync__empty">还没操作过</p> : null}
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
