import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { User } from '@supabase/supabase-js'
import { useNavigate } from 'react-router-dom'
import { fetchUsageLogs, type UsageLogRow } from '../storage/usageStats'
import { fetchOpenRouter } from '../api/openrouter'
import { supabase } from '../supabase/client'
import { estimateTokens } from '../storage/conversationCompression'
import { getRecallLog } from '../storage/memoryRecall'
import { getCustomProviderDisplayName, getActiveProvider } from '../storage/apiProvider'
import './UsagePage.css'

// ── Types ──────────────────────────────────────────────────────────────────

type RangeKey = 'today' | 'week' | 'month' | 'all'
type DiagTab = 'usage' | 'api' | 'compress' | 'memory'
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

type DigestRow = {
  id: string
  digestDate: string
  content: string
  createdAt: string
}

type CoverageRow = {
  day: string
  msgCount: number
  digestCount: number
}

// ── Constants ──────────────────────────────────────────────────────────────

const RANGE_OPTIONS: Array<{ key: RangeKey; label: string }> = [
  { key: 'today', label: '今天' },
  { key: 'week', label: '本周' },
  { key: 'month', label: '本月' },
  { key: 'all', label: '全部' },
]

// 每个 tab 一个短名 + 一句「这页是干嘛的」——intro 显示在 tab 栏正下方，
// 切到哪页就解释哪页，分类一眼懂（此前四个 tab 都叫「XX状态」，分不清）。
const DIAG_TABS: Array<{ key: DiagTab; label: string; intro: string }> = [
  { key: 'usage', label: '用量', intro: 'token 花在哪、缓存帮你省了多少；底部可展开逐条明细和站子对账。' },
  { key: 'api', label: '渠道体检', intro: '给中转站做体检：通不通、缓存真不真、模型有没有被偷换。' },
  { key: 'compress', label: '压缩', intro: '对话太长时旧消息会被压成一段摘要接着聊——摘要都在这，点开可查看。' },
  { key: 'memory', label: '记忆', intro: '记忆管线的运行状态：每日摘要、每周睡眠巩固、每轮自动召回。记忆内容本身（看/确认/整理）在「记忆库」页面。' },
]

// usage_logs.source → 明细表里的中文标签 + 配色。让后台工作（保活 ping /
// 失败上报 / 压缩失败）在逐条明细里一眼可辨，而不是全长得像 chat。
const SOURCE_META: Record<string, { label: string; cls: string }> = {
  chat: { label: '聊天', cls: 'chat' },
  keepalive: { label: '保活', cls: 'ka' },
  keepalive_fail: { label: '保活·拒', cls: 'bad' },
  keepalive_stale: { label: '保活·冻', cls: 'bad' },
  keepalive_client_fail: { label: '保活·端错', cls: 'bad' },
  compress_fail: { label: '压缩失败', cls: 'bad' },
  snacks: { label: '朋友圈', cls: 'aux' },
  syzygy: { label: '朋友圈', cls: 'aux' },
  memory_extract: { label: '记忆', cls: 'aux' },
}

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

// A long, deterministic English filler so the cached system block exceeds
// Anthropic's ~1024-token minimum AND is byte-identical across the two probe
// calls (so the 2nd call can actually READ the cache the 1st wrote).
const CACHE_FILLER =
  ('You are a passthrough diagnostic. This block is intentionally long enough to exceed the minimum cacheable size so the upstream provider writes it to its prompt cache, and identical across calls so the second request reads it back. ').repeat(36)

// Headers that fingerprint the upstream. Real Anthropic leaks request-id /
// anthropic-* / ratelimit; Bedrock leaks x-amzn-*; Cloudflare-fronted relays
// leak cf-ray; OpenAI-compat shims leak openai-* / x-request-id.
const collectHeaders = (h: Headers): Record<string, string> => {
  const out: Record<string, string> = {}
  try {
    h.forEach((v, k) => {
      if (/^(anthropic-|x-amzn|openai-|cf-ray|cf-cache|via|server|request-id|x-request-id|x-ratelimit|x-powered-by|x-served-by)/i.test(k)) {
        out[k.toLowerCase()] = v.length > 60 ? v.slice(0, 60) + '…' : v
      }
    })
  } catch { /* some platforms restrict header iteration */ }
  return out
}

type ChannelSignals = {
  realCacheHit: boolean | null
  cacheCreate: number
  cacheRead: number
  modelMatch: boolean
  canaryOk: boolean
  returnedModel: string | null
  headers: Record<string, string>
  injectedCoding: boolean | null
}

// Best-guess channel category from the collected signals. Deliberately a
// CATEGORY + confidence, not a brand name — relays hide their true source.
const guessChannel = (s: ChannelSignals): CheckResult => {
  const reasons: string[] = []
  const hk = Object.keys(s.headers)
  const hasAnthropicHdr = hk.some((k) => k.startsWith('anthropic-') || k === 'request-id')
  const hasAmazon = hk.some((k) => k.startsWith('x-amzn'))
  const hasOpenAiHdr = hk.some((k) => k.startsWith('openai-'))

  // Hard red flags first.
  if (!s.canaryOk || !s.modelMatch) {
    if (s.returnedModel) reasons.push(`声称返回 ${s.returnedModel}`)
    reasons.push(s.canaryOk ? 'model 字段与所点不符' : '金丝雀未原样返回（疑被改写/降智/截断）')
    return { label: '🔍 渠道猜测', status: 'fail', detail: `⚠️ 疑似【偷换模型 / 降智路由】——${reasons.join('；')}。别全信它给你的是满血。` }
  }
  if (s.injectedCoding) {
    reasons.push('无系统提示时仍自带"编程助手/CLI/Claude Code"人设')
    // 反代 Claude Code 订阅可以照样透传原生缓存——别因为是逆向就断言「无缓存」，
    // 看实测：缓存真命中就如实说省钱 OK，只是逆向的稳定性/内置提示词隐患还在。
    const cacheNote = s.realCacheHit
      ? `好消息：缓存实测真命中（省钱 OK）、模型也是真的。隐患：内置了 Claude Code 提示词（可能干扰角色扮演），且逆向订阅不稳、官方一停就停。`
      : `这类通常还无原生缓存、内置提示词、官方一停就停。`
    return { label: '🔍 渠道猜测', status: 'warn', detail: `🧩 疑似【反代订阅·编程工具逆向】（Claude Code / Kiro / Codex 类）——${reasons.join('；')}。${cacheNote}` }
  }

  if (s.realCacheHit) {
    if (hasAnthropicHdr) reasons.push('带 anthropic-/request-id 响应头')
    if (hasAmazon) reasons.push('带 AWS(x-amzn) 头 → 疑 Bedrock')
    reasons.push('原生缓存真命中（第二次 0.1× 读到）')
    return { label: '🔍 渠道猜测', status: 'pass', detail: `✅ 像【官方/官转级·真 passthrough】——${reasons.join('；')}。缓存真省钱，保活值得开。${hasAmazon ? '' : hasAnthropicHdr ? '' : '（无明显官方头，可能是认 cache_control 的优质中转）'}` }
  }

  // Cache didn't really hit.
  if (s.cacheCreate > 0 && !s.realCacheHit) {
    reasons.push('写了缓存却读不回（多上游打散 / 模拟缓存）')
  } else {
    reasons.push('两次都没有缓存读写（OpenAI 兼容层 / 缓存被剥离）')
  }
  if (hasOpenAiHdr) reasons.push('带 openai-* 头')
  return { label: '🔍 渠道猜测', status: 'warn', detail: `🌀 像【OpenAI 兼容 / 模拟缓存 / 多上游打散】——${reasons.join('；')}。原生 prompt cache 多半失效，长对话省不到钱，保活也别开。` }
}

