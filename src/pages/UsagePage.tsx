import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { User } from '@supabase/supabase-js'
import { useNavigate } from 'react-router-dom'
import { fetchUsageLogs, type UsageLogRow } from '../storage/usageStats'
import { fetchOpenRouter } from '../api/openrouter'
import { supabase } from '../supabase/client'
import { estimateTokens } from '../storage/conversationCompression'
import './UsagePage.css'

// ── Types ──────────────────────────────────────────────────────────────────

type RangeKey = 'today' | 'week' | 'month' | 'all'
type DiagTab = 'usage' | 'api' | 'compress'
type CheckStatus = 'idle' | 'running' | 'pass' | 'warn' | 'fail' | 'skip'

type CheckResult = {
  label: string
  status: CheckStatus
  detail: string
}

type CompressionEntry = {
  conversationId: string
  title: string
  summaryText: string
  updatedAt: string
  wordCount: number
}

// ── Constants ──────────────────────────────────────────────────────────────

const RANGE_OPTIONS: Array<{ key: RangeKey; label: string }> = [
  { key: 'today', label: '今天' },
  { key: 'week', label: '本周' },
  { key: 'month', label: '本月' },
  { key: 'all', label: '全部' },
]

const DIAG_TABS: Array<{ key: DiagTab; label: string }> = [
  { key: 'usage', label: '用量统计' },
  { key: 'api', label: 'API检测' },
  { key: 'compress', label: '压缩状态' },
]

// ── Helpers ────────────────────────────────────────────────────────────────

const computeRangeStart = (range: RangeKey): Date | undefined => {
  if (range === 'all') return undefined
  const now = new Date()
  if (range === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (range === 'week') {
    const day = now.getDay() || 7
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - (day - 1))
  }
  return new Date(now.getFullYear(), now.getMonth(), 1)
}

const formatTokenCount = (value: number): string => {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return value.toLocaleString()
}

