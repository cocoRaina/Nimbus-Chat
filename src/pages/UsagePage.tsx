import { useCallback, useEffect, useMemo, useState } from 'react'
import type { User } from '@supabase/supabase-js'
import { useNavigate } from 'react-router-dom'
import {
  aggregateByModel,
  fetchUsageLogs,
  type UsageAggregate,
  type UsageLogRow,
} from '../storage/usageStats'
import {
  estimateCostUsd,
  fetchModelPricing,
  type ModelPricing,
} from '../storage/openrouterPricing'
import './UsagePage.css'

type RangeKey = 'today' | 'week' | 'month' | 'all'

const RANGE_OPTIONS: Array<{ key: RangeKey; label: string }> = [
  { key: 'today', label: '今天' },
  { key: 'week', label: '本周' },
  { key: 'month', label: '本月' },
  { key: 'all', label: '全部' },
]

const SOURCE_LABEL: Record<string, string> = {
  chat: '聊天',
  snacks: '我的主页',
  syzygy: 'TA的主页',
  memory_extract: '记忆抽取',
  other: '其他',
}

const computeRangeStart = (range: RangeKey): Date | undefined => {
  if (range === 'all') {
    return undefined
  }
  const now = new Date()
  if (range === 'today') {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate())
  }
  if (range === 'week') {
    const day = now.getDay() || 7
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (day - 1))
    return monday
  }
  return new Date(now.getFullYear(), now.getMonth(), 1)
}

const formatTokenCount = (value: number): string => {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2)}M`
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`
  }
  return value.toLocaleString()
}

const formatUsd = (value: number): string => {
  if (value === 0) {
    return '$0.00'
  }
  if (value < 0.01) {
    return `$${value.toFixed(5)}`
  }
  return `$${value.toFixed(2)}`
}

type UsagePageProps = {
  user: User | null
}

const UsagePage = ({ user }: UsagePageProps) => {
  const navigate = useNavigate()
  const [range, setRange] = useState<RangeKey>('week')
  const [rows, setRows] = useState<UsageLogRow[]>([])
  const [pricing, setPricing] = useState<Record<string, ModelPricing>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pricingError, setPricingError] = useState<string | null>(null)

  const loadData = useCallback(async () => {
    if (!user) {
      return
    }
    setLoading(true)
    setError(null)
    try {
      const since = computeRangeStart(range)
      const data = await fetchUsageLogs(user.id, since)
      setRows(data)
    } catch (loadError) {
      console.warn('加载用量记录失败', loadError)
      setError('加载失败，请稍后重试（确认 usage_logs 表已创建）。')
    } finally {
      setLoading(false)
    }
  }, [range, user])

  useEffect(() => {
    void loadData()
  }, [loadData])

  useEffect(() => {
    let active = true
    fetchModelPricing()
      .then((map) => {
        if (active) {
          setPricing(map)
        }
      })
      .catch((pricingFetchError) => {
        console.warn('加载模型单价失败', pricingFetchError)
        if (active) {
          setPricingError('未拉到模型单价（OpenRouter API key 缺失？），花销估算可能为 0')
        }
      })
    return () => {
      active = false
    }
  }, [])

  const aggregates = useMemo<UsageAggregate[]>(() => aggregateByModel(rows), [rows])

  const totals = useMemo(() => {
    let calls = 0
    let prompt = 0
    let completion = 0
    let total = 0
    let cached = 0
    let cost = 0
    for (const row of rows) {
      calls += 1
      prompt += row.promptTokens
      completion += row.completionTokens
      total += row.totalTokens
      cached += row.cachedTokens
      cost += estimateCostUsd(
        row.model,
        row.promptTokens,
        row.completionTokens,
        pricing,
        row.cachedTokens,
      )
    }
    return { calls, prompt, completion, total, cached, cost }
  }, [rows, pricing])

  const sourceBreakdown = useMemo(() => {
    const map = new Map<string, number>()
    for (const row of rows) {
      map.set(row.source, (map.get(row.source) ?? 0) + row.totalTokens)
    }
    return Array.from(map.entries())
      .map(([source, tokens]) => ({ source, tokens }))
      .sort((a, b) => b.tokens - a.tokens)
  }, [rows])

  return (
    <main className="usage-page app-shell">
      <header className="usage-header">
        <button type="button" className="usage-back" onClick={() => navigate(-1)}>
          ← 返回
        </button>
        <h1 className="ui-title">用量统计</h1>
        <button type="button" className="usage-refresh" onClick={() => void loadData()} disabled={loading}>
          {loading ? '刷新中…' : '刷新'}
        </button>
      </header>

      <div className="usage-range-tabs" role="tablist">
        {RANGE_OPTIONS.map((option) => (
          <button
            key={option.key}
            type="button"
            role="tab"
            aria-selected={range === option.key}
            className={range === option.key ? 'active' : ''}
            onClick={() => setRange(option.key)}
          >
            {option.label}
          </button>
        ))}
      </div>

      {error ? <p className="usage-error">{error}</p> : null}
      {pricingError ? <p className="usage-warning">{pricingError}</p> : null}

      <section className="usage-summary">
        <div className="usage-summary-card">
          <span className="label">调用次数</span>
          <span className="value">{totals.calls.toLocaleString()}</span>
        </div>
        <div className="usage-summary-card">
          <span className="label">
            输入 tokens
            {totals.cached > 0 && totals.prompt > 0 ? (
              <span className="label-hint">
                ｜命中缓存 {formatTokenCount(totals.cached)}（{Math.round((totals.cached / totals.prompt) * 100)}%）
              </span>
            ) : null}
          </span>
          <span className="value">{formatTokenCount(totals.prompt)}</span>
        </div>
        <div className="usage-summary-card">
          <span className="label">输出 tokens</span>
          <span className="value">{formatTokenCount(totals.completion)}</span>
        </div>
        <div className="usage-summary-card highlight">
          <span className="label">估算花销</span>
          <span className="value">{formatUsd(totals.cost)}</span>
        </div>
      </section>

      <section className="usage-section">
        <h2>按模型</h2>
        {aggregates.length === 0 ? (
          <p className="usage-empty">这段时间还没有调用记录。</p>
        ) : (
          <div className="usage-table-wrap">
            <table className="usage-table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th>次数</th>
                  <th>输入</th>
                  <th>输出</th>
                  <th>合计 tokens</th>
                  <th>估算 $</th>
                </tr>
              </thead>
              <tbody>
                {aggregates.map((row) => (
                  <tr key={row.model}>
                    <td className="model">{row.model}</td>
                    <td>{row.calls.toLocaleString()}</td>
                    <td>{formatTokenCount(row.promptTokens)}</td>
                    <td>{formatTokenCount(row.completionTokens)}</td>
                    <td>{formatTokenCount(row.totalTokens)}</td>
                    <td>
                      {formatUsd(
                        estimateCostUsd(
                          row.model,
                          row.promptTokens,
                          row.completionTokens,
                          pricing,
                          row.cachedTokens,
                        ),
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {sourceBreakdown.length > 0 ? (
        <section className="usage-section">
          <h2>按入口</h2>
          <ul className="usage-source-list">
            {sourceBreakdown.map((entry) => (
              <li key={entry.source}>
                <span>{SOURCE_LABEL[entry.source] ?? entry.source}</span>
                <span>{formatTokenCount(entry.tokens)} tokens</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <p className="usage-footer-note">
        数据从加上这次更新之后开始累计；只算 OpenRouter 返回 usage 信息的调用。花销估算基于 OpenRouter
        当前公开单价，每天缓存一次。
      </p>
    </main>
  )
}

export default UsagePage
