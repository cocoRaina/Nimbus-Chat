// poll_proactive — lightweight check for the native WorkManager background
// poller (Android). Returns spontaneous AI messages written since `since` so
// the device can raise a LOCAL notification even when the app is killed and
// without any push service (FCM/HMS) — works on GMS-less phones (Huawei etc.).
//
// Only 'spontaneous' messages are returned: scheduled proactives already get
// an on-device local notification at schedule time, so notifying for those
// here would double up.
//
// Auth note: verify_jwt=false; the Supabase gateway still requires the anon
// key as apikey. This is a single-tenant self-hosted project (one user), and
// the function only ever returns that user's own proactive message text — the
// same data the app already shows — so anon-key gating is acceptable here.

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

  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const userId = String(body.user_id ?? '').trim()
  const since = String(body.since ?? '').trim()
  if (!userId || !since) {
    return new Response(JSON.stringify({ error: 'missing user_id or since' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const { data, error } = await supabase
    .from('messages')
    .select('content, created_at')
    .eq('user_id', userId)
    .eq('meta->>provider', 'spontaneous')
    .gt('created_at', since)
    .order('created_at', { ascending: true })
    .limit(5)

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  return new Response(
    JSON.stringify({
      messages: (data ?? []).map((m) => ({ text: m.content, created_at: m.created_at })),
      now: new Date().toISOString(),
    }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  )
})
