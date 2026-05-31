import { useState } from 'react'
import type { User } from '@supabase/supabase-js'
import { useNavigate } from 'react-router-dom'
import { Capacitor } from '@capacitor/core'
import { Health, type HealthDataType, type HealthSample } from '@capgo/capacitor-health'
import './HealthSyncPage.css'

type Props = { user: User | null }

// Data we ask Health Connect to expose. Order also drives the on-screen
// authorization summary. Read-only — we never write back.
const REQUESTED_TYPES: HealthDataType[] = [
  'steps',
  'sleep',
  'heartRate',
  'restingHeartRate',
  'distance',
  'totalCalories',
  'weight',
]

const TYPE_LABELS: Record<HealthDataType, string> = {
  steps: '步数',
  sleep: '睡眠',
  heartRate: '心率',
  restingHeartRate: '静息心率',
  distance: '距离',
  totalCalories: '总卡路里',
  weight: '体重',
  calories: '卡路里',
  respiratoryRate: '呼吸频率',
  oxygenSaturation: '血氧',
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

const HealthSyncPage = ({ user: _user }: Props) => {
  const navigate = useNavigate()
  const isNative = Capacitor.getPlatform() === 'android'

  const [log, setLog] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [available, setAvailable] = useState<boolean | null>(null)
  const [samples, setSamples] = useState<HealthSample[]>([])

  const pushLog = (line: string) => setLog((prev) => [`${new Date().toLocaleTimeString()}  ${line}`, ...prev].slice(0, 50))

  const handleAvailability = async () => {
    if (!isNative) {
      pushLog('⚠️ Web 端无法调用 Health Connect，请用 APK 测试')
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
      <header className="app-shell__header">
        <button type="button" className="ghost" onClick={() => navigate(-1)}>
          ← 返回
        </button>
        <h1 className="ui-title">健康同步（探针）</h1>
        <span className="app-shell__spacer" />
      </header>
      <main className="app-shell__content health-sync">
        <section className="glass-card health-sync__intro">
          <p>
            连接 Health Connect 读取华为运动健康 → Health Sync 同步过来的数据。
            APK 限定，Web 端按钮会提示无效。
          </p>
          <p className="health-sync__hint">
            首次使用顺序：① 检查可用 → ② 请求授权（系统弹窗）→ ③ 读取数据。
          </p>
        </section>

        <section className="glass-card health-sync__actions">
          <button type="button" className="primary" disabled={busy} onClick={() => void handleAvailability()}>
            1. 检查 Health Connect 可用性{available === true ? ' ✅' : available === false ? ' ❌' : ''}
          </button>
          <button type="button" className="primary" disabled={busy} onClick={() => void handleAuthorize()}>
            2. 请求授权（步数 / 睡眠 / 心率 等）
          </button>
          <div className="health-sync__row">
            <button type="button" className="ghost" disabled={busy} onClick={() => void readType('steps', 24)}>
              读最近 24h 步数
            </button>
            <button type="button" className="ghost" disabled={busy} onClick={() => void readType('sleep', 48)}>
              读最近 48h 睡眠
            </button>
            <button type="button" className="ghost" disabled={busy} onClick={() => void readType('heartRate', 24)}>
              读最近 24h 心率
            </button>
            <button type="button" className="ghost" disabled={busy} onClick={() => void readType('weight', 24 * 30)}>
              读近 30 天体重
            </button>
          </div>
        </section>

        {samples.length > 0 ? (
          <section className="glass-card health-sync__samples">
            <h2>最近一次读取（{samples.length} 条）</h2>
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
          </section>
        ) : null}

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
