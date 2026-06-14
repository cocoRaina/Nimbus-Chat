import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''

const jsonResp = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    })
    const { data: { user }, error: authErr } = await supabase.auth.getUser()
    if (authErr || !user) return jsonResp({ error: 'unauthorized' }, 401)

    const { query } = await req.json() as { query?: string }
    if (!query?.trim()) return jsonResp({ error: 'query required' }, 400)

    const url = `https://music.163.com/api/search/get?s=${encodeURIComponent(query.trim())}&limit=8&type=1`
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': 'https://music.163.com/',
      },
    })

    if (!resp.ok) return jsonResp({ error: `NetEase API ${resp.status}` }, 502)

    // deno-lint-ignore no-explicit-any
    const data = await resp.json() as any
    // deno-lint-ignore no-explicit-any
    const songs: any[] = data?.result?.songs ?? []

    const results = songs.slice(0, 5).map((s) => ({
      id: s.id as number,
      name: s.name as string,
      // deno-lint-ignore no-explicit-any
      artist: (s.artists as any[])?.map((a) => a.name as string).join('、') ?? '未知',
      duration_seconds: Math.round(((s.duration as number) ?? 0) / 1000),
    }))

    return jsonResp({ results })
  } catch (err) {
    return jsonResp({ error: String(err) }, 500)
  }
})
