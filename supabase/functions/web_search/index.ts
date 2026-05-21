// deno-lint-ignore-file no-explicit-any

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const TAVILY_KEY = Deno.env.get('TAVILY_API_KEY') ?? ''

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders })
  }
  if (!TAVILY_KEY) {
    return new Response(
      JSON.stringify({ error: 'TAVILY_API_KEY not configured' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
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
