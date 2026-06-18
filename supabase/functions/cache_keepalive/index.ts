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
// Quiet hours: 00:00–08:00 Beijing time (CST/UTC+8). No pings during this
// window — the user is asleep, and the 1h TTL will have expired before they
// wake. Their first morning message sets last_chat_at; the next 5-min cron
// tick (after 08:00) picks it up and sends the warm-up ping instead of
// paying a cold-write on the second message.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1'

// How long after a user's last successful CHAT we keep pinging. Gated on
// last_chat_at (real activity), NOT last_ping_at — otherwise pings would
// self-perpetuate forever.
//
// History: 4h → 24h → 90min → 3h → today-gate+16h.
//
// The "today-gate" design (current):
//   Ping if and only if last_chat_at is BOTH (a) from today's waking hours
//   (after 08:00 Beijing) AND (b) within ACTIVE_WINDOW_MS. This gives us
//   "ping all waking day after first chat, reset every morning":
//
//   • First morning message cold-writes (cache died overnight in quiet hours)
//     and sets last_chat_at → pings begin immediately after.
//   • Every subsequent chat extends last_chat_at → window slides forward;
//     pings automatically follow each conversation.
//   • At midnight quiet hours kill further pings; cache expires ~1h later.
//   • Next morning at 08:00: last_chat_at is from YESTERDAY → today-gate
//     rejects it → no speculative 08:00 cold-write ping. Only the user's
//     first real message can restart the chain.
//
// Why not a simple large window without the today-gate:
//   A window of >8h would let the 08:00 cron see yesterday-evening's
//   last_chat_at as "still active" and fire a speculative ping that
//   cold-writes (cache long dead). This was the exact 24h-window bug.
//   The today-gate makes window size irrelevant for the morning boundary —
//   set it large enough to cover the full waking day.
//
// ACTIVE_WINDOW_MS only matters intra-day: it must be large enough that
// a chat at any point in the waking day keeps pings going until midnight.
// 16h (08:00 + 16h = 00:00 next day) is the exact waking-day length and
// is naturally capped by quiet hours + the next-morning today-gate.
const ACTIVE_WINDOW_MS = 16 * 60 * 60 * 1000
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

  // Quiet hours: 00:00–08:00 Beijing time (UTC+8). During this window no
  // one is chatting, so ACTIVE_WINDOW_MS already means "no eligible rows"
  // — but we skip early anyway to avoid waking Deno workers 12×/h for zero
  // pings. Pings resume automatically after the user's first morning message
  // updates last_chat_at and the next cron tick fires after 08:00.
  const nowBeijing = new Date(Date.now() + 8 * 60 * 60 * 1000)
  const beijingHour = nowBeijing.getUTCHours()
  if (beijingHour >= 0 && beijingHour < 8) {
    return new Response(
      JSON.stringify({ total: 0, pinged: 0, cooled: 0, failed: 0, quiet_hours: true }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  // Today-gate: only ping rows whose last_chat_at is from TODAY's waking
  // hours (after 08:00 Beijing = 00:00 UTC). This prevents the 08:00 cron
  // from speculatively re-warming off yesterday-evening's last_chat_at —
  // which would cold-write (cache long expired) before the user even wakes.
  // Beijing 08:00 = UTC 00:00, so "today's waking start" is simply today's
  // UTC midnight.
  const todayWakingStartMs = new Date(nowBeijing).setUTCHours(0, 0, 0, 0)
  const activeSince = new Date(
    Math.max(Date.now() - ACTIVE_WINDOW_MS, todayWakingStartMs),
  ).toISOString()
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
  // Surface per-ping usage in the HTTP response too (not just console.log),
  // so callers can read cache_read/cache_create without scraping function
  // stdout — which Supabase's log API doesn't reliably expose.
  const usageReport: Array<Record<string, unknown>> = []

  for (const row of rows) {
    // Cooldown gate on the LAST CACHE TOUCH — whichever is later, the last
    // ping OR the last real chat. Both equally warm the cache (each is a
    // request to the relay that reads/writes the same prompt-cache entry), so
    // a recent chat makes a ping redundant: the chat already kept it warm.
    // Gating on last_ping_at alone (the old behaviour) fired a wasteful
    // ¥0.07 ping every 50min even mid-conversation — and one ~5min after the
    // morning's first chat (last_ping_at was null → no gate). Using
    // max(last_ping_at, last_chat_at) suppresses those: the ping now only
    // fires to bridge a genuine ≥50min lull in chatting, never on top of it.
    // Correctness: every touch resets this 50min timer and 50min < the 60min
    // cache TTL, so the cache still never expires inside an active window.
    const lastPingMs = row.last_ping_at ? new Date(row.last_ping_at).getTime() : 0
    const lastTouchMs = Math.max(lastPingMs, new Date(row.last_chat_at).getTime())
    if (lastTouchMs > cooldownCutoffMs) {
      cooled++
      continue
    }

    // Build the ping. The body in row.body is Anthropic-native shape (App.tsx
    // converts via convertOpenAiRequestToAnthropic before upserting) so we POST
    // it straight to the relay's /messages endpoint. Overrides:
    //   1. stream: false   — no SSE needed; proven cache-key-neutral (a
    //      non-stream ping reads a streamed chat's cache: both hit 65931).
    //   2. KEEP `thinking` exactly as the chat sent it — this is the whole
    //      ballgame. MEASURED 2026-06-17 against 金瓜瓜: a thinking-FUL chat
    //      caches at cache_read=65931; a thinking-LESS ping caches at 65909 —
    //      a DISJOINT entry. So a thinking-less ping warms a copy the real
    //      (thinking-ful) chat never reads → the chat still cold-writes every
    //      morning while the ping looked "successful" reading its own private
    //      lineage. (The earlier "dropping thinking is safe, reads 65909" note
    //      was this exact false positive — one ping reading another ping.)
    //      Keeping thinking → the ping reads 65931, the SAME bytes the chat
    //      wrote, so it genuinely keeps the chat's cache warm.
    //   3. max_tokens = thinking.budget_tokens + 1 — extended thinking requires
    //      max_tokens > budget. The budget is a CEILING not a target: the model
    //      emits ~26 output tokens for this trivial continuation, so the ping is
    //      ~¥0.07 (≈ a pure cache read), not the ¥0.30+ a full budget would
    //      cost. max_tokens is cache-key-neutral (2001 vs 3024 both read 65931)
    //      so shrinking it only caps worst-case output, never the hit. The
    //      budget VALUE, however, IS part of the cache key (budget 1024 vs 2000
    //      cold-wrote in testing) so we must reuse the chat's budget verbatim —
    //      never normalize it. No-thinking rows (older Claude / thinking off):
    //      max_tokens: 1.
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
      stream: false,
    }
    delete pingBody.reasoning
    delete pingBody.tool_choice
    delete pingBody.usage
    // Keep `thinking`; size max_tokens to satisfy extended thinking's
    // max_tokens > budget_tokens rule while capping output. Adaptive thinking
    // (Opus 4.7+, `{type:'adaptive'}` with no budget_tokens) has no budget
    // floor — leave its stored max_tokens as-is. No thinking → minimal ping.
    const thinking = pingBody.thinking as
      | { type?: string; budget_tokens?: number }
      | undefined
    if (thinking && typeof thinking.budget_tokens === 'number') {
      pingBody.max_tokens = thinking.budget_tokens + 1
    } else if (!thinking) {
      pingBody.max_tokens = 1
    }

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
        // Log the usage so we can debug whether the ping actually hit
        // cache or paid full input rates. Without this we have no visibility
        // — Supabase Edge Function logs only show HTTP status, and treegpt's
        // dashboard is the only place we see usage. With this we can grep the
        // function logs for "keepalive ok ... cache_read=X cache_write=Y"
        // and instantly tell whether the cache is being kept warm.
        try {
          const respJson = await resp.json()
          const usage = respJson?.usage ?? {}
          const cacheRead = usage.cache_read_input_tokens ?? 0
          const cacheCreate1h =
            usage.cache_creation?.ephemeral_1h_input_tokens ??
            usage.cache_creation_input_tokens ??
            0
          const input = usage.input_tokens ?? 0
          const output = usage.output_tokens ?? 0
          // Body fingerprint: message count + last-3 role sequence + last
          // message content prefix. Used to diagnose cold-write mysteries:
          // grep logs for "keepalive ok" before/after a cold write and
          // compare msg_count + tail — a divergence means the ping body
          // drifted from what the real chat sent.
          const pingMsgs = Array.isArray(pingBody.messages) ? pingBody.messages as Array<{role:string;content:unknown}> : []
          const msgCount = pingMsgs.length
          const tail = pingMsgs.slice(-3).map((m) => m.role).join(',')
          const lastContent = pingMsgs[pingMsgs.length - 1]?.content
          const lastSnippet = typeof lastContent === 'string'
            ? lastContent.slice(0, 40).replace(/\n/g, '↵')
            : Array.isArray(lastContent)
              ? JSON.stringify(lastContent[0]).slice(0, 40)
              : ''
          usageReport.push({
            user_id: row.user_id,
            provider: row.provider,
            input_tokens: input,
            output_tokens: output,
            cache_read: cacheRead,
            cache_create: cacheCreate1h,
          })
          console.log(
            `keepalive ok user=${row.user_id} provider=${row.provider} input=${input} output=${output} cache_read=${cacheRead} cache_create=${cacheCreate1h} msgs=${msgCount} tail=${tail} last=${lastSnippet}`,
          )
        } catch (parseErr) {
          console.warn(`keepalive ok user=${row.user_id} (couldn't parse usage)`, parseErr)
        }
      } else {
        failed++
        const bodyText = await resp.text().catch(() => '')
        console.warn(
          `keepalive non-2xx user=${row.user_id} status=${resp.status} body=${bodyText.slice(0, 300)}`,
        )
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
      usage: usageReport,
    }),
    { headers: { 'Content-Type': 'application/json' } },
  )
})
