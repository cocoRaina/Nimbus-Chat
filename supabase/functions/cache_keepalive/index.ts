// Server-side cache keepalive — refreshes the Anthropic prompt cache for
// users who were recently active. Called by pg_cron every 5min during
// 08:00–23:00 Asia/Shanghai. Per-user gating + 50min ping cooldown.
//
// Why this exists: the client-side keepalive timer (App.tsx) dies when
// the app is killed/backgrounded on mobile. Without this, any >1h gap
// between chats incurs a fresh cache write (~$2.64 per write on the
// user's typical 88K-token prompt). With this, a single ~$0.13 read
// keeps it alive instead. See README "💰 成本优化" for the full story.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1'

// Asia/Shanghai is UTC+8 with no DST.
const SHANGHAI_OFFSET_HOURS = 8
const WINDOW_START_HOUR = 8
const WINDOW_END_HOUR = 23
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
  openrouter_key: string
  last_chat_at: string
  last_ping_at: string | null
  ping_count: number
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { status: 200 })
  }

  // Window gate. Shanghai hour from UTC.
  const now = new Date()
  const shanghaiHour = (now.getUTCHours() + SHANGHAI_OFFSET_HOURS) % 24
  if (shanghaiHour < WINDOW_START_HOUR || shanghaiHour >= WINDOW_END_HOUR) {
    return new Response(
      JSON.stringify({ skipped: 'outside_window', shanghai_hour: shanghaiHour }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const activeSince = new Date(Date.now() - ACTIVE_WINDOW_MS).toISOString()
  const { data, error } = await supabase
    .from('cache_keepalive_state')
    .select('user_id, body, openrouter_key, last_chat_at, last_ping_at, ping_count')
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

    // Build the minimal ping. Same three rules as the client-side fix
    // (commit 7aebe2a):
    //   1. max_tokens: 1   — Anthropic min; adapter fallback would
    //      otherwise turn the ping into a full generation.
    //   2. keep `tools`    — they're part of the cache key.
    //   3. strip reasoning — otherwise thinking forces max_tokens up
    //      to budget+1024 (~9024) and the ping becomes expensive.
    const pingBody: Record<string, unknown> = {
      ...row.body,
      max_tokens: 1,
      stream: false,
    }
    delete pingBody.reasoning
    delete pingBody.tool_choice
    delete pingBody.usage

    try {
      const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${row.openrouter_key}`,
          'Content-Type': 'application/json',
        },
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
      shanghai_hour: shanghaiHour,
      total: rows.length,
      pinged,
      cooled,
      failed,
    }),
    { headers: { 'Content-Type': 'application/json' } },
  )
})
