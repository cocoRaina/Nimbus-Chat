import { useCallback, useEffect, useState } from 'react'
import type { User } from '@supabase/supabase-js'
import { useNavigate } from 'react-router-dom'
import { Capacitor } from '@capacitor/core'
import { Health, type HealthDataType, type HealthSample } from '@capgo/capacitor-health'
import { supabase } from '../supabase/client'
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
