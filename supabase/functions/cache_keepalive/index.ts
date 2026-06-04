// Server-side cache keepalive — refreshes the Anthropic prompt cache for
// users who were recently active. Called by pg_cron every 5min, 24/7.
// Per-user gating + 50min ping cooldown.
//
// Why this exists: the client-side keepalive timer (App.tsx) dies when
// the app is killed/backgrounded on mobile. Without this, any >1h gap
// between chats incurs a fresh cache write (~$2.64 per write on the
// user's typical 88K-token prompt). With this, a single ~$0.13 read
// keeps it alive instead. See README "💰 成本优化" for the full story.
//
// No quiet hours — an earlier version gated this to 08:00–23:00 to skip
// "useless" night pings. But the 4h ACTIVE_WINDOW_MS already stops pings
// once a user goes idle, so removing the hour gate doesn't pay for the
// dead-of-night case; it pays for the user-who-chats-at-1am case, where
// the previous gate was costing a cold-write per session.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1'

// How long after a user's last successful chat we keep pinging. Set to
// 4h — captures the "I'll be back in a couple hours" pattern but stops
// burning pings on users who've truly gone idle.
const ACTIVE_WINDOW_MS = 4 * 60 * 60 * 1000
// Slightly less than 55min so a 5-min cron tick won't accidentally
// skip a slot due to scheduling drift.
const PING_COOLDOWN_MS = 50 * 60 * 1000

type KeepaliveRow = {
  user_id: string
  body: Record<string, unknown>
  openrouter_key: string // legacy name; actually the per-provider relay key
  provider: string | null // 'openrouter' or 'msuicode'; null on pre-migration rows
  base_url: string | null
  auth_style: string | null // 'bearer' or 'x-api-key'
  last_chat_at: string
  last_ping_at: string | null
  ping_count: number
}

