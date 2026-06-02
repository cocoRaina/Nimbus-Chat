import { useCallback, useEffect, useMemo, useState } from 'react'
import type { User } from '@supabase/supabase-js'
import { useNavigate } from 'react-router-dom'
import {
  fetchUsageLogs,
  type UsageLogRow,
} from '../storage/usageStats'
import {
  estimateCostUsd,
  fetchModelPricing,
  type ModelPricingMap,
} from '../storage/openrouterPricing'
import './UsagePage.css'

type RangeKey = 'today' | 'week' | 'month' | 'all'

const RANGE_OPTIONS: Array<{ key: RangeKey; label: string }> = [
  { key: 'today', label: '今天' },
  { key: 'week', label: '本周' },
  { key: 'month', label: '本月' },
  { key: 'all', label: '全部' },
]

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

// USD formatter with adaptive precision — very small amounts (a few
// hundredths of a cent) need more decimals to look meaningful, while
// dollar-range amounts only want 2.
const formatUsd = (value: number): string => {
  if (!Number.isFinite(value) || value <= 0) return '$0'
  if (value < 0.001) return `$${value.toFixed(5)}`
  if (value < 0.01) return `$${value.toFixed(4)}`
  if (value < 1) return `$${value.toFixed(3)}`
  return `$${value.toFixed(2)}`
}

type UsagePageProps = {
  user: User | null
}

