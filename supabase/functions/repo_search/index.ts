import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const GITHUB_TOKEN = Deno.env.get('GITHUB_PAT') ?? ''
const REPO = 'cocoRaina/nimbus-chat'
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
    return jsonError('method not allowed', 405)
  }
  if (!GITHUB_TOKEN) {
    return jsonError('GITHUB_PAT not configured', 500)
  }
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
    const { query } = await req.json()
    if (!query || typeof query !== 'string') {
      return jsonError('missing query', 400)
    }

    const searchQuery = `${query} repo:${REPO}`
    const r = await fetch(
      `https://api.github.com/search/code?q=${encodeURIComponent(searchQuery)}&per_page=15`,
      {
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: 'application/vnd.github.v3.text-match+json',
          'User-Agent': 'nimbus-chat-repo-tool',
        },
      },
    )
    if (!r.ok) {
      const text = await r.text()
      return jsonError(`GitHub API ${r.status}: ${text.slice(0, 300)}`, 502)
    }

    const data = await r.json() as {
      total_count?: number
      items?: Array<{
        name?: string
        path?: string
        text_matches?: Array<{ fragment?: string }>
      }>
    }

    const results = (data.items ?? []).map((item) => ({
      file: item.path ?? item.name ?? '',
      matches: (item.text_matches ?? [])
        .map((m) => m.fragment ?? '')
        .filter((f) => f.length > 0)
        .slice(0, 3),
    }))

    return new Response(JSON.stringify({
      total_count: data.total_count ?? 0,
      results,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return jsonError(String(err), 500)
  }
})
