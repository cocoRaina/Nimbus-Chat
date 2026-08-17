import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { status: 200, headers: corsHeaders })
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const authHeader = req.headers.get('Authorization') ?? ''
  const { data: { user }, error: authError } = await supabase.auth.getUser(
    authHeader.replace('Bearer ', ''),
  )

  if (authError || !user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const query = String(body.query ?? '').trim()
  const count = Math.min(Math.max(1, Number(body.count ?? 8)), 20)
  const pack = body.pack ? String(body.pack) : undefined

  let q = supabase
    .from('stickers')
    .select('name, url, pack, description')
    .eq('user_id', user.id)

  if (pack) q = q.eq('pack', pack)
  // 同时搜「名字」和「视觉描述」：小机既能按情绪短语挑，也能按图里画的啥挑。
  // query 里的逗号/括号/星号会破坏 PostgREST or() 过滤语法，先清成空格。
  if (query) {
    const safe = query.replace(/[,()*%]/g, ' ').trim()
    q = safe
      ? q.or(`name.ilike.%${safe}%,description.ilike.%${safe}%`)
      : q
  }

  const { data, error } = await q.limit(count)

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  return new Response(
    JSON.stringify({ stickers: data ?? [] }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  )
})
