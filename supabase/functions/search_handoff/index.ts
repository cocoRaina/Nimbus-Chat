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

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS })
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method not allowed' }, 405)
  }
  let payload: { query?: string; count?: number }
  try {
    payload = await req.json()
  } catch (_) {
    return jsonResponse({ error: 'invalid JSON body' }, 400)
  }
  const query = typeof payload.query === 'string' ? payload.query.trim() : ''
  if (!query) {
    return jsonResponse({ error: 'query required' }, 400)
  }
  const count = Math.max(1, Math.min(20, Math.floor(Number(payload.count ?? 5)) || 5))

  if (!SILICONFLOW_API_KEY) {
    return jsonResponse({ error: 'SILICONFLOW_API_KEY not configured' }, 500)
  }
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return jsonResponse({ error: 'Supabase env vars not configured' }, 500)
  }

  // JWT 校验，放在 embedding 调用之前——否则未鉴权请求也会触发 SiliconFlow
  // embedding（烧钱）。和 search_memory / web_search 等其他 function 对齐。
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
      return jsonResponse({ error: `SiliconFlow ${embedRes.status}: ${text}` }, 502)
    }
    const embedData = await embedRes.json()
    const queryEmbedding = embedData?.data?.[0]?.embedding
    if (!Array.isArray(queryEmbedding)) {
      return jsonResponse({ error: 'unexpected embedding response' }, 502)
    }

    const { data, error } = await supabase.rpc('search_letters', {
      query_embedding: queryEmbedding,
      match_count: count,
    })
    if (error) {
      return jsonResponse({ error: error.message }, 500)
    }
    return jsonResponse({ results: data ?? [] })
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500)
  }
})
