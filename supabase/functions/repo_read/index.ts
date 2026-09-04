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
const MAX_LINES = 300

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
    const { path, start_line, end_line } = await req.json()
    if (!path || typeof path !== 'string') {
      return jsonError('missing path', 400)
    }

    const cleanPath = path.replace(/^\/+/, '')
    const r = await fetch(
      `https://api.github.com/repos/${REPO}/contents/${encodeURIComponent(cleanPath).replace(/%2F/g, '/')}`,
      {
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'nimbus-chat-repo-tool',
        },
      },
    )
    if (!r.ok) {
      if (r.status === 404) {
        return jsonError(`file not found: ${cleanPath}`, 404)
      }
      const text = await r.text()
      return jsonError(`GitHub API ${r.status}: ${text.slice(0, 300)}`, 502)
    }

    const data = await r.json() as { content?: string; encoding?: string; size?: number; type?: string }

    if (data.type !== 'file') {
      if (Array.isArray(data)) {
        const listing = (data as Array<{ name: string; type: string }>).map(
          (f) => `${f.type === 'dir' ? '📁' : '📄'} ${f.name}`,
        )
        return new Response(JSON.stringify({ path: cleanPath, type: 'directory', entries: listing }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }
      return jsonError(`not a file: ${cleanPath}`, 400)
    }

    if (!data.content || data.encoding !== 'base64') {
      return jsonError('unexpected response format', 502)
    }

    const decoded = atob(data.content.replace(/\n/g, ''))
    const lines = decoded.split('\n')

    const start = Math.max(1, Math.floor(Number(start_line) || 1))
    const end = Math.min(lines.length, Math.floor(Number(end_line) || (start + MAX_LINES - 1)))
    const sliced = lines.slice(start - 1, end)
    const numbered = sliced.map((line, i) => `${start + i}\t${line}`).join('\n')

    return new Response(JSON.stringify({
      path: cleanPath,
      total_lines: lines.length,
      showing: `${start}-${end}`,
      content: numbered,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return jsonError(String(err), 500)
  }
})
