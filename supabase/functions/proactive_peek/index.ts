import { createClient } from 'jsr:@supabase/supabase-js@2'

// 后台轮询查询端点：App 的 background-runner 每 ~15min 调一次，问「自上次以来
// 沈暮有没有新发的主动消息」。runner 没有登录态，靠请求体里的 peek_secret
// （= autonomous_state.peek_secret，App 生成并写入）自校验；校验过再用 service
// role 查 messages 里 provider=server 的主动消息返回，runner 拿去弹本地通知。
// verify_jwt=false（见 supabase/config.toml）。

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const cors = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: cors })

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return json({ error: 'env not configured' }, 500)

  let body: { secret?: string; since?: string } = {}
  try { body = await req.json() } catch { /* empty */ }
  const secret = String(body.secret ?? '')
  if (!secret) return json({ error: 'no secret' }, 400)

  const supa = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  const { data: st } = await supa
    .from('autonomous_state').select('peek_secret').eq('id', 1).maybeSingle()
  if (!st?.peek_secret || st.peek_secret !== secret) return json({ error: 'unauthorized' }, 403)

  const { data: us } = await supa
    .from('user_settings').select('user_id').limit(1).maybeSingle()
  const userId = us?.user_id as string | undefined
  if (!userId) return json({ messages: [] })

  // 默认往回看 6 小时，避免 runner 首次没有 since 时漏/重。
  const since = typeof body.since === 'string' && body.since
    ? body.since
    : new Date(Date.now() - 6 * 3600000).toISOString()

  const { data: msgs } = await supa
    .from('messages')
    .select('id, content, created_at, meta')
    .eq('user_id', userId)
    .eq('role', 'assistant')
    .gt('created_at', since)
    .order('created_at', { ascending: true })
    .limit(8)

  // 只挑「服务端投递的主动消息」（proactive_dispatch 写入时 meta.provider='server'）。
  const proactive = (msgs ?? [])
    .filter((m: { meta?: { provider?: string } }) => m?.meta?.provider === 'server')
    .map((m: { content: string; created_at: string }) => ({
      text: String(m.content ?? '').slice(0, 300),
      created_at: m.created_at,
    }))

  return json({ messages: proactive })
})
