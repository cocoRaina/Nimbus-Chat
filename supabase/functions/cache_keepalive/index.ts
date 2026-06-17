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
// History: 4h → 24h → 90min → 3h. 24h was meant to keep the cache warm
// overnight for the "chat last evening, chat tomorrow morning" pattern. But
// two things killed that rationale:
//   1. The 00:00–08:00 quiet-hours gate (below) now blocks every night ping
//      anyway, so the cache dies overnight regardless of how big this window
//      is — the 24h "keep it warm till morning" benefit was already moot.
//   2. Worse, a 24h window made the 08:00 cron tick speculatively re-warm
//      off YESTERDAY's chat — a ~¥1.32 cold write fired before the user even
//      woke up (cache long expired, so the ping WRITES instead of reads),
//      then often expired again before the real morning message. Pure waste.
// The window makes pings follow real chatting: gated on last_chat_at, it
// resumes only after a fresh chat (including the morning's first message,
// which restarts the chain) and stops this many minutes after you go idle.
// The morning's first message pays one unavoidable cold write (cache died
// overnight) — that rides on a message you wanted to send anyway — and every
// later message in the session stays cheap.
//
// Why 3h (not 90min): the window must comfortably exceed the 50min ping
// cooldown so at least one keepalive ping chains off each chat — 90min did
// that. But 90min meant a >90min lull (lunch, a long meeting, an afternoon
// out) let the cache die → ¥1.32 cold write on return. The breakeven for
// extending the window is cheap: one extra speculative ping if you DON'T come
// back costs ¥0.07; bridging the gap if you DO saves ¥1.32 — so extending
// pays off whenever the odds of returning exceed ~5%. 3h covers the common
// "back in a couple hours" pattern (post-lunch, errands) at a worst-case cost
// of ~2 extra ¥0.07 pings when you've genuinely left. Bounded so it still
// can't speculatively re-warm a half-day-old chat the way 24h did.
const ACTIVE_WINDOW_MS = 3 * 60 * 60 * 1000
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
  // Surface per-ping usage in the HTTP response too (not just console.log),
  // so callers can read cache_read/cache_create without scraping function
  // stdout — which Supabase's log API doesn't reliably expose.
  const usageReport: Array<Record<string, unknown>> = []

  for (const row of rows) {
    if (row.last_ping_at && new Date(row.last_ping_at).getTime() > cooldownCutoffMs) {
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
          usageReport.push({
            user_id: row.user_id,
            provider: row.provider,
            input_tokens: input,
            output_tokens: output,
            cache_read: cacheRead,
            cache_create: cacheCreate1h,
          })
          console.log(
            `keepalive ok user=${row.user_id} provider=${row.provider} input=${input} output=${output} cache_read=${cacheRead} cache_create=${cacheCreate1h}`,
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
