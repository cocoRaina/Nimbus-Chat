import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'

// relay-channel-info
// ------------------------------------------------------------------
// Proxy that fetches, for a single relay station (NewAPI / One-API or
// OpenRouter), three things the client can't read directly because of CORS:
//   1. balance / spend  (the headline numbers the user actually wants)
//   2. available models + real price
//   3. online status (derived from reachability)
//
// The relay credentials arrive in the request BODY (baseUrl + apiKey),
// because each relay preset carries its own key on the client. We still
// authenticate the *caller* with their Supabase session (same pattern as
// openrouter-models) so this endpoint can't be used as an open proxy.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

const trimSlash = (s: string) => s.replace(/\/+$/, '')

// A relay base may be stored as "https://x.com" or "https://x.com/v1".
// Management/billing routes live at the site root, inference at /v1.
const toRoot = (base: string) => trimSlash(base).replace(/\/v1$/, '')

const withTimeout = (ms: number) => {
  const c = new AbortController()
  const t = setTimeout(() => c.abort(), ms)
  return { signal: c.signal, done: () => clearTimeout(t) }
}

type Balance = {
  currency: string
  granted: number | null // total quota granted
  used: number | null // cumulative spend
  remaining: number | null // balance left
}

type ModelPrice = {
  name: string
  // token billing (per 1M tokens, in `currency`)
  inputPerM: number | null
  outputPerM: number | null
  // per-request billing (in `currency`), when the model is charged by call
  perRequest: number | null
  cached: boolean // upstream advertises prompt caching / cache_control
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : (v as number)
  return Number.isFinite(n) ? n : null
}

// ── OpenRouter balance ────────────────────────────────────────────
// GET {base}/credits → { data: { total_credits, total_usage } }
// Fallback GET {base}/key → { data: { limit, usage, limit_remaining } }
async function fetchOpenRouterBalance(base: string, key: string): Promise<Balance | null> {
  const root = trimSlash(base) // openrouter base already ends with /api/v1
  const auth = { Authorization: `Bearer ${key}` }
  try {
    const t = withTimeout(8000)
    const r = await fetch(`${root}/credits`, { headers: auth, signal: t.signal })
    t.done()
    if (r.ok) {
      const d = (await r.json())?.data ?? {}
      const granted = num(d.total_credits)
      const used = num(d.total_usage)
      return {
        currency: 'USD',
        granted,
        used,
        remaining: granted != null && used != null ? granted - used : null,
      }
    }
  } catch {
    /* fall through to /key */
  }
  try {
    const t = withTimeout(8000)
    const r = await fetch(`${root}/key`, { headers: auth, signal: t.signal })
    t.done()
    if (r.ok) {
      const d = (await r.json())?.data ?? {}
      const limit = num(d.limit)
      const usage = num(d.usage)
      const remaining = num(d.limit_remaining)
      return {
        currency: 'USD',
        granted: limit,
        used: usage,
        remaining: remaining != null ? remaining : limit != null && usage != null ? limit - usage : null,
      }
    }
  } catch {
    /* give up */
  }
  return null
}

// ── NewAPI / One-API balance ──────────────────────────────────────
// OpenAI-compatible billing dashboard, authenticated with the sk- token:
//   GET {root}/dashboard/billing/subscription → { hard_limit_usd }
//   GET {root}/dashboard/billing/usage        → { total_usage } (US cents)
async function fetchNewApiBalance(root: string, key: string): Promise<Balance | null> {
  const auth = { Authorization: `Bearer ${key}` }
  let granted: number | null = null
  let usedCents: number | null = null
  try {
    const t = withTimeout(8000)
    const r = await fetch(`${root}/dashboard/billing/subscription`, { headers: auth, signal: t.signal })
    t.done()
    if (r.ok) granted = num((await r.json())?.hard_limit_usd)
  } catch {
    /* ignore */
  }
  try {
    // A wide window so total_usage covers the whole account lifetime.
    const start = '2023-01-01'
    const end = new Date(Date.now() + 86400000).toISOString().slice(0, 10)
    const t = withTimeout(8000)
    const r = await fetch(`${root}/dashboard/billing/usage?start_date=${start}&end_date=${end}`, {
      headers: auth,
      signal: t.signal,
    })
    t.done()
    if (r.ok) usedCents = num((await r.json())?.total_usage)
  } catch {
    /* ignore */
  }
  if (granted == null && usedCents == null) return null
  const used = usedCents != null ? usedCents / 100 : null
  return {
    currency: 'USD',
    granted,
    used,
    remaining: granted != null && used != null ? granted - used : granted,
  }
}

