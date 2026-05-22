// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const TAVILY_KEY = Deno.env.get('TAVILY_API_KEY') ?? ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''

const jsonError = (message: string, status: number) =>
  new Response(
    JSON.stringify({ error: message }),
    { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  )

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders })
  }
  if (!TAVILY_KEY) {
    return jsonError('TAVILY_API_KEY not configured', 500)
  }

  // Defense-in-depth JWT check. The dashboard's verify_jwt setting is the
  // primary gate, but the other edge functions all do an explicit getUser()
  // too. Match that pattern so an accidental dashboard toggle doesn't open
  // the Tavily quota to the world.
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return jsonError('Supabase env vars not configured', 500)
  }
  const authHeader = req.headers.get('authorization')
  const apikey = req.headers.get('apikey')
  if (!authHeader || !apikey) {
    return jsonError('missing auth headers', 401)
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader, apikey } },
  })
  const { data: { user }, error: userError } = await supabase.auth.getUser()
  if (userError || !user) {
    return jsonError('invalid auth token', 401)
  }

  try {
    const { query, max_results = 5 } = await req.json()
    if (!query || typeof query !== 'string') {
      return new Response(
        JSON.stringify({ error: 'missing query' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: TAVILY_KEY,
        query,
        max_results: Math.min(10, Math.max(1, Number(max_results) || 5)),
        include_answer: false,
        include_raw_content: false,
        search_depth: 'basic',
      }),
    })
    if (!r.ok) {
      const text = await r.text()
      return new Response(
        JSON.stringify({ error: `tavily ${r.status}: ${text.slice(0, 500)}` }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }
    const data = await r.json() as { results?: Array<{ title?: string; url?: string; content?: string; score?: number }> }

    const trimmed = {
      results: (data.results ?? []).map((item) => ({
        title: item.title ?? '',
        url: item.url ?? '',
        snippet: item.content ?? '',
        score: item.score ?? 0,
      })),
    }

    return new Response(JSON.stringify(trimmed), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }
})