const UsagePage = ({ user }: UsagePageProps) => {
  const navigate = useNavigate()
  const [range, setRange] = useState<RangeKey>('week')
  const [rows, setRows] = useState<UsageLogRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // OpenRouter /models pricing catalogue, 24h cached. Used to estimate
  // both "what you paid" and "what you would have paid without cache" —
  // i.e. how much the prompt cache is saving. Failure here just hides
  // the cost cards (the rest of the page still renders fine).
  const [pricing, setPricing] = useState<ModelPricingMap>({})

  useEffect(() => {
    void fetchModelPricing()
      .then(setPricing)
      .catch((err) => {
        console.warn('加载模型价目表失败', err)
      })
  }, [])

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

  // Group rows by provider so we can render a separate panel per API source.
  const byProvider = useMemo(() => {
    const groups = new Map<string, typeof rows>()
    for (const row of rows) {
      const key = row.provider || 'openrouter'
      const existing = groups.get(key)
      if (existing) {
        existing.push(row)
      } else {
        groups.set(key, [row])
      }
    }
    // Stable order: openrouter first, then everything else alphabetically.
    return Array.from(groups.entries()).sort(([a], [b]) => {
      if (a === 'openrouter') return -1
      if (b === 'openrouter') return 1
      return a.localeCompare(b)
    })
  }, [rows])

  const computeTotals = (subset: typeof rows) => {
    let calls = 0, prompt = 0, completion = 0, total = 0, cached = 0
    for (const row of subset) {
      calls += 1
      prompt += row.promptTokens
      completion += row.completionTokens
      total += row.totalTokens
      cached += row.cachedTokens
    }
    return { calls, prompt, completion, total, cached }
  }

  // Adds up the actual cost (with 90% cache-read discount applied) and the
  // hypothetical no-cache cost row-by-row. Per-row so different sessions
  // with different models all use their own pricing.
  const computeCostTotals = (subset: typeof rows) => {
    let actual = 0
    let withoutCache = 0
    for (const row of subset) {
      actual += estimateCostUsd(
        row.model,
        row.promptTokens,
        row.completionTokens,
        pricing,
        row.cachedTokens,
      )
      withoutCache += estimateCostUsd(
        row.model,
        row.promptTokens,
        row.completionTokens,
        pricing,
        0,
      )
    }
    return { actual, withoutCache, saved: Math.max(0, withoutCache - actual) }
  }

  const providerLabel = (id: string) =>
    id === 'openrouter' ? 'OpenRouter' : '中转站'

  // Group rows by session and rank by total tokens. Sessions without a
  // recorded id (legacy logs) get collapsed into one "未归属" bucket.
  const aggregateBySession = (
    subset: typeof rows,
  ): Array<{
    sessionId: string | null
    title: string
    calls: number
    promptTokens: number
    completionTokens: number
    totalTokens: number
    cachedTokens: number
  }> => {
    const groups = new Map<string, {
      sessionId: string | null
      title: string
      calls: number
      promptTokens: number
      completionTokens: number
      totalTokens: number
      cachedTokens: number
    }>()
    for (const row of subset) {
      const key = row.sessionId ?? '__unknown__'
      const existing = groups.get(key)
      if (existing) {
        existing.calls += 1
        existing.promptTokens += row.promptTokens
        existing.completionTokens += row.completionTokens
        existing.totalTokens += row.totalTokens
        existing.cachedTokens += row.cachedTokens
      } else {
        groups.set(key, {
          sessionId: row.sessionId,
          title: row.sessionTitle?.trim() || (row.sessionId ? `会话 ${row.sessionId.slice(0, 6)}` : '未归属（旧记录）'),
          calls: 1,
          promptTokens: row.promptTokens,
          completionTokens: row.completionTokens,
          totalTokens: row.totalTokens,
          cachedTokens: row.cachedTokens,
        })
      }
    }
    return Array.from(groups.values()).sort((a, b) => b.totalTokens - a.totalTokens)
  }

  return (
    <main className="usage-page app-shell">
      <header className="page-header-bar">
        <button type="button" className="ghost" onClick={() => navigate('/')}>
          返回聊天
        </button>
        <h1 className="ui-title">用量统计</h1>
        <button type="button" className="ghost" onClick={() => void loadData()} disabled={loading}>
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

      {byProvider.length === 0 ? (
        <p className="usage-empty">这段时间还没有调用记录。</p>
      ) : (
        byProvider.map(([providerId, subset]) => {
          const totals = computeTotals(subset)
          const costs = computeCostTotals(subset)
          const sessionRanking = aggregateBySession(subset)
          // Only show the cost banner when at least one row in this
          // provider's subset has known pricing. msuicode model IDs
          // generally aren't in OR's catalog, so this panel quietly
          // hides instead of showing a misleading "$0 saved".
          const showCostBanner = costs.withoutCache > 0
          return (
            <div key={providerId} className="usage-provider-panel">
              <h2 className="usage-provider-title">{providerLabel(providerId)}</h2>
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
                {showCostBanner ? (
                  <div className="usage-summary-card usage-cost-card">
                    <div className="usage-cost-row">
                      <div className="usage-cost-stat">
                        <span className="label">预计花费</span>
                        <span className="value">{formatUsd(costs.actual)}</span>
                      </div>
                      <div className="usage-cost-stat usage-cost-stat--saved">
                        <span className="label">
                          预计节省
                          {costs.withoutCache > 0 ? (
                            <span className="label-hint">
                              ｜约 {Math.round((costs.saved / costs.withoutCache) * 100)}%
                            </span>
                          ) : null}
                        </span>
                        <span className="value">{formatUsd(costs.saved)}</span>
                      </div>
                    </div>
                    <span className="usage-cost-note">
                      按 OR 当前价目表估算；写缓存的 1.25-2× 写入费没算进去，所以实际可能略高
                    </span>
                  </div>
                ) : null}
              </section>

              <section className="usage-section">
                <h3>按会话（token 消耗排行）</h3>
                {sessionRanking.length === 0 ? (
                  <p className="usage-empty">这段时间没有数据。</p>
                ) : (
                <div className="usage-table-wrap">
                  <table className="usage-table">
                    <thead>
                      <tr>
                        <th>会话</th>
                        <th>次数</th>
                        <th>输入</th>
                        <th>输出</th>
                        <th>合计 tokens</th>
                        <th>命中缓存</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sessionRanking.map((row) => (
                        <tr key={row.sessionId ?? '__unknown__'}>
                          <td className="model">{row.title}</td>
                          <td>{row.calls.toLocaleString()}</td>
                          <td>{formatTokenCount(row.promptTokens)}</td>
                          <td>{formatTokenCount(row.completionTokens)}</td>
                          <td>{formatTokenCount(row.totalTokens)}</td>
                          <td>
                            {row.promptTokens > 0
                              ? `${Math.round((row.cachedTokens / row.promptTokens) * 100)}%`
                              : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                )}
              </section>
            </div>
          )
        })
      )}

      <p className="usage-footer-note">
        实际计费请去对应提供商网站查看。这里只展示调用次数、token 用量、缓存命中率。
      </p>
    </main>
  )
}

export default UsagePage