async function runApiChecks(model: string, signal: AbortSignal): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  const isClaude = /claude|anthropic/i.test(model)
  const sig: ChannelSignals = {
    realCacheHit: null, cacheCreate: 0, cacheRead: 0,
    modelMatch: true, canaryOk: true, returnedModel: null,
    headers: {}, injectedCoding: null,
  }

  // ── Check 1: Connectivity + latency + 响应头指纹 ─────────────────────────
  let latencyMs = 0
  try {
    const t0 = performance.now()
    const r = await fetchOpenRouter('/chat/completions', {
      signal,
      body: { model, stream: false, max_tokens: 8, messages: [{ role: 'user', content: '回复"ok"' }] },
    })
    latencyMs = Math.round(performance.now() - t0)
    sig.headers = collectHeaders(r.headers)
    if (!r.ok) {
      const text = await r.text().catch(() => '')
      results.push({ label: '连通性', status: 'fail', detail: `HTTP ${r.status}${text ? '：' + text.slice(0, 120) : ''}` })
      return results
    }
    results.push({ label: '连通性 + 延迟', status: 'pass', detail: `${latencyMs} ms` })
  } catch (e: unknown) {
    if ((e as { name?: string }).name === 'AbortError') return results
    results.push({ label: '连通性', status: 'fail', detail: String(e) })
    return results
  }

  // ── Check 2: 真实缓存命中（发两次同前缀，看第二次读不读得到）──────────────
  if (!isClaude) {
    results.push({ label: '真实缓存命中', status: 'skip', detail: '非 Claude 模型，无 prompt cache，跳过' })
  } else {
    try {
      const cacheBody = {
        model, stream: false, max_tokens: 8,
        messages: [
          { role: 'system', content: [{ type: 'text', text: CACHE_FILLER, cache_control: { type: 'ephemeral' } }] },
          { role: 'user', content: '回复"ok"' },
        ],
        // OpenAI `user` field → mapped to Anthropic metadata.user_id by the
        // adapter, pinning both probe calls to the same upstream so the 2nd
        // can read the cache the 1st wrote (see api/anthropic.ts).
        user: 'nimbus-diag-probe',
      }
      const r1 = await fetchOpenRouter('/chat/completions', { signal, body: cacheBody as Record<string, unknown> })
      const j1 = r1.ok ? ((await r1.json()) as { usage?: OpenAiUsage }) : undefined
      const c1 = parseCacheFields(j1?.usage)
      // Read it back up to 2 times — a single sticky-routing fluke (landing on a
      // different upstream once) would otherwise read as a false "打散". Stop
      // early on the first real hit; only call "打散" if BOTH retries miss.
      let bestRead = 0
      let anyField = c1.hasField
      for (let attempt = 0; attempt < 2; attempt++) {
        const rr = await fetchOpenRouter('/chat/completions', { signal, body: cacheBody as Record<string, unknown> })
        const jj = rr.ok ? ((await rr.json()) as { usage?: OpenAiUsage }) : undefined
        const cc = parseCacheFields(jj?.usage)
        anyField = anyField || cc.hasField
        bestRead = Math.max(bestRead, cc.cacheRead)
        if (cc.cacheRead > 0) break
      }
      sig.cacheCreate = c1.cacheCreate
      sig.cacheRead = bestRead
      sig.realCacheHit = bestRead > 0
      if (bestRead > 0) {
        results.push({ label: '真实缓存命中', status: 'pass', detail: `✅ 真命中：读到缓存 ${bestRead} tokens（按 0.1× 计费，省 ~90%）。原生 prompt cache 正常工作。` })
      } else if (c1.cacheCreate > 0) {
        results.push({ label: '真实缓存命中', status: 'warn', detail: `⚠️ 写了缓存（${c1.cacheCreate}）但连试 2 次都没读到——多上游打散 / 模拟缓存。长对话省不到钱。` })
      } else if (!anyField) {
        results.push({ label: '真实缓存命中', status: 'warn', detail: '⚠️ 两次都无缓存字段——走了 OpenAI 兼容层 / 元数据被剥离，原生缓存失效。' })
      } else {
        results.push({ label: '真实缓存命中', status: 'warn', detail: '⚠️ 两次都没命中（写=0 读=0）。可能前缀太短或上游不缓存。' })
      }
    } catch (e: unknown) {
      if ((e as { name?: string }).name === 'AbortError') return results
      results.push({ label: '真实缓存命中', status: 'fail', detail: String(e) })
    }
  }

  // ── Check 3: 模型核验（金丝雀 + model 字段）──────────────────────────────
  try {
    const canary = canaryText()
    const r = await fetchOpenRouter('/chat/completions', {
      signal,
      body: { model, stream: false, max_tokens: 48, temperature: 0, messages: [{ role: 'user', content: `把以下字符原样输出，不加任何其他内容：${canary}` }] },
    })
    if (!r.ok) {
      results.push({ label: '模型核验', status: 'warn', detail: `请求失败 HTTP ${r.status}` })
    } else {
      const j = (await r.json()) as { model?: string; choices?: Array<{ message?: { content?: string } }> }
      const returnedModel = j.model ?? null
      const content = j.choices?.[0]?.message?.content ?? ''
      const canaryMatch = content.includes(canary)
      const modelMatch = !returnedModel || returnedModel === model || returnedModel.replace(/^anthropic\//, '') === model.replace(/^anthropic\//, '')
      sig.canaryOk = canaryMatch
      sig.modelMatch = modelMatch
      sig.returnedModel = returnedModel
      if (!canaryMatch && !modelMatch) {
        results.push({ label: '模型核验', status: 'fail', detail: `金丝雀未返回 + model 字段不符（请求 ${model}，返回 ${returnedModel ?? '未知'}）——疑偷换/降智。` })
      } else if (!canaryMatch) {
        results.push({ label: '模型核验', status: 'warn', detail: `金丝雀未原样返回（疑被改写/截断）。返回 model：${returnedModel ?? '未知'}` })
      } else if (!modelMatch) {
        results.push({ label: '模型核验', status: 'warn', detail: `金丝雀通过，但 model 字段不符：请求 ${model}，响应称 ${returnedModel}` })
      } else {
        results.push({ label: '模型核验', status: 'pass', detail: returnedModel ? `model 吻合：${returnedModel}，金丝雀通过` : '金丝雀通过' })
      }
    }
  } catch (e: unknown) {
    if ((e as { name?: string }).name === 'AbortError') return results
    results.push({ label: '模型核验', status: 'fail', detail: String(e) })
  }

  // ── Check 4: 响应头指纹 ──────────────────────────────────────────────────
  const hdrKeys = Object.keys(sig.headers)
  if (hdrKeys.length === 0) {
    results.push({ label: '响应头指纹', status: 'warn', detail: '没读到可识别的上游头（中转把头清了，或网页版受 CORS 限制——APK 上更全）。' })
  } else {
    const summary = hdrKeys.map((k) => `${k}: ${sig.headers[k]}`).join('\n')
    results.push({ label: '响应头指纹', status: 'pass', detail: summary })
  }

  // ── Check 5: 身份注入探测（不发 system，看是否自带编程工具人设）─────────────
  if (isClaude) {
    try {
      const r = await fetchOpenRouter('/chat/completions', {
        signal,
        body: { model, stream: false, max_tokens: 80, temperature: 0, messages: [{ role: 'user', content: '一句话：你现在有没有被设定成编程助手 / Claude Code / CLI / IDE 工具？有就说出来，没有就回"无设定"。' }] },
      })
      if (r.ok) {
        const j = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> }
        const txt = j.choices?.[0]?.message?.content ?? ''
        // Require a STRONG coding-identity phrase (not a generic "我能帮你编程"),
        // and no denial — reduces false positives on official channels.
        const denies = /无设定|没有被|不是被设|并非|不存在|只是\s*claude|普通\s*claude/i.test(txt)
        const strongIdentity = /claude\s*code|开发环境|代码助手|编程助手|coding assistant|dev(eloper)?\s*environment|命令行工具|cli\s*工具|cursor|ide\s*助手/i.test(txt)
        const injected = strongIdentity && !denies
        sig.injectedCoding = injected
        results.push({
          label: '身份注入探测',
          status: injected ? 'warn' : 'pass',
          detail: injected
            ? `自带编程工具人设 → 疑反代 Claude Code / Kiro。模型说：「${txt.slice(0, 60)}」`
            : '无注入的编程人设（更像直连/官转）。',
        })
      }
    } catch (e: unknown) {
      if ((e as { name?: string }).name === 'AbortError') return results
      // 非致命，跳过
    }
  }

  // ── 综合：渠道猜测（放最前面）────────────────────────────────────────────
  results.unshift(guessChannel(sig))
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

  // 中转站显示当前实际名称（从 base URL 推，如 treegpt），换站自动变。
  const relayName = getCustomProviderDisplayName()
  const providerLabel = (id: string) => id === 'openrouter' ? 'OpenRouter' : (relayName || '中转站')

  // 站子健康概览：一眼看当前渠道今天行不行。从当前 provider 的近期记录算
  // 平均首字延迟 + 缓存命中率，给一句话状态。名字按当前 provider 自适应。
  const healthOverview = useMemo(() => {
    const provider = getActiveProvider()
    const mine = rows.filter((r) => r.provider === provider).slice(0, 50)
    if (mine.length === 0) return null
    const lat = mine.filter((r) => typeof r.latencyMs === 'number' && (r.latencyMs ?? 0) > 0)
    const avgLatency = lat.length ? Math.round(lat.reduce((s, r) => s + (r.latencyMs ?? 0), 0) / lat.length) : null
    const claude = mine.filter((r) => /claude|anthropic/i.test(r.model))
    const hitRate = claude.length ? claude.filter((r) => r.cachedTokens > 0).length / claude.length : null
    const reasons: string[] = []
    let status: 'good' | 'slow' | 'bad' = 'good'
    if (avgLatency != null && avgLatency >= 12000) { status = 'bad'; reasons.push(`平均首字延迟 ${(avgLatency / 1000).toFixed(1)}s 很慢`) }
    else if (avgLatency != null && avgLatency >= 6000) { status = 'slow'; reasons.push(`平均首字延迟 ${(avgLatency / 1000).toFixed(1)}s 偏慢`) }
    if (hitRate != null && claude.length >= 5 && hitRate < 0.1) {
      if (status === 'good') status = 'slow'
      reasons.push('缓存几乎不命中（长对话省不到钱）')
    }
    return {
      name: provider === 'openrouter' ? 'OpenRouter' : (relayName || '中转站'),
      avgLatency, hitRate, sample: mine.length, claudeSample: claude.length, status, reasons,
    }
  }, [rows, relayName])

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

  // Separate 30-day history for historical analysis in Tab 2 (loaded once)
  const [histRows, setHistRows] = useState<UsageLogRow[]>([])
  const [histLoading, setHistLoading] = useState(false)
  const histLoadedRef = useRef(false)

  // 渠道体检页的历史数据加载（30 天）。抽成 callback：tab 首次进入自动加载，
  // 顶栏「刷新」手动重拉——原来体检页顶栏右侧是个空 spacer（用户吐槽的
  // 「标题右边空空」），现在四个 tab 顶栏动作统一都是刷新。
  const loadHistory = useCallback(async () => {
    if (!user) return
    setHistLoading(true)
    try {
      const data = await fetchUsageLogs(user.id, computeRangeStart('month'))
      setHistRows(data)
      // Pre-fill test model from most recent row
      if (data.length > 0 && data[0].model) {
        setTestModel((current) => current || data[0].model)
      }
    } catch {
      // keep old rows
    } finally {
      setHistLoading(false)
    }
  }, [user])

  useEffect(() => {
    if (activeTab !== 'api' || histLoadedRef.current) return
    histLoadedRef.current = true
    void loadHistory()
  }, [activeTab, loadHistory])

  // Pre-fill test model from Tab 1 rows if histRows aren't loaded yet
  useEffect(() => {
    if (activeTab === 'api' && !testModel && rows.length > 0) {
      const mostRecent = rows[0].model
      if (mostRecent) setTestModel(mostRecent)
    }
  }, [activeTab, testModel, rows])

  // Historical cache health stats (Claude chat calls only)
  const histStats = useMemo(() => {
    const claudeRows = histRows.filter((r) => /claude|anthropic/i.test(r.model) && r.source === 'chat')
    if (claudeRows.length === 0) return null

    const now = Date.now()
    const sevenDays = 7 * 86_400_000
    const recent7 = claudeRows.filter((r) => now - new Date(r.createdAt).getTime() < sevenDays)
    const prev7 = claudeRows.filter((r) => {
      const age = now - new Date(r.createdAt).getTime()
      return age >= sevenDays && age < sevenDays * 2
    })

    const hitRate = (rows_: typeof claudeRows) =>
      rows_.length ? rows_.filter((r) => r.cachedTokens > 0).length / rows_.length : null
    const avgCacheRatio = (rows_: typeof claudeRows) =>
      rows_.length ? rows_.reduce((s, r) => s + (r.promptTokens > 0 ? r.cachedTokens / r.promptTokens : 0), 0) / rows_.length : 0

    // Per-provider breakdown
    const providerMap = new Map<string, { calls: number; hits: number; totalCacheRatio: number }>()
    for (const r of claudeRows) {
      const p = r.provider || 'openrouter'
      const existing = providerMap.get(p)
      const hitCount = r.cachedTokens > 0 ? 1 : 0
      const ratio = r.promptTokens > 0 ? r.cachedTokens / r.promptTokens : 0
      if (existing) {
        existing.calls++
        existing.hits += hitCount
        existing.totalCacheRatio += ratio
      } else {
        providerMap.set(p, { calls: 1, hits: hitCount, totalCacheRatio: ratio })
      }
    }
    const byProvider = Array.from(providerMap.entries()).map(([provider, d]) => ({
      provider,
      calls: d.calls,
      hits: d.hits,
      avgCacheRatio: d.totalCacheRatio / d.calls,
    }))

    // Health assessment
    const overallHitRate = hitRate(claudeRows) ?? 0
    let health: 'good' | 'ok' | 'low' | 'none' = 'none'
    if (claudeRows.length >= 3) {
      if (overallHitRate >= 0.4) health = 'good'
      else if (overallHitRate >= 0.1) health = 'ok'
      else health = 'low'
    }

    // ── 中转打散检测 ───────────────────────────────────────────────────────
    // Signature of a relay load-balancing across multiple upstream Anthropic
    // accounts: a COLD write that happens shortly after a prior call in the
    // SAME session — within the 1h cache TTL the cache should still be warm,
    // so a cold miss means that request landed on a different upstream account
    // than the one holding the cache. On a stable single-account setup these
    // are ~0. Many of them = the relay is scattering requests.
    const SPLIT_GAP_MS = 55 * 60 * 1000 // within cache TTL → cache should be warm
    const MIN_CACHEABLE = 2000 // ignore tiny prompts that wouldn't cache anyway
    const bySession = new Map<string, typeof claudeRows>()
    for (const r of claudeRows) {
      const key = r.sessionId ?? '__none__'
      const arr = bySession.get(key)
      if (arr) arr.push(r)
      else bySession.set(key, [r])
    }
    type SplitMiss = { title: string; at: string; gapMin: number; promptTokens: number }
    const splitMisses: SplitMiss[] = []
    for (const [, sessionRows] of bySession) {
      const sorted = [...sessionRows].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      )
      for (let i = 1; i < sorted.length; i++) {
        const cur = sorted[i]
        if (cur.cachedTokens > 0 || cur.promptTokens < MIN_CACHEABLE) continue // not a cold write
        // find nearest prior cacheable call in this session
        const prev = sorted[i - 1]
        if (prev.promptTokens < MIN_CACHEABLE) continue
        const gap = new Date(cur.createdAt).getTime() - new Date(prev.createdAt).getTime()
        if (gap > 0 && gap <= SPLIT_GAP_MS) {
          splitMisses.push({
            title: cur.sessionTitle?.trim() || (cur.sessionId ? `会话 ${cur.sessionId.slice(0, 6)}` : '未知会话'),
            at: cur.createdAt,
            gapMin: Math.round(gap / 60_000),
            promptTokens: cur.promptTokens,
          })
        }
      }
    }
    splitMisses.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())

    // ── 每日命中率趋势 ─────────────────────────────────────────────────────
    const dayKey = (iso: string) => {
      const d = new Date(iso)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }
    const dayMap = new Map<string, { calls: number; hits: number; cold: number; coldTokens: number }>()
    for (const r of claudeRows) {
      const k = dayKey(r.createdAt)
      const d = dayMap.get(k) ?? { calls: 0, hits: 0, cold: 0, coldTokens: 0 }
      d.calls++
      if (r.cachedTokens > 0) d.hits++
      else if (r.promptTokens >= MIN_CACHEABLE) { d.cold++; d.coldTokens += r.promptTokens }
      dayMap.set(k, d)
    }
    const dailyTrend = Array.from(dayMap.entries())
      .map(([day, d]) => ({ day, ...d, hitPct: d.calls > 0 ? d.hits / d.calls : 0 }))
      .sort((a, b) => (a.day < b.day ? 1 : -1))
      .slice(0, 10)

    // ── 今日冷写 ───────────────────────────────────────────────────────────
    const todayKey = dayKey(new Date(now).toISOString())
    const today = dayMap.get(todayKey) ?? { calls: 0, hits: 0, cold: 0, coldTokens: 0 }

    return {
      total: claudeRows.length,
      hitCount: claudeRows.filter((r) => r.cachedTokens > 0).length,
      overallHitRate,
      avgCacheRatio: avgCacheRatio(claudeRows),
      recent7Rate: hitRate(recent7),
      prev7Rate: hitRate(prev7),
      recent7Calls: recent7.length,
      prev7Calls: prev7.length,
      byProvider,
      health,
      splitMisses,
      dailyTrend,
      today: { ...today, dateKey: todayKey },
    }
  }, [histRows])

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

  // ── Tab 4: Memory status (digests + coverage + recall log) ─────────────
  const [digestRows, setDigestRows] = useState<DigestRow[]>([])
  const [coverageRows, setCoverageRows] = useState<CoverageRow[]>([])
  // 🌙 睡眠巩固的可见性：最近一次巩固提炼出的条目（memory_entries
  // source='consolidation'）。没有这张卡时巩固跑没跑、提了什么全是黑盒。
  const [consolidationRows, setConsolidationRows] = useState<
    Array<{ id: number; content: string; createdAt: string; status: string }>
  >([])
  const [memoryLoading, setMemoryLoading] = useState(false)
  const [memoryError, setMemoryError] = useState<string | null>(null)
  const [expandedDigestId, setExpandedDigestId] = useState<string | null>(null)

  const loadMemoryStatus = useCallback(async () => {
    if (!supabase) return
    setMemoryLoading(true)
    setMemoryError(null)
    try {
      const [digestRes, coverageRes, consolidationRes] = await Promise.all([
        supabase
          .from('session_digests')
          .select('id, digest_date, content, created_at')
          .order('digest_date', { ascending: false })
          .limit(14),
        supabase.rpc('digest_coverage', { check_days: 7 }),
        supabase
          .from('memory_entries')
          .select('id, content, created_at, status')
          .eq('source', 'consolidation')
          .eq('is_deleted', false)
          .order('created_at', { ascending: false })
          .limit(6),
      ])
      if (digestRes.error) throw digestRes.error
      if (coverageRes.error) throw coverageRes.error
      setConsolidationRows(
        consolidationRes.error
          ? []
          : ((consolidationRes.data ?? []) as Array<{ id: number; content: string; created_at: string; status: string }>).map(
              (r) => ({ id: r.id, content: r.content, createdAt: r.created_at, status: r.status }),
            ),
      )
      setDigestRows(
        ((digestRes.data ?? []) as Array<{ id: string; digest_date: string; content: string; created_at: string }>).map((r) => ({
          id: r.id,
          digestDate: r.digest_date,
          content: r.content,
          createdAt: r.created_at,
        })),
      )
      setCoverageRows(
        ((coverageRes.data ?? []) as Array<{ day: string; msg_count: number; digest_count: number }>).map((r) => ({
          day: r.day,
          msgCount: r.msg_count,
          digestCount: r.digest_count,
        })),
      )
    } catch (e) {
      console.warn('加载记忆状态失败', e)
      setMemoryError('加载失败，请确认 session_digests 表和 digest_coverage RPC 已创建。')
    } finally {
      setMemoryLoading(false)
    }
  }, [])

  useEffect(() => {
    if (activeTab === 'memory') void loadMemoryStatus()
  }, [activeTab, loadMemoryStatus])

  const recallLog = activeTab === 'memory' ? getRecallLog() : []

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

  // 保活 + 压缩后台状态：从 usage_logs 的 keepalive* / compress_fail 行读出，
  // 让服务端后台工作（原本只在库里、UI 看不见）在诊断页一眼可判。
  const keepaliveStatus = useMemo(() => {
    const kaRows = rows.filter((r) =>
      r.source === 'keepalive' || r.source === 'keepalive_fail' || r.source === 'keepalive_stale',
    )
    const compressFails = rows.filter((r) => r.source === 'compress_fail')
    const latest = kaRows[0] ?? null // rows are newest-first
    let status: 'good' | 'warn' | 'bad' | 'idle' = 'idle'
    let headline = '这段时间没有保活 ping'
    let detail = '可能保活开关关着、在 01:00–08:00 静默时段、或还没出现 ≥50min 的聊天空档。'
    if (latest) {
      const when = new Date(latest.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      if (latest.source === 'keepalive') {
        if (latest.cacheWrite > latest.cacheRead) {
          status = 'warn'
          headline = 'ping 在冷写（缓存已过期）'
          detail = `最近一次 ${when}：缓存写 ${latest.cacheWrite.toLocaleString()} > 读 ${latest.cacheRead.toLocaleString()}。多为渠道漂移/部署空窗导致，偶发可忽略，频繁则考虑关保活或换渠道。`
        } else {
          status = 'good'
          headline = '保活正常保温'
          detail = `最近一次 ${when}：缓存读 ${latest.cacheRead.toLocaleString()} · 写 ${latest.cacheWrite.toLocaleString()}。ping 命中缓存、约 ¥0.07 一次，早晚第一条外的冷写正被挡住。`
        }
      } else if (latest.source === 'keepalive_fail') {
        status = 'bad'
        headline = 'ping 被上游拒绝'
        detail = `最近一次 ${when}：请求发出但渠道返回错误。检查中转 key/额度/模型是否可用。`
      } else if (latest.source === 'keepalive_stale') {
        status = 'bad'
        headline = '快照冻结——客户端没在更新'
        detail = `最近一次 ${when}：聊天在继续但服务端快照没跟上，保活对你实际是关闭的。重开保活开关后聊一句即可重建。`
      }
    }
    return { status, headline, detail, hasCompressFail: compressFails.length > 0, latestCompressFail: compressFails[0] ?? null }
  }, [rows])

  // ── Render header ──────────────────────────────────────────────────────

  // 四个 tab 顶栏右侧统一是「刷新」——之前体检页放的是空 spacer，标题
  // 右边空一块看着像坏了。
  const headerRight = activeTab === 'usage'
    ? <button type="button" className="ghost" onClick={() => void loadUsageData()} disabled={loading}>{loading ? '刷新中…' : '刷新'}</button>
    : activeTab === 'compress'
    ? <button type="button" className="ghost" onClick={() => void loadCompression()} disabled={compressionLoading}>{compressionLoading ? '刷新中…' : '刷新'}</button>
    : activeTab === 'memory'
    ? <button type="button" className="ghost" onClick={() => void loadMemoryStatus()} disabled={memoryLoading}>{memoryLoading ? '刷新中…' : '刷新'}</button>
    : <button type="button" className="ghost" onClick={() => void loadHistory()} disabled={histLoading}>{histLoading ? '刷新中…' : '刷新'}</button>

  return (
    <main className="usage-page app-shell">
      <header className="page-header-bar">
        <button type="button" className="page-back-btn" onClick={() => navigate('/')}>‹</button>
        <h1 className="ui-display diag-page-title">Diagnostics</h1>
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
      <p className="diag-tab-intro">
        {DIAG_TABS.find((t) => t.key === activeTab)?.intro}
      </p>

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

          <section className="usage-section">
            <h3>当前状态</h3>
            <p className="usage-hint">
              第一张卡：中转渠道近况（响应快不快、缓存命中好不好）。第二张卡：后台保活
              ——那个每 55 分钟帮你把缓存保温、省冷写钱的 ping 有没有在正常干活。
            </p>

          {healthOverview && (
            <div className={`health-overview health-overview--${healthOverview.status}`}>
              <div className="health-overview__head">
                <span className="health-overview__dot" aria-hidden="true">
                  {healthOverview.status === 'good' ? '🟢' : healthOverview.status === 'slow' ? '🟡' : '🔴'}
                </span>
                <strong>{healthOverview.name} 近期{healthOverview.status === 'good' ? '正常' : healthOverview.status === 'slow' ? '略慢/留意' : '异常'}</strong>
              </div>
              <div className="health-overview__metrics">
                {healthOverview.avgLatency != null
                  ? <span>平均首字延迟 <b>{(healthOverview.avgLatency / 1000).toFixed(1)}s</b></span>
                  : <span>延迟 <b>暂无</b>（新 APK 后的对话才记录）</span>}
                {healthOverview.hitRate != null
                  ? <span> · 缓存命中 <b>{Math.round(healthOverview.hitRate * 100)}%</b></span>
                  : null}
                <span> · 样本 {healthOverview.sample} 条</span>
              </div>
              {healthOverview.reasons.length > 0 && (
                <div className="health-overview__reasons">⚠️ {healthOverview.reasons.join(' · ')}</div>
              )}
            </div>
          )}

          <div className={`ka-status ka-status--${keepaliveStatus.status}`}>
            <div className="ka-status__head">
              <span className="ka-status__dot" aria-hidden="true">
                {keepaliveStatus.status === 'good' ? '🟢' : keepaliveStatus.status === 'warn' ? '🟡' : keepaliveStatus.status === 'bad' ? '🔴' : '⚪'}
              </span>
              <strong>后台保活 · {keepaliveStatus.headline}</strong>
            </div>
            <p className="ka-status__detail">{keepaliveStatus.detail}</p>
            {keepaliveStatus.hasCompressFail && (
              <p className="ka-status__warn">
                ⚠️ 检测到压缩摘要失败（compress_fail）
                {keepaliveStatus.latestCompressFail
                  ? ` · ${new Date(keepaliveStatus.latestCompressFail.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`
                  : ''}
                ——去「设置 → 上下文压缩」检查 Summarizer 提供商/模型/key。
              </p>
            )}
          </div>
          </section>

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
                        输入 tokens（总）
                        {totals.cached > 0 && totals.prompt > 0 ? (
                          <span className="label-hint">
                            ｜命中缓存 {formatTokenCount(totals.cached)}（{Math.round((totals.cached / totals.prompt) * 100)}%·0.1×便宜）
                            <br />｜真实新增 {formatTokenCount(Math.max(0, totals.prompt - totals.cached))}（非缓存·全价，这才是真花钱的输入）
                          </span>
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

          {/* 最近 10 次调用的缓存效果 — 原来是塞在「压缩状态」页里的一张
              横向滚动表（列被截断、看不懂），搬回它本来的家（用量统计）并
              改成手机友好的一条一卡 + 人话说明。 */}
          {tokenAccuracyStats && (
            <section className="usage-section">
              <h3>最近 10 次聊天调用 · 缓存效果</h3>
              <p className="usage-hint">
                每发一条消息，看它的<strong>输入</strong>里有多少被缓存挡住（<strong>命中</strong>的部分按
                0.1 倍计价，命中率越高越省钱）。带工具调用的轮次命中率天然偏低、偶尔一次 0% 是正常冷写；
                <strong>连续 0%</strong> 才说明缓存没生效，去「API 检测」查渠道。
              </p>
              <div className="usage-summary usage-summary--three" style={{ marginBottom: '10px' }}>
                <div className="usage-summary-card">
                  <span className="label">统计样本</span>
                  <span className="value">{tokenAccuracyStats.count} 次</span>
                </div>
                <div className="usage-summary-card">
                  <span className="label">平均命中率</span>
                  <span className="value">{Math.round(tokenAccuracyStats.avgCacheRatio * 100)}%</span>
                </div>
                <div className="usage-summary-card">
                  <span className="label">平均命中量</span>
                  <span className="value">{formatTokenCount(tokenAccuracyStats.avgCache)}</span>
                </div>
              </div>
              <div className="cache-row-list">
                {tokenAccuracyStats.rows.map((row) => {
                  const pct = row.promptTokens > 0
                    ? Math.round((row.cachedTokens / row.promptTokens) * 100)
                    : null
                  const tone = pct == null ? 'bad' : pct >= 70 ? 'good' : pct >= 30 ? 'mid' : 'bad'
                  const when = new Date(row.createdAt).toLocaleString('zh-CN', {
                    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
                  })
                  return (
                    <div key={row.id} className="cache-row">
                      <div className="cache-row-top">
                        <span className="cache-row-title">
                          {when} · {row.sessionTitle?.trim() || row.sessionId?.slice(0, 8) || '未知会话'}
                        </span>
                        <span className={`cache-row-hit cache-hit--${tone}`}>
                          {pct == null ? '—' : pct === 0 ? '0% 冷写' : `命中 ${pct}%`}
                        </span>
                      </div>
                      <div className="cache-row-sub">
                        输入 {formatTokenCount(row.promptTokens)}（命中 {formatTokenCount(row.cachedTokens)}）
                        · 输出 {formatTokenCount(row.completionTokens)} · {row.relayHost ?? '未知中转'}
                      </div>
                    </div>
                  )
                })}
              </div>
            </section>
          )}

          {/* 逐条明细 — 折叠，要和中转站后台日志核对时再点开 */}
          {rows.length > 0 && (
            <details className="usage-section diag-detail-fold">
              <summary>逐条明细（点开·和站子日志对账）· 最近 {Math.min(rows.length, 80)} 条</summary>
              <p className="usage-footer-note" style={{ textAlign: 'left', margin: '8px 0' }}>
                精确数字（不缩写），按时间倒序。<strong>缓存读</strong>=便宜 0.1×、<strong>缓存写</strong>=贵 1.25~2×。<strong>实发</strong>=我们自己估的实发 token（含工具 schema）。<br />
                ⚠️ 中转返回的 <code>prompt_tokens</code> 会把正文重复计进 input、虚高近一倍（实测 camel 账单真实 input 才 2k，流式却报 29k），所以「实发」列改用我们的自估，不采信中转那个数——你的<strong>真实账单</strong>请以中转后台每条的「输入 / 缓存读 / 缓存写」为准（那才是实扣，且是对的）。带 ⚠ 的行表示中转报的数比我们自估高一倍以上。
              </p>
              <div className="usage-table-wrap">
                <table className="usage-table">
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left' }}>时间</th>
                      <th style={{ textAlign: 'left' }}>类型</th>
                      <th style={{ textAlign: 'left' }}>模型</th>
                      <th>实发</th>
                      <th>输出</th>
                      <th>缓存读</th>
                      <th>缓存写</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 80).map((row) => {
                      const meta = SOURCE_META[row.source] ?? SOURCE_META.chat
                      return (
                      <tr key={row.id}>
                        <td className="model" style={{ whiteSpace: 'nowrap' }}>
                          {new Date(row.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                        </td>
                        <td><span className={`src-badge src-badge--${meta.cls}`}>{meta.label}</span></td>
                        <td className="model">{row.model.replace(/^anthropic\//, '')}</td>
                        <td>
                          {(row.sentEstTokens ?? row.promptTokens).toLocaleString()}
                          {row.sentEstTokens != null && row.promptTokens > row.sentEstTokens * 2 ? (
                            <span title={`中转报 ${row.promptTokens.toLocaleString()},比自估高一倍以上——中转虚报,你的实扣以中转后台为准`}> ⚠</span>
                          ) : null}
                        </td>
                        <td>{row.completionTokens.toLocaleString()}</td>
                        <td>{row.cacheRead.toLocaleString()}</td>
                        <td>{row.cacheWrite.toLocaleString()}</td>
                      </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </details>
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
            <p className="diag-cost-hint">点一次发 5~6 条小测试请求 · 花费 ≈ 1~2 条普通消息（只在点击时，不后台跑）</p>
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

          {/* ── Historical cache analysis ── */}
          <section className="usage-section">
            <h3>历史缓存分析（近 30 天 Claude 对话）</h3>
            {histLoading ? (
              <p className="usage-empty">加载中…</p>
            ) : histRows.length === 0 && !histLoading ? (
              <p className="usage-empty">暂无记录，请先使用 Claude 模型对话后再查看。</p>
            ) : !histStats ? (
              <p className="usage-empty">近 30 天无 Claude 对话记录。</p>
            ) : (
              <>
                {/* 今日冷写提醒 — early warning at the top */}
                {histStats.today.calls > 0 && (
                  <div
                    className={`diag-result-card ${histStats.today.cold >= 3 ? 'diag-warn' : histStats.today.cold > 0 ? '' : 'diag-pass'}`}
                    style={{ marginBottom: '10px' }}
                  >
                    <div className="diag-result-header">
                      <span className="diag-result-icon">{histStats.today.cold >= 3 ? '!' : histStats.today.cold > 0 ? '○' : '✓'}</span>
                      <span className="diag-result-label">今日缓存</span>
                      <span className={`diag-badge ${histStats.today.cold >= 3 ? 'diag-badge-warn' : 'diag-badge-pass'}`}>
                        {histStats.today.calls > 0 ? `${Math.round((histStats.today.hits / histStats.today.calls) * 100)}% 命中` : '—'}
                      </span>
                    </div>
                    <p className="diag-result-detail">
                      今日 {histStats.today.calls} 次调用，命中 {histStats.today.hits} 次，
                      冷写 {histStats.today.cold} 次
                      {histStats.today.coldTokens > 0 ? `（多读 ~${formatTokenCount(histStats.today.coldTokens)} token）` : ''}。
                      {histStats.today.cold >= 3 ? ' 冷写偏多，可能中转在打散缓存（见下方检测）。' : ''}
                    </p>
                  </div>
                )}

                {/* 中转打散自动检测 — the headline diagnostic */}
                <div
                  className={`diag-result-card ${histStats.splitMisses.length >= 2 ? 'diag-warn' : 'diag-pass'}`}
                  style={{ marginBottom: '10px' }}
                >
                  <div className="diag-result-header">
                    <span className="diag-result-icon">{histStats.splitMisses.length >= 2 ? '!' : '✓'}</span>
                    <span className="diag-result-label">中转打散检测</span>
                    <span className={`diag-badge ${histStats.splitMisses.length >= 2 ? 'diag-badge-warn' : 'diag-badge-pass'}`}>
                      {histStats.splitMisses.length >= 2 ? '疑似打散' : '正常'}
                    </span>
                  </div>
                  <p className="diag-result-detail">
                    {histStats.splitMisses.length >= 2 ? (
                      <>
                        近 30 天检测到 <strong>{histStats.splitMisses.length}</strong> 次「会话中途冷写」——
                        同一会话里上一条刚建好缓存，几分钟后的下一条却完全没读到（理应在 1 小时缓存窗口内）。
                        这是中转把请求<strong>轮询分发到多个上游账号</strong>的典型特征：缓存按账号隔离，请求落到没缓存的账号就冷写。
                        可联系中转问有没有「固定上游/独享通道」，或缓存敏感时切回 OpenRouter 直连。
                      </>
                    ) : (
                      '未检测到会话中途异常冷写，缓存命中模式正常。偶发的首条冷写（新对话/隔夜缓存过期）属正常现象。'
                    )}
                  </p>
                  {histStats.splitMisses.length >= 2 && (
                    <div className="usage-table-wrap" style={{ marginTop: '8px' }}>
                      <table className="usage-table">
                        <thead>
                          <tr>
                            <th>会话</th>
                            <th>时间</th>
                            <th>距上次</th>
                            <th>本次输入</th>
                          </tr>
                        </thead>
                        <tbody>
                          {histStats.splitMisses.slice(0, 6).map((m, i) => (
                            <tr key={`${m.at}-${i}`}>
                              <td className="model">{m.title}</td>
                              <td>{new Date(m.at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
                              <td>{m.gapMin} 分钟</td>
                              <td>{formatTokenCount(m.promptTokens)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                {/* Health banner */}
                <div className={`diag-result-card ${histHealthCard(histStats.health)}`} style={{ marginBottom: '10px' }}>
                  <div className="diag-result-header">
                    <span className="diag-result-icon">{histHealthIcon(histStats.health)}</span>
                    <span className="diag-result-label">缓存健康度</span>
                    <span className={`diag-badge ${histHealthBadge(histStats.health)}`}>{histHealthText(histStats.health)}</span>
                  </div>
                  <p className="diag-result-detail">{histHealthDesc(histStats)}</p>
                </div>

                {/* Summary cards */}
                <div className="usage-summary" style={{ marginBottom: '10px' }}>
                  <div className="usage-summary-card">
                    <span className="label">Claude 调用</span>
                    <span className="value">{histStats.total}</span>
                  </div>
                  <div className="usage-summary-card">
                    <span className="label">有缓存命中</span>
                    <span className="value">{histStats.hitCount}</span>
                    {histStats.total > 0 && <span className="label-hint" style={{ display: 'block', fontSize: '0.72rem', color: 'var(--ab-accent)', marginTop: '2px' }}>{Math.round(histStats.overallHitRate * 100)}% 的调用</span>}
                  </div>
                  <div className="usage-summary-card">
                    <span className="label">平均缓存率</span>
                    <span className="value">{Math.round(histStats.avgCacheRatio * 100)}%</span>
                  </div>
                </div>

                {/* Trend: recent 7 days vs prior 7 */}
                {(histStats.recent7Calls > 0 || histStats.prev7Calls > 0) && (
                  <div className="hist-trend-row">
                    <span className="hist-trend-label">近 7 天</span>
                    <span className="hist-trend-value">
                      {histStats.recent7Rate != null
                        ? `${histStats.recent7Calls} 次·命中率 ${Math.round(histStats.recent7Rate * 100)}%`
                        : '—'}
                    </span>
                    <span className="hist-trend-sep">｜</span>
                    <span className="hist-trend-label">前 7 天</span>
                    <span className="hist-trend-value">
                      {histStats.prev7Rate != null
                        ? `${histStats.prev7Calls} 次·命中率 ${Math.round(histStats.prev7Rate * 100)}%`
                        : histStats.prev7Calls === 0 ? '无数据' : '—'}
                    </span>
                    {histStats.recent7Rate != null && histStats.prev7Rate != null && (
                      <span className={`hist-trend-delta ${histStats.recent7Rate >= histStats.prev7Rate ? 'hist-trend-up' : 'hist-trend-down'}`}>
                        {histStats.recent7Rate >= histStats.prev7Rate ? '↑' : '↓'}
                        {Math.abs(Math.round((histStats.recent7Rate - histStats.prev7Rate) * 100))} pp
                      </span>
                    )}
                  </div>
                )}

                {/* Per-provider breakdown */}
                {histStats.byProvider.length > 1 && (
                  <div className="usage-table-wrap" style={{ marginTop: '8px' }}>
                    <table className="usage-table">
                      <thead>
                        <tr>
                          <th>提供商</th>
                          <th>调用次数</th>
                          <th>有命中</th>
                          <th>命中率</th>
                          <th>平均缓存率</th>
                        </tr>
                      </thead>
                      <tbody>
                        {histStats.byProvider.map((p) => (
                          <tr key={p.provider}>
                            <td className="model">{p.provider === 'openrouter' ? 'OpenRouter' : (relayName || '中转站')}</td>
                            <td>{p.calls}</td>
                            <td>{p.hits}</td>
                            <td>{p.calls > 0 ? `${Math.round((p.hits / p.calls) * 100)}%` : '—'}</td>
                            <td>{Math.round(p.avgCacheRatio * 100)}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* 每日命中率趋势 */}
                {histStats.dailyTrend.length > 1 && (
                  <div style={{ marginTop: '12px' }}>
                    <div className="diag-label" style={{ marginBottom: '6px' }}>每日命中率趋势</div>
                    <div className="hist-day-list">
                      {histStats.dailyTrend.map((d) => {
                        const pct = Math.round(d.hitPct * 100)
                        const tone = pct >= 80 ? 'good' : pct >= 50 ? 'mid' : 'low'
                        return (
                          <div key={d.day} className="hist-day-row">
                            <span className="hist-day-date">{d.day.slice(5)}</span>
                            <div className="hist-day-bar-wrap">
                              <div className={`hist-day-bar hist-day-${tone}`} style={{ width: `${Math.max(pct, 3)}%` }} />
                            </div>
                            <span className="hist-day-pct">{pct}%</span>
                            <span className="hist-day-meta">{d.calls} 次{d.cold > 0 ? ` · 冷写 ${d.cold}` : ''}</span>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
              </>
            )}
          </section>

          <details className="usage-section diag-detail-fold diag-explainer">
            <summary>检测说明（每一项测的是什么，点开看）</summary>
            <ul className="diag-explain-list">
              <li><strong>🔍 渠道猜测</strong> — 把下面所有信号综合成一个「类别 + 证据」判断（官方真 passthrough / OpenAI兼容·模拟缓存 / 反代订阅编程工具 / 偷换降智）。<strong>只给类别不给牌子名</strong>——中转故意抹掉上游来源，没有可靠信号能定位是「反重力」还是「Kiro」。</li>
              <li><strong>连通性 + 延迟</strong> — 发一条最小请求，测首响应延迟、确认通不通。</li>
              <li><strong>真实缓存命中</strong>（仅 Claude）— 发两次 ≥1024 token 的<strong>相同前缀</strong>（粘同一上游），看第二次有没有真读到缓存。真命中=原生缓存有效、长对话省钱、保活值得开；写了读不到=多上游打散/模拟缓存；全 0=走了 OpenAI 兼容层、缓存被剥离。</li>
              <li><strong>模型核验</strong> — 发一个随机金丝雀字符串要求原样返回，并核对 response.model。字符串没返回或 model 不符 = 可能偷换模型/降智路由/截断。</li>
              <li><strong>响应头指纹</strong> — 采集上游会漏的响应头（anthropic-/request-id=直连官方、x-amzn=Bedrock、cf-ray=Cloudflare、openai-=OpenAI兼容）。网页版受 CORS 限只能读到一点，<strong>APK 上更全</strong>。</li>
              <li><strong>身份注入探测</strong>（仅 Claude）— 不发任何系统提示，问模型「你是不是被设成编程助手/Claude Code/CLI」。它自带编程人设 = 中转反代了别人的 Claude Code 订阅、内置了提示词（这也可能干扰角色扮演）。</li>
              <li><strong>历史缓存分析 / 中转打散 / 每日趋势</strong>（读历史·免费）— 扫近 30 天记录，看命中率、找「同会话刚建缓存几分钟后又冷写」的打散特征、按天看趋势。不发探针、不花钱。</li>
            </ul>
          </details>
        </div>
      )}

      {/* ── Tab 3: Compression status ───────────────────────────────────── */}
      {activeTab === 'compress' && (
        <div className="diag-panel">
          {compressionError ? <p className="usage-error">{compressionError}</p> : null}

          <section className="usage-section">
            <h3>活跃压缩摘要（最近 30 条）</h3>
            <p className="usage-hint">
              一个会话聊太长时，早期消息会被自动压成一段「备忘」随对话携带（省 token、防爆上下文）。
              每行是一个会话的当前备忘：点开能看小机把前情记成了什么样。
            </p>
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

        </div>
      )}

      {/* ── Tab 4: Memory status ───────────────────────────────────────── */}
      {activeTab === 'memory' && (
        <div className="diag-panel">
          {memoryError ? <p className="usage-error">{memoryError}</p> : null}

          <section className="usage-section">
            <h3>会话摘要覆盖（最近 7 天）</h3>
            <p className="usage-hint">每天凌晨 4:30 自动给前一天的活跃会话写摘要。🟢 已生成 · ⚪ 消息太少跳过 · 🔴 该有但没生成（连续出现说明 cron 出问题了）</p>
            {memoryLoading ? (
              <p className="usage-empty">加载中…</p>
            ) : coverageRows.length === 0 ? (
              <p className="usage-empty">暂无数据。</p>
            ) : (
              <div className="compress-list">
                {coverageRows.map((row) => {
                  const status = row.digestCount > 0 ? 'ok' : row.msgCount < 6 ? 'skip' : 'missing'
                  return (
                    <div key={row.day} className="compress-card">
                      <div className="compress-card-header">
                        <span>{status === 'ok' ? '🟢' : status === 'skip' ? '⚪' : '🔴'}</span>
                        <span className="compress-title">{row.day.slice(5).replace('-', '.')}</span>
                        <span className="compress-meta">
                          {row.msgCount} 条消息 · {row.digestCount > 0 ? `${row.digestCount} 条摘要` : status === 'skip' ? '不足 6 条，跳过' : '缺摘要'}
                        </span>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </section>

          <section className="usage-section">
            <h3>🌙 睡眠巩固（每周一凌晨 5:00）</h3>
            <p className="usage-hint">
              每周自动把近两周的每日回顾蒸馏成「跨天才能看出的模式记忆」（如"赶 deadline 前会失眠"），
              提出的条目进待确认队列——去 <strong>记忆库 → 记忆</strong> 点头才真正入库。这里只看它跑没跑、提了什么。
            </p>
            {memoryLoading ? (
              <p className="usage-empty">加载中…</p>
            ) : consolidationRows.length === 0 ? (
              <p className="usage-empty">还没有巩固记录——每周一凌晨自动运行，攒够 5 天日摘要才开工。</p>
            ) : (
              <div className="compress-list">
                {consolidationRows.map((r) => (
                  <div key={r.id} className="compress-card">
                    <div className="compress-card-header">
                      <span>{r.status === 'pending' ? '🕐' : '✅'}</span>
                      <span className="compress-title">{r.content}</span>
                      <span className="compress-meta">
                        {formatRelTime(r.createdAt)} · {r.status === 'pending' ? '待确认' : '已确认'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="usage-section">
            <h3>会话摘要（最近 14 条）</h3>
            {memoryLoading ? (
              <p className="usage-empty">加载中…</p>
            ) : digestRows.length === 0 ? (
              <p className="usage-empty">还没有摘要——每天凌晨自动生成，或让 Claude 手动触发回填。</p>
            ) : (
              <div className="compress-list">
                {digestRows.map((row) => {
                  const isExpanded = expandedDigestId === row.id
                  return (
                    <div key={row.id} className="compress-card">
                      <div
                        className="compress-card-header"
                        role="button"
                        tabIndex={0}
                        onClick={() => setExpandedDigestId(isExpanded ? null : row.id)}
                        onKeyDown={(e) => e.key === 'Enter' && setExpandedDigestId(isExpanded ? null : row.id)}
                      >
                        <span className="compress-status-dot" title="已生成" />
                        <span className="compress-title">{row.digestDate.slice(5).replace('-', '.')}</span>
                        <span className="compress-meta">
                          {row.content.length} 字 · 生成于 {formatRelTime(row.createdAt)}
                        </span>
                        <span className="compress-chevron">{isExpanded ? '▲' : '▼'}</span>
                      </div>
                      {isExpanded && (
                        <div className="compress-summary-body">
                          <pre className="compress-summary-text">{row.content}</pre>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </section>

          <section className="usage-section">
            <h3>每轮自动召回（本次启动，最近 {recallLog.length} 次）</h3>
            <p className="usage-hint">每条消息发送时自动搜记忆库注入 [相关记忆]。此日志存在内存里，重启 App 后清空。</p>
            {recallLog.length === 0 ? (
              <p className="usage-empty">本次启动还没有触发召回——发一条 6 字以上的消息就会出现记录。</p>
            ) : (
              <div className="compress-list">
                {recallLog.map((entry) => (
                  <div key={entry.at} className="compress-card">
                    <div className="compress-card-header">
                      <span>{entry.hits > 0 ? '🟢' : entry.hits === 0 ? '⚪' : '🔴'}</span>
                      <span className="compress-title">{entry.query}</span>
                      <span className="compress-meta">
                        {entry.hits >= 0 ? `${entry.hits} 条命中` : '失败'} · {formatRelTime(new Date(entry.at).toISOString())}
                      </span>
                    </div>
                    <div className="compress-summary-body">
                      <pre className="compress-summary-text">{entry.preview}</pre>
                    </div>
                  </div>
                ))}
              </div>
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

// ── Historical health card helpers ────────────────────────────────────────

type HistHealth = 'good' | 'ok' | 'low' | 'none'

const histHealthCard = (h: HistHealth) =>
  h === 'good' ? 'diag-pass' : h === 'ok' ? '' : h === 'low' ? 'diag-warn' : 'diag-skip'

const histHealthIcon = (h: HistHealth) =>
  h === 'good' ? '✓' : h === 'ok' ? '○' : h === 'low' ? '!' : '–'

const histHealthBadge = (h: HistHealth) =>
  h === 'good' ? 'diag-badge-pass' : h === 'ok' ? 'diag-badge-running' : h === 'low' ? 'diag-badge-warn' : 'diag-badge-skip'

const histHealthText = (h: HistHealth) =>
  h === 'good' ? '良好' : h === 'ok' ? '正常' : h === 'low' ? '偏低' : '暂无'

type HistStats = {
  total: number
  hitCount: number
  overallHitRate: number
  avgCacheRatio: number
  health: HistHealth
}

const histHealthDesc = (s: HistStats) => {
  if (s.health === 'none') return '调用次数不足（< 3 次），无法评估。'
  const pct = Math.round(s.overallHitRate * 100)
  const avgPct = Math.round(s.avgCacheRatio * 100)
  if (s.health === 'good') return `近 30 天 ${s.total} 次 Claude 调用中，${s.hitCount} 次（${pct}%）有缓存命中，平均命中 ${avgPct}% 输入 token，缓存正常工作。`
  if (s.health === 'ok') return `近 30 天 ${s.total} 次 Claude 调用中，${s.hitCount} 次（${pct}%）有缓存命中。命中率中等，属正常范围（短对话、全新 system prompt 首次不会命中）。`
  return `近 30 天 ${s.total} 次 Claude 调用中仅 ${s.hitCount} 次（${pct}%）有缓存命中，命中率偏低。若对话较长且重复打开过多次，建议用「运行检测」确认 relay 是否透传缓存字段。`
}

export default UsagePage