// Defense in depth: re-validate the per-row routing fields before using
// them to issue an HTTP request that carries the user's API key. The DB
// CHECK constraints already restrict these values, but a defensive check
// here means a future migration drift or a service-role write outside the
// schema can't accidentally smuggle an http:// URL or unknown auth style.
const ALLOWED_AUTH_STYLES = new Set(['bearer', 'x-api-key'])
const validateRouting = (row: KeepaliveRow): { baseUrl: string; authStyle: 'bearer' | 'x-api-key' } | null => {
  const baseUrl = row.base_url ?? 'https://openrouter.ai/api/v1'
  const authStyle = row.auth_style ?? 'bearer'
  if (!baseUrl.startsWith('https://')) return null
  if (!ALLOWED_AUTH_STYLES.has(authStyle)) return null
  return { baseUrl, authStyle: authStyle as 'bearer' | 'x-api-key' }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { status: 200 })
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const activeSince = new Date(Date.now() - ACTIVE_WINDOW_MS).toISOString()
  const { data, error } = await supabase
    .from('cache_keepalive_state')
    .select(
      'user_id, body, openrouter_key, provider, base_url, auth_style, last_chat_at, last_ping_at, ping_count',
    )
    .gte('last_chat_at', activeSince)

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const rows = (data ?? []) as KeepaliveRow[]
  const cooldownCutoffMs = Date.now() - PING_COOLDOWN_MS
  let pinged = 0
  let cooled = 0
  let failed = 0

  for (const row of rows) {
    if (row.last_ping_at && new Date(row.last_ping_at).getTime() > cooldownCutoffMs) {
      cooled++
      continue
    }

    // Build the minimal ping. The body in row.body is now Anthropic-
    // native shape (App.tsx converts via convertOpenAiRequestToAnthropic
    // before upserting) so we can POST it straight to OR's /messages
    // endpoint. Five overrides keep the ping cheap + valid:
    //   1. max_tokens: 1   — Anthropic min; without it we'd inherit the
    //      9024-token cap the chat used.
    //   2. stream: false   — we don't need SSE for a 1-token ping.
    //   3. drop `thinking` — extended thinking requires max_tokens >
    //      thinking.budget_tokens (~8000), which conflicts with our
    //      max_tokens:1 and 400s. Trade-off: this changes the request
    //      shape vs the actual chat (which sends thinking enabled), so
    //      Anthropic's cache key for the ping doesn't match HEAD/BP4
    //      exactly — but BP1 (system+tools, marked separately on the
    //      system block) still hits since its prefix doesn't depend on
    //      thinking config. Net effect: ping refreshes BP1's TTL and
    //      provides the "system+tools always warm" benefit; the deeper
    //      conversation prefix still naturally falls out of cache at
    //      the 1h TTL boundary if the user doesn't chat for an hour.
    //   4. keep `tools` + `system` + `messages` + `metadata` + `provider`
    //      + `model` — they're all part of the cache prefix key.
    //   5. drop OpenAI-specific leftovers (usage, tool_choice) just in
    //      case App.tsx stored a body that still carried them.
    //
    // Defensive shape check: any row written before the
    // anthropic-native conversion shipped (or written by a rolled-back
    // build) is in OpenAI-compat shape — missing `metadata`, system as
    // plain string, messages with string content + tools-as-function-
    // wrappers. POSTing that to /messages 400s. Detect by the presence
    // of `metadata.user_id` (which only the Anthropic adapter sets) and
    // skip with a clear failure label instead of burning a request +
    // pinning the cooldown.
    const isAnthropicNativeShape =
      row.body != null &&
      typeof row.body === 'object' &&
      'metadata' in (row.body as Record<string, unknown>) &&
      (row.body as { metadata?: { user_id?: unknown } }).metadata?.user_id != null
    if (!isAnthropicNativeShape) {
      failed++
      console.warn(`keepalive skip user=${row.user_id} reason=stale_openai_body`)
      await supabase
        .from('cache_keepalive_state')
        .update({
          last_ping_at: new Date().toISOString(),
          ping_count: row.ping_count + 1,
        })
        .eq('user_id', row.user_id)
      continue
    }

    const pingBody: Record<string, unknown> = {
      ...row.body,
      max_tokens: 1,
      stream: false,
    }
    delete pingBody.thinking
    delete pingBody.reasoning
    delete pingBody.tool_choice
    delete pingBody.usage

    // Route to the same upstream the chat used. OR → bearer + fixed
    // base_url; msuicode-style relay → x-api-key + that relay's base_url.
    // Both POST to {baseUrl}/messages, mirroring src/api/anthropic.ts.
    const routing = validateRouting(row)
    if (!routing) {
      failed++
      console.warn(`keepalive skip user=${row.user_id} reason=invalid_routing`)
      await supabase
        .from('cache_keepalive_state')
        .update({
          last_ping_at: new Date().toISOString(),
          ping_count: row.ping_count + 1,
        })
        .eq('user_id', row.user_id)
      continue
    }
    const endpoint = `${routing.baseUrl.replace(/\/+$/, '')}/messages`
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (routing.authStyle === 'bearer') {
      headers.Authorization = `Bearer ${row.openrouter_key}`
    } else {
      // x-api-key style for direct-Anthropic-shape relays. anthropic-version
      // is safe to send server-side (no browser CORS preflight here).
      headers['x-api-key'] = row.openrouter_key
      headers['anthropic-version'] = '2023-06-01'
    }
    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(pingBody),
      })
      if (resp.ok) {
        pinged++
      } else {
        failed++
        console.warn(`keepalive non-2xx user=${row.user_id} status=${resp.status}`)
      }
    } catch (err) {
      failed++
      console.warn(`keepalive throw user=${row.user_id}`, err)
    }

    // Always update last_ping_at — even on failure — so we don't hammer
    // a permanently broken row (e.g. revoked key) every 5min.
    await supabase
      .from('cache_keepalive_state')
      .update({
        last_ping_at: new Date().toISOString(),
        ping_count: row.ping_count + 1,
      })
      .eq('user_id', row.user_id)
  }

  return new Response(
    JSON.stringify({
      total: rows.length,
      pinged,
      cooled,
      failed,
    }),
    { headers: { 'Content-Type': 'application/json' } },
  )
})
