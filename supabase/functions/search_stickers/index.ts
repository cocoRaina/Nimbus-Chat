import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1'

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { status: 200 })
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
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const query = String(body.query ?? '').trim()
  const count = Math.min(Math.max(1, Number(body.count ?? 8)), 20)
  const pack = body.pack ? String(body.pack) : undefined

  let q = supabase
    .from('stickers')
    .select('name, url, pack')
    .eq('user_id', user.id)

  if (pack) {
    q = q.eq('pack', pack)
  }

  if (query) {
    q = q.ilike('name', `%${query}%`)
  }

  const { data, error } = await q.limit(count)

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  return new Response(
    JSON.stringify({ stickers: data ?? [] }),
    { headers: { 'Content-Type': 'application/json' } },
  )
})
