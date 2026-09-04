import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const TAVILY_KEY = Deno.env.get('TAVILY_API_KEY') ?? ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''

const MAX_CONTENT_LENGTH = 8000

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
  if (!TAVILY_KEY) {
    return jsonError('TAVILY_API_KEY not configured', 500)
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
    const { url } = await req.json()
    if (!url || typeof url !== 'string') {
      return jsonError('missing url', 400)
    }

    const r = await fetch('https://api.tavily.com/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: TAVILY_KEY,
        urls: [url],
      }),
    })
    if (!r.ok) {
      const text = await r.text()
      return jsonError(`tavily extract ${r.status}: ${text.slice(0, 500)}`, 502)
    }
    const data = await r.json() as {
      results?: Array<{ url?: string; raw_content?: string }>
      failed_results?: Array<{ url?: string; error?: string }>
    }

    const result = data.results?.[0]
    if (!result?.raw_content) {
      const failReason = data.failed_results?.[0]?.error ?? 'no content extracted'
      return new Response(JSON.stringify({ url, content: null, error: failReason }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    let content = result.raw_content
    if (content.length > MAX_CONTENT_LENGTH) {
      content = content.slice(0, MAX_CONTENT_LENGTH) + '\n\n[... truncated]'
    }

    return new Response(JSON.stringify({ url, content }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return jsonError(String(err), 500)
  }
})
