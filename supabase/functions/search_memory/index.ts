import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from 'jsr:@supabase/supabase-js@2'

const SF_URL = 'https://api.siliconflow.cn/v1/embeddings'
const MODEL = 'BAAI/bge-m3'
const SILICONFLOW_API_KEY = Deno.env.get('SILICONFLOW_API_KEY') ?? ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  })

// Build lexical keywords from the query for the hybrid (vector + keyword)
// recall path. No Chinese tokenizer available on Supabase, so: ASCII
// word/number tokens (>= 2 chars) for names/terms, and 2-char bigrams from
// CJK runs (catches 咖啡 / 偏好 etc. that a pure-vector search may rank too
// low). Capped to keep the ILIKE-any set small. The RPC matches these with
// content ILIKE '%kw%' and fuses with the vector ranking via RRF.
const buildKeywords = (q: string): string[] => {
  const out = new Set<string>()
  for (const m of q.matchAll(/[a-zA-Z0-9][a-zA-Z0-9'_-]*/g)) {
    const t = m[0].toLowerCase()
    if (t.length >= 2) out.add(t)
  }
  for (const m of q.matchAll(/[一-鿿]+/g)) {
    const run = m[0]
    if (run.length === 1) out.add(run)
    for (let i = 0; i < run.length - 1; i += 1) out.add(run.slice(i, i + 2))
  }
  return Array.from(out).slice(0, 16)
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS })
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method not allowed' }, 405)
  }
  let payload: {
    query?: string
    count?: number
    category?: string
    table?: string
    tags?: unknown
    days?: number
    after?: string
    before?: string
  }
  try {
    payload = await req.json()
  } catch (_) {
    return jsonResponse({ error: 'invalid JSON body' }, 400)
  }
  const query = typeof payload.query === 'string' ? payload.query.trim() : ''
  if (!query) {
    return jsonResponse({ error: 'query required' }, 400)
  }

  if (!SILICONFLOW_API_KEY) {
    return jsonResponse({ error: 'SILICONFLOW_API_KEY not configured' }, 500)
  }
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return jsonResponse({ error: 'Supabase env vars not configured' }, 500)
  }

  // JWT 校验,放在 embedding 调用之前——否则未鉴权请求也会触发 SiliconFlow
  // embedding(烧钱)。和 web_search 等其他 function 对齐:防 dashboard 误关
  // verify_jwt 时把额度开放给所有人。
  const authHeader = req.headers.get('Authorization') ?? req.headers.get('authorization')
  const apikey = req.headers.get('apikey')
  if (!authHeader || !apikey) {
    return jsonResponse({ error: 'missing auth headers' }, 401)
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader, apikey } },
  })
  const { data: { user }, error: userError } = await supabase.auth.getUser()
  if (userError || !user) {
    return jsonResponse({ error: 'invalid auth token' }, 401)
  }
  const count = Math.max(1, Math.min(20, Math.floor(Number(payload.count ?? 5)) || 5))
  const category = typeof payload.category === 'string' && payload.category.trim().length > 0
    ? payload.category.trim()
    : null
  const VALID_TABLES = ['memory', 'diary', 'letter', 'timeline', 'snack_post', 'snack_reply']
  const filterTable = typeof payload.table === 'string' && VALID_TABLES.includes(payload.table)
    ? payload.table
    : null

  // 标签：数组，去空白、去空项
  const tags = Array.isArray(payload.tags)
    ? payload.tags
        .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
        .map((t) => t.trim())
    : []
  const filterTags = tags.length > 0 ? tags : null

  // 时间范围：支持 days（最近 N 天）或显式 after / before（ISO 字符串）
  let filterAfter: string | null = null
  let filterBefore: string | null = null
  if (typeof payload.days === 'number' && payload.days > 0) {
    filterAfter = new Date(Date.now() - payload.days * 86400000).toISOString()
  }
  if (typeof payload.after === 'string' && payload.after.trim().length > 0) {
    filterAfter = payload.after.trim()
  }
  if (typeof payload.before === 'string' && payload.before.trim().length > 0) {
    filterBefore = payload.before.trim()
  }

  try {
    const embedRes = await fetch(SF_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SILICONFLOW_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: MODEL, input: query }),
    })
    if (!embedRes.ok) {
      const text = await embedRes.text()
      return jsonResponse({ error: `SiliconFlow ${embedRes.status}: ${text}` })
    }
    const embedData = await embedRes.json()
    const queryEmbedding = embedData?.data?.[0]?.embedding
    if (!Array.isArray(queryEmbedding)) {
      return jsonResponse({ error: 'unexpected embedding response' })
    }

    // 混合检索：向量召回 + 关键词（ILIKE）召回，RPC 内用 RRF 融合。
    // 标签搜索时把相似度阈值降到 0（纯靠标签召回 + 相似度排序）。
    const rpcParams: Record<string, unknown> = {
      query_embedding: queryEmbedding,
      query_keywords: buildKeywords(query),
      match_count: count,
      filter_category: category,
      filter_table: filterTable,
      filter_tags: filterTags,
      filter_after: filterAfter,
      filter_before: filterBefore,
    }
    if (filterTags) {
      rpcParams.min_similarity = 0.0
    }

    const [searchResult, periodResult, healthResult] = await Promise.all([
      supabase.rpc('search_memories_hybrid', rpcParams),
      supabase
        .from('period_tracking')
        .select('id,start_date,end_date,cycle_length,notes,created_at')
        .order('start_date', { ascending: false })
        .limit(10),
      supabase
        .from('health_data')
        .select('id,date,sleep_hours,sleep_quality,heart_rate_avg,heart_rate_rest,steps,notes')
        .order('date', { ascending: false })
        .limit(7),
    ])

    if (searchResult.error) {
      return jsonResponse({ error: 'RPC: ' + searchResult.error.message })
    }
    return jsonResponse({
      results: searchResult.data ?? [],
      period_data: periodResult.error ? [] : periodResult.data ?? [],
      health_data: healthResult.error ? [] : healthResult.data ?? [],
    })
  } catch (err) {
    return jsonResponse({ error: String(err) })
  }
})