const formatRelTime = (iso: string): string => {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return '刚刚'
  if (mins < 60) return `${mins} 分钟前`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs} 小时前`
  const days = Math.floor(hrs / 24)
  return `${days} 天前`
}

// ── API Quality Check ──────────────────────────────────────────────────────

// A short but non-trivial system prompt for the cache test. Note: Anthropic
// requires ≥1024 tokens in a cached block for the cache to actually write.
// This probe is shorter than that, so cache_creation_input_tokens will be 0
// on both requests. What we ARE checking is whether the relay passes through
// the cache metadata fields at all (even as 0). A relay that strips
// cache_control from outbound requests or strips usage metadata from inbound
// responses will show missing fields — that's what we flag.
const CACHE_PROBE_SYSTEM = 'You are a minimal diagnostic assistant. Reply only with the exact text the user asks for.'

const canaryText = () => `NMBSCANARY${Math.random().toString(36).slice(2, 10).toUpperCase()}`

type OpenAiUsage = {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

const parseCacheFields = (usage: OpenAiUsage | undefined) => ({
  hasField: usage != null && ('cache_creation_input_tokens' in usage || 'cache_read_input_tokens' in usage || usage.prompt_tokens_details != null),
  cacheCreate: usage?.cache_creation_input_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? 0,
  cacheRead: usage?.cache_read_input_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? 0,
})

async function runApiChecks(model: string, signal: AbortSignal): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  const isClaude = /claude|anthropic/i.test(model)

  // ── Check 1: Connectivity + latency ─────────────────────────────────────
  let latencyMs = 0
  try {
    const t0 = performance.now()
    const r = await fetchOpenRouter('/chat/completions', {
      signal,
      body: {
        model,
        stream: false,
        max_tokens: 8,
        messages: [{ role: 'user', content: '回复"ok"' }],
      },
    })
    latencyMs = Math.round(performance.now() - t0)
    if (!r.ok) {
      const text = await r.text().catch(() => '')
      results.push({ label: '连通性', status: 'fail', detail: `HTTP ${r.status}${text ? '：' + text.slice(0, 120) : ''}` })
      return results
    }
    results.push({ label: '连通性', status: 'pass', detail: `${latencyMs} ms` })
  } catch (e: unknown) {
    if ((e as { name?: string }).name === 'AbortError') return results
    results.push({ label: '连通性', status: 'fail', detail: String(e) })
    return results
  }

  // ── Check 2: Cache metadata pass-through (Claude only) ──────────────────
  if (!isClaude) {
    results.push({ label: '缓存字段透传', status: 'skip', detail: '非 Claude 模型，无 prompt cache，跳过' })
  } else {
    try {
      const probe = {
        model,
        stream: false,
        max_tokens: 8,
        messages: [
          {
            role: 'system',
            content: [
              {
                type: 'text',
                text: CACHE_PROBE_SYSTEM,
                cache_control: { type: 'ephemeral' },
              },
            ],
          },
          { role: 'user', content: '回复"ok"' },
        ],
      }
      const r1 = await fetchOpenRouter('/chat/completions', { signal, body: probe as Record<string, unknown> })
      if (!r1.ok) {
        results.push({ label: '缓存字段透传', status: 'warn', detail: `探针请求失败 HTTP ${r1.status}` })
      } else {
        const j1 = (await r1.json()) as { usage?: OpenAiUsage; model?: string }
        const { hasField } = parseCacheFields(j1.usage)
        if (hasField) {
          results.push({
            label: '缓存字段透传',
            status: 'pass',
            detail: '响应包含 cache_creation / cache_read 字段，relay 未剥离缓存元数据',
          })
        } else {
          results.push({
            label: '缓存字段透传',
            status: 'warn',
            detail: '响应缺少 cache_creation_input_tokens / cache_read_input_tokens，可能被中间层剥离（prompt cache 将失效）',
          })
        }
      }
    } catch (e: unknown) {
      if ((e as { name?: string }).name === 'AbortError') return results
      results.push({ label: '缓存字段透传', status: 'fail', detail: String(e) })
    }
  }

  // ── Check 3: Model identity via canary echo ──────────────────────────────
  try {
    const canary = canaryText()
    const r = await fetchOpenRouter('/chat/completions', {
      signal,
      body: {
        model,
        stream: false,
        max_tokens: 48,
        temperature: 0,
        messages: [{ role: 'user', content: `把以下字符原样输出，不加任何其他内容：${canary}` }],
      },
    })
    if (!r.ok) {
      results.push({ label: '模型核验', status: 'warn', detail: `请求失败 HTTP ${r.status}` })
    } else {
      const j = (await r.json()) as { usage?: OpenAiUsage; model?: string; choices?: Array<{ message?: { content?: string } }> }
      const returnedModel = j.model
      const content = j.choices?.[0]?.message?.content ?? ''
      const canaryMatch = content.includes(canary)
      const modelMatch =
        !returnedModel ||
        returnedModel === model ||
        returnedModel.replace(/^anthropic\//, '') === model.replace(/^anthropic\//, '')

      if (!canaryMatch && !modelMatch) {
        results.push({
          label: '模型核验',
          status: 'fail',
          detail: `金丝雀未返回（疑似截断/改写），且 model 字段不匹配（请求 ${model}，返回 ${returnedModel ?? '未知'}）`,
        })
      } else if (!canaryMatch) {
        results.push({
          label: '模型核验',
          status: 'warn',
          detail: `金丝雀字符串未原样返回（模型可能被替换或上下文截断）。返回 model: ${returnedModel ?? '未知'}`,
        })
      } else if (!modelMatch) {
        results.push({
          label: '模型核验',
          status: 'warn',
          detail: `金丝雀通过，但 model 字段不符：请求 ${model}，响应声称 ${returnedModel}`,
        })
      } else {
        results.push({
          label: '模型核验',
          status: 'pass',
          detail: returnedModel ? `model 字段吻合：${returnedModel}，金丝雀验证通过` : '金丝雀验证通过',
        })
      }
    }
  } catch (e: unknown) {
    if ((e as { name?: string }).name === 'AbortError') return results
    results.push({ label: '模型核验', status: 'fail', detail: String(e) })
  }

  return results
}

// ── Compression cache loader ───────────────────────────────────────────────

async function loadCompressionEntries(userId: string): Promise<CompressionEntry[]> {
  if (!supabase) return []

  // Load compression cache entries
  const { data: cacheRows, error: cacheError } = await supabase
    .from('compression_cache')
    .select('conversation_id, summary_text, updated_at')
    .eq('module', 'chat')
    .order('updated_at', { ascending: false })
    .limit(30)

  if (cacheError) throw cacheError
  if (!cacheRows || cacheRows.length === 0) return []

  // Load matching session titles
  const ids = (cacheRows as Array<{ conversation_id: string; summary_text: string; updated_at: string }>).map((r) => r.conversation_id)
  const { data: sessionRows } = await supabase
    .from('sessions')
    .select('id, title')
    .in('id', ids)
    .eq('user_id', userId)

  const titleMap = new Map<string, string>()
  for (const s of (sessionRows ?? []) as Array<{ id: string; title: string | null }>) {
    if (s.title) titleMap.set(s.id, s.title)
  }

  return (cacheRows as Array<{ conversation_id: string; summary_text: string; updated_at: string }>).map((row) => ({
    conversationId: row.conversation_id,
    title: titleMap.get(row.conversation_id) ?? `会话 ${row.conversation_id.slice(0, 8)}`,
    summaryText: row.summary_text ?? '',
    updatedAt: row.updated_at,
    wordCount: (row.summary_text ?? '').length,
  }))
}

// ── Component ──────────────────────────────────────────────────────────────

type UsagePageProps = { user: User | null }

const UsagePage = ({ user }: UsagePageProps) => {
  const navigate = useNavigate()
  const [activeTab, setActiveTab] = useState<DiagTab>('usage')

  // ── Tab 1: Usage stats ─────────────────────────────────────────────────
  const [range, setRange] = useState<RangeKey>('week')
  const [rows, setRows] = useState<UsageLogRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadUsageData = useCallback(async () => {
    if (!user) return
    setLoading(true)
    setError(null)
    try {
      const data = await fetchUsageLogs(user.id, computeRangeStart(range))
      setRows(data)
    } catch (e) {
      console.warn('加载用量记录失败', e)
      setError('加载失败，请稍后重试（确认 usage_logs 表已创建）。')
    } finally {
      setLoading(false)
    }
  }, [range, user])

  useEffect(() => {
    if (activeTab === 'usage') void loadUsageData()
  }, [activeTab, loadUsageData])

  const byProvider = useMemo(() => {
    const groups = new Map<string, typeof rows>()
    for (const row of rows) {
      const key = row.provider || 'openrouter'
      const existing = groups.get(key)
      if (existing) existing.push(row)
      else groups.set(key, [row])
    }
    return Array.from(groups.entries()).sort(([a], [b]) => {
      if (a === 'openrouter') return -1
      if (b === 'openrouter') return 1
      return a.localeCompare(b)
    })
  }, [rows])

  const computeTotals = (subset: typeof rows) => {
    let calls = 0, prompt = 0, completion = 0, total = 0, cached = 0
    for (const row of subset) { calls++; prompt += row.promptTokens; completion += row.completionTokens; total += row.totalTokens; cached += row.cachedTokens }
    return { calls, prompt, completion, total, cached }
  }

  const providerLabel = (id: string) => id === 'openrouter' ? 'OpenRouter' : '中转站'

  const aggregateBySession = (subset: typeof rows) => {
    const groups = new Map<string, { sessionId: string | null; title: string; calls: number; promptTokens: number; completionTokens: number; totalTokens: number; cachedTokens: number }>()
    for (const row of subset) {
      const key = row.sessionId ?? '__unknown__'
      const existing = groups.get(key)
      if (existing) {
        existing.calls++; existing.promptTokens += row.promptTokens; existing.completionTokens += row.completionTokens; existing.totalTokens += row.totalTokens; existing.cachedTokens += row.cachedTokens
      } else {
        groups.set(key, { sessionId: row.sessionId, title: row.sessionTitle?.trim() || (row.sessionId ? `会话 ${row.sessionId.slice(0, 6)}` : '未归属（旧记录）'), calls: 1, promptTokens: row.promptTokens, completionTokens: row.completionTokens, totalTokens: row.totalTokens, cachedTokens: row.cachedTokens })
      }
    }
    return Array.from(groups.values()).sort((a, b) => b.totalTokens - a.totalTokens)
  }

  // ── Tab 2: API checks ──────────────────────────────────────────────────
  const [testModel, setTestModel] = useState('')
  const [checkResults, setCheckResults] = useState<CheckResult[]>([])
  const [checkRunning, setCheckRunning] = useState(false)
  const checkAbortRef = useRef<AbortController | null>(null)

  // Pre-fill test model from most recent usage log when switching to API tab
  useEffect(() => {
    if (activeTab === 'api' && !testModel && rows.length > 0) {
      const mostRecent = rows[0].model
      if (mostRecent) setTestModel(mostRecent)
    }
  }, [activeTab, testModel, rows])

  const startApiChecks = async () => {
    const model = testModel.trim()
    if (!model) return
    checkAbortRef.current?.abort()
    const ctrl = new AbortController()
    checkAbortRef.current = ctrl
    setCheckRunning(true)
    setCheckResults([{ label: '连通性', status: 'running', detail: '检测中…' }])
    try {
      const results = await runApiChecks(model, ctrl.signal)
      setCheckResults(results)
    } catch {
      setCheckResults((prev) => prev.map((r) => r.status === 'running' ? { ...r, status: 'fail', detail: '意外中断' } : r))
    } finally {
      setCheckRunning(false)
    }
  }

  const stopApiChecks = () => {
    checkAbortRef.current?.abort()
    setCheckRunning(false)
  }

  // ── Tab 3: Compression status ──────────────────────────────────────────
  const [compressionEntries, setCompressionEntries] = useState<CompressionEntry[]>([])
  const [compressionLoading, setCompressionLoading] = useState(false)
  const [compressionError, setCompressionError] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const loadCompression = useCallback(async () => {
    if (!user) return
    setCompressionLoading(true)
    setCompressionError(null)
    try {
      const entries = await loadCompressionEntries(user.id)
      setCompressionEntries(entries)
    } catch (e) {
      console.warn('加载压缩缓存失败', e)
      setCompressionError('加载失败，请确认 compression_cache 表已创建。')
    } finally {
      setCompressionLoading(false)
    }
  }, [user])

  useEffect(() => {
    if (activeTab === 'compress') void loadCompression()
  }, [activeTab, loadCompression])

  // Token accuracy stats from recent chat usage logs
  const tokenAccuracyStats = useMemo(() => {
    const chatRows = rows.filter((r) => r.source === 'chat' && r.promptTokens > 0).slice(0, 20)
    if (chatRows.length === 0) return null
    const totalActual = chatRows.reduce((s, r) => s + r.promptTokens, 0)
    const totalCompletion = chatRows.reduce((s, r) => s + r.completionTokens, 0)
    const avgCache = chatRows.reduce((s, r) => s + r.cachedTokens, 0) / chatRows.length
    const avgCacheRatio = chatRows.reduce((s, r) => s + (r.promptTokens > 0 ? r.cachedTokens / r.promptTokens : 0), 0) / chatRows.length
    return { count: chatRows.length, totalActual, totalCompletion, avgCache: Math.round(avgCache), avgCacheRatio, rows: chatRows.slice(0, 10) }
  }, [rows])

  // ── Render header ──────────────────────────────────────────────────────

  const headerRight = activeTab === 'usage'
    ? <button type="button" className="ghost" onClick={() => void loadUsageData()} disabled={loading}>{loading ? '刷新中…' : '刷新'}</button>
    : activeTab === 'compress'
    ? <button type="button" className="ghost" onClick={() => void loadCompression()} disabled={compressionLoading}>{compressionLoading ? '刷新中…' : '刷新'}</button>
    : <div className="page-header-spacer" />

  return (
    <main className="usage-page app-shell">
      <header className="page-header-bar">
        <button type="button" className="ghost" onClick={() => navigate('/')}>返回聊天</button>
        <h1 className="ui-title">检测中心</h1>
        {headerRight}
      </header>

      {/* Top-level diagnostic tabs */}
      <div className="diag-tabs" role="tablist">
        {DIAG_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={activeTab === t.key}
            className={activeTab === t.key ? 'active' : ''}
            onClick={() => setActiveTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Tab 1: Usage stats ─────────────────────────────────────────── */}
      {activeTab === 'usage' && (
        <>
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
              const sessionRanking = aggregateBySession(subset)
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
                          <span className="label-hint">｜命中缓存 {formatTokenCount(totals.cached)}（{Math.round((totals.cached / totals.prompt) * 100)}%）</span>
                        ) : null}
                      </span>
                      <span className="value">{formatTokenCount(totals.prompt)}</span>
                    </div>
                    <div className="usage-summary-card">
                      <span className="label">输出 tokens</span>
                      <span className="value">{formatTokenCount(totals.completion)}</span>
                    </div>
                  </section>

                  <section className="usage-section">
                    <h3>按会话（token 消耗排行）</h3>
                    {sessionRanking.length === 0 ? (
                      <p className="usage-empty">没有数据。</p>
                    ) : (
                      <div className="usage-table-wrap">
                        <table className="usage-table">
                          <thead>
                            <tr>
                              <th>会话</th>
                              <th>次数</th>
                              <th>输入</th>
                              <th>输出</th>
                              <th>合计</th>
                              <th>缓存命中</th>
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
                                <td>{row.promptTokens > 0 ? `${Math.round((row.cachedTokens / row.promptTokens) * 100)}%` : '—'}</td>
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
          <p className="usage-footer-note">实际计费请去对应提供商网站查看。这里只展示调用次数、token 用量、缓存命中率。</p>
        </>
      )}

      {/* ── Tab 2: API quality checks ───────────────────────────────────── */}
      {activeTab === 'api' && (
        <div className="diag-panel">
          <section className="usage-section">
            <h3>检测配置</h3>
            <div className="diag-model-row">
              <label htmlFor="test-model" className="diag-label">测试模型</label>
              <input
                id="test-model"
                type="text"
                className="diag-model-input"
                value={testModel}
                onChange={(e) => setTestModel(e.target.value)}
                placeholder="例如：anthropic/claude-opus-4-5"
                disabled={checkRunning}
              />
            </div>
            <div className="diag-actions">
              {checkRunning ? (
                <button type="button" className="diag-btn diag-btn-stop" onClick={stopApiChecks}>停止</button>
              ) : (
                <button type="button" className="diag-btn" onClick={() => void startApiChecks()} disabled={!testModel.trim()}>
                  运行检测
                </button>
              )}
            </div>
          </section>

          {checkResults.length > 0 && (
            <section className="usage-section">
              <h3>检测结果</h3>
              <div className="diag-results">
                {checkResults.map((result) => (
                  <div key={result.label} className={`diag-result-card diag-${result.status}`}>
                    <div className="diag-result-header">
                      <span className="diag-result-icon">{statusIcon(result.status)}</span>
                      <span className="diag-result-label">{result.label}</span>
                      <span className={`diag-badge diag-badge-${result.status}`}>{statusLabel(result.status)}</span>
                    </div>
                    <p className="diag-result-detail">{result.detail}</p>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="usage-section diag-explainer">
            <h3>检测说明</h3>
            <ul className="diag-explain-list">
              <li><strong>连通性</strong> — 向当前 provider 发一条最小请求，测量首响应延迟。</li>
              <li><strong>缓存字段透传</strong>（仅 Claude）— 发送带 cache_control 的请求，检查响应里是否含 cache_creation_input_tokens / cache_read_input_tokens 字段。缺失说明中间层剥离了缓存元数据，prompt cache 将无法正常工作。</li>
              <li><strong>模型核验</strong> — 发送一个随机金丝雀字符串，要求模型原样返回，并核对 response.model 字段。字符串未返回或 model 字段不符提示可能发生了模型替换或上下文截断。</li>
            </ul>
          </section>
        </div>
      )}

      {/* ── Tab 3: Compression status ───────────────────────────────────── */}
      {activeTab === 'compress' && (
        <div className="diag-panel">
          {compressionError ? <p className="usage-error">{compressionError}</p> : null}

          <section className="usage-section">
            <h3>活跃压缩摘要（最近 30 条）</h3>
            {compressionLoading ? (
              <p className="usage-empty">加载中…</p>
            ) : compressionEntries.length === 0 ? (
              <p className="usage-empty">暂无压缩缓存，发送消息并触发压缩后会出现在这里。</p>
            ) : (
              <div className="compress-list">
                {compressionEntries.map((entry) => {
                  const isExpanded = expandedId === entry.conversationId
                  const estTokens = estimateTokens(entry.summaryText)
                  return (
                    <div key={entry.conversationId} className="compress-card">
                      <div
                        className="compress-card-header"
                        role="button"
                        tabIndex={0}
                        onClick={() => setExpandedId(isExpanded ? null : entry.conversationId)}
                        onKeyDown={(e) => e.key === 'Enter' && setExpandedId(isExpanded ? null : entry.conversationId)}
                      >
                        <span className="compress-status-dot" title="已有摘要" />
                        <span className="compress-title">{entry.title}</span>
                        <span className="compress-meta">
                          {entry.wordCount} 字 · ~{formatTokenCount(estTokens)} tokens · {formatRelTime(entry.updatedAt)}
                        </span>
                        <span className="compress-chevron">{isExpanded ? '▲' : '▼'}</span>
                      </div>
                      {isExpanded && (
                        <div className="compress-summary-body">
                          <pre className="compress-summary-text">{entry.summaryText}</pre>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </section>

          <section className="usage-section">
            <h3>近期 token 用量（chat 来源，最近 10 次）</h3>
            {!tokenAccuracyStats ? (
              <p className="usage-empty">切换到「用量统计」选择时间范围并刷新，这里会显示对应数据。</p>
            ) : (
              <>
                <div className="usage-summary" style={{ marginBottom: '10px' }}>
                  <div className="usage-summary-card">
                    <span className="label">样本数</span>
                    <span className="value">{tokenAccuracyStats.count}</span>
                  </div>
                  <div className="usage-summary-card">
                    <span className="label">平均缓存命中</span>
                    <span className="value">{Math.round(tokenAccuracyStats.avgCacheRatio * 100)}%</span>
                  </div>
                  <div className="usage-summary-card">
                    <span className="label">平均缓存 tokens</span>
                    <span className="value">{formatTokenCount(tokenAccuracyStats.avgCache)}</span>
                  </div>
                </div>
                <div className="usage-table-wrap">
                  <table className="usage-table">
                    <thead>
                      <tr>
                        <th>会话</th>
                        <th>实际输入</th>
                        <th>输出</th>
                        <th>缓存命中</th>
                        <th>缓存率</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tokenAccuracyStats.rows.map((row) => (
                        <tr key={row.id}>
                          <td className="model">{row.sessionTitle?.trim() || row.sessionId?.slice(0, 8) || '未知'}</td>
                          <td>{formatTokenCount(row.promptTokens)}</td>
                          <td>{formatTokenCount(row.completionTokens)}</td>
                          <td>{formatTokenCount(row.cachedTokens)}</td>
                          <td>{row.promptTokens > 0 ? `${Math.round((row.cachedTokens / row.promptTokens) * 100)}%` : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </main>
  )
}

// ── Status helpers (module-level, not inside render) ──────────────────────

const statusIcon = (s: CheckStatus) => {
  if (s === 'pass') return '✓'
  if (s === 'fail') return '✗'
  if (s === 'warn') return '!'
  if (s === 'skip') return '–'
  if (s === 'running') return '…'
  return '○'
}

const statusLabel = (s: CheckStatus) => {
  if (s === 'pass') return '通过'
  if (s === 'fail') return '失败'
  if (s === 'warn') return '警告'
  if (s === 'skip') return '跳过'
  if (s === 'running') return '检测中'
  return '待检'
}

export default UsagePage