// ── NewAPI models + pricing ───────────────────────────────────────
// GET {root}/api/pricing → { data:[{model_name, quota_type, model_ratio,
//   completion_ratio, model_price, enable_groups}], group_ratio, usable_group }
// One ratio unit == $0.002 / 1K tokens == $2 / 1M tokens (One-API convention).
async function fetchNewApiPricing(
  root: string,
  key: string,
  group: string,
): Promise<{ models: ModelPrice[]; groups: string[]; appliedGroup: string; groupRatio: number } | null> {
  let payload: any
  try {
    const t = withTimeout(9000)
    const r = await fetch(`${root}/api/pricing`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: t.signal,
    })
    t.done()
    if (!r.ok) return null
    payload = await r.json()
  } catch {
    return null
  }
  const rows: any[] = Array.isArray(payload?.data) ? payload.data : []
  if (rows.length === 0) return null

  const groupRatioMap: Record<string, number> =
    payload?.group_ratio && typeof payload.group_ratio === 'object' ? payload.group_ratio : {}
  const groups = Object.keys(groupRatioMap)
  // Pick the requested group if the relay offers it, else 'default', else 1.
  const appliedGroup = groupRatioMap[group] != null ? group : groupRatioMap['default'] != null ? 'default' : group
  const groupRatio = num(groupRatioMap[appliedGroup]) ?? 1

  const models: ModelPrice[] = rows.map((row) => {
    const name = String(row.model_name ?? row.model ?? '未知模型')
    const quotaType = num(row.quota_type) ?? 0
    const cached = Boolean(row.supports_cache ?? row.enable_cache ?? /claude|gpt-4|gemini/i.test(name))
    if (quotaType === 1) {
      const price = num(row.model_price)
      return {
        name,
        inputPerM: null,
        outputPerM: null,
        perRequest: price != null ? price * groupRatio : null,
        cached,
      }
    }
    const modelRatio = num(row.model_ratio)
    const completionRatio = num(row.completion_ratio) ?? 1
    const inputPerM = modelRatio != null ? modelRatio * 2 * groupRatio : null
    const outputPerM = modelRatio != null ? modelRatio * completionRatio * 2 * groupRatio : null
    return { name, inputPerM, outputPerM, perRequest: null, cached }
  })

  return { models, groups, appliedGroup, groupRatio }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: '仅支持 POST' }, 405)

  // Authenticate the caller with their own Supabase session.
  const authHeader = req.headers.get('authorization')
  const apiKeyHeader = req.headers.get('apikey')
  if (!authHeader || !apiKeyHeader) return json({ error: '缺少身份令牌' }, 401)
  try {
    const authUrl = new URL('/auth/v1/user', new URL(req.url).origin)
    const authResponse = await fetch(authUrl, { headers: { apikey: apiKeyHeader, Authorization: authHeader } })
    if (!authResponse.ok) return json({ error: '身份令牌无效' }, 401)
  } catch {
    return json({ error: '身份令牌无效' }, 401)
  }

  let body: { baseUrl?: string; apiKey?: string; kind?: string; group?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: '请求体解析失败' }, 400)
  }
  const baseUrl = (body.baseUrl ?? '').trim()
  const apiKey = (body.apiKey ?? '').trim()
  const group = (body.group ?? 'default').trim() || 'default'
  if (!baseUrl || !apiKey) return json({ error: '缺少中转站地址或密钥' }, 400)

  let host = ''
  try {
    host = new URL(baseUrl).hostname
  } catch {
    return json({ error: '中转站地址无效' }, 400)
  }
  const kind = body.kind === 'openrouter' || /openrouter\.ai$/i.test(host) ? 'openrouter' : 'newapi'
  const root = toRoot(baseUrl)

  let balance: Balance | null = null
  let models: ModelPrice[] = []
  let pricingMeta: { groups: string[]; appliedGroup: string; groupRatio: number } | null = null

  if (kind === 'openrouter') {
    balance = await fetchOpenRouterBalance(baseUrl, apiKey)
  } else {
    const [bal, pricing] = await Promise.all([
      fetchNewApiBalance(root, apiKey),
      fetchNewApiPricing(root, apiKey, group),
    ])
    balance = bal
    if (pricing) {
      models = pricing.models
      pricingMeta = { groups: pricing.groups, appliedGroup: pricing.appliedGroup, groupRatio: pricing.groupRatio }
    }
  }

  const reachable = balance != null || models.length > 0
  return json({
    kind,
    status: reachable ? 'online' : 'offline',
    balance,
    models,
    pricing: pricingMeta,
    fetchedAt: new Date().toISOString(),
  })
})
