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
// Quiet hours: 01:00–08:00 Beijing time (CST/UTC+8; was 00:00 — moved
// 2026-07-09 because the user routinely chats past midnight). No pings
// during this window — the user is asleep, and the 1h TTL will have expired
// before they wake. Their first morning message sets last_chat_at; the next
// 5-min cron tick (after 08:00) picks it up and sends the warm-up ping
// instead of paying a cold-write on the second message.

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
// a chat at any point in the waking day keeps pings going until quiet
// hours begin. 17h (08:00 + 17h = 01:00 next day) is the exact waking-day
// length now that quiet starts at 01:00, and is naturally capped by quiet
// hours + the next-morning today-gate.
const ACTIVE_WINDOW_MS = 17 * 60 * 60 * 1000
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

  // Quiet hours: 01:00–08:00 Beijing time (UTC+8). The user is a night owl
  // who regularly chats past midnight — starting quiet at 01:00 (was 00:00)
  // keeps the cache warm through the 23:xx→00:xx stretch instead of letting
  // it die at the stroke of midnight mid-conversation. Cache then expires
  // ~02:00 and the first morning message cold-writes as designed.
  const nowBeijing = new Date(Date.now() + 8 * 60 * 60 * 1000)
  const beijingHour = nowBeijing.getUTCHours()
  if (beijingHour >= 1 && beijingHour < 8) {
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
  // ⚠️ Use the REAL UTC date's midnight, not the +8h-shifted one. Beijing
  // 08:00 = UTC 00:00, so "this waking day's start" is the current UTC day's
  // midnight — and that stays true even during the 00:00–01:00 Beijing
  // stretch (UTC 16–17h, same UTC day). The old `new Date(nowBeijing)
  // .setUTCHours(0)` shifted the DATE too: during Beijing 00:00–01:00 it
  // produced the NEXT UTC midnight (a future timestamp), which would have
  // filtered out every row exactly in the window the 01:00 quiet-start is
  // meant to serve. Harmless before (that hour was all quiet), fatal after.
  const todayWakingStartMs = new Date().setUTCHours(0, 0, 0, 0)
  const activeSinceMs = Math.max(Date.now() - ACTIVE_WINDOW_MS, todayWakingStartMs)
  // Fetch ALL rows (not .gte-filtered) so we can ALSO see the stale ones.
  // 2026-07-09 incident: the client-side snapshot upsert silently failed for
  // 8 days (7/1–7/8) — last_chat_at froze at 6/30, the today-gate filtered the
  // row out on every tick, and the function happily returned total:0 while the
  // user chatted all day and paid cold writes on every >1h lull. Nothing in
  // usage_logs, nothing in last_ping_at, zero signal. The watchdog below makes
  // that exact failure mode loud.
  const { data, error } = await supabase
    .from('cache_keepalive_state')
    .select(
      'user_id, body, openrouter_key, provider, base_url, auth_style, last_chat_at, last_ping_at, ping_count',
    )

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const allRows = (data ?? []) as KeepaliveRow[]
  const rows = allRows.filter(
    (r) => new Date(r.last_chat_at).getTime() >= activeSinceMs,
  )

  // Watchdog: a row whose last_chat_at is OUTSIDE the ping window is normal
  // when the user simply hasn't chatted today — but if usage_logs shows chat
  // rows INSIDE today's window while the snapshot hasn't moved, the client's
  // post-chat upsert is failing silently (convert throw / RLS / whatever) and
  // keepalive is effectively OFF for that user. Surface it as a usage_logs row
  // (source='keepalive_stale') so it shows up in the 用量统计 page, throttled
  // to one row per 6h per user.
  let staleFlagged = 0
  for (const staleRow of allRows) {
    if (new Date(staleRow.last_chat_at).getTime() >= activeSinceMs) continue
    try {
      const { data: lastChat } = await supabase
        .from('usage_logs')
        .select('created_at')
        .eq('user_id', staleRow.user_id)
        .eq('source', 'chat')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (!lastChat) continue
      const chatMs = new Date(lastChat.created_at as string).getTime()
      // Only flag when real chats are flowing inside today's ping window…
      if (chatMs < activeSinceMs) continue
      // …and give the client's async upsert 10min of grace after a chat so we
      // never race the write that's about to land.
      if (Date.now() - chatMs < 10 * 60 * 1000) continue
      const { data: lastAlert } = await supabase
        .from('usage_logs')
        .select('created_at')
        .eq('user_id', staleRow.user_id)
        .eq('source', 'keepalive_stale')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (
        lastAlert &&
        Date.now() - new Date(lastAlert.created_at as string).getTime() <
          6 * 60 * 60 * 1000
      ) continue
      staleFlagged++
      console.warn(
        `keepalive stale-snapshot user=${staleRow.user_id} snapshot_last_chat_at=${staleRow.last_chat_at} latest_chat_at=${lastChat.created_at}`,
      )
      await supabase.from('usage_logs').insert({
        user_id: staleRow.user_id,
        model: 'keepalive-watchdog',
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        source: 'keepalive_stale',
        provider: staleRow.provider ?? 'openrouter',
        request_debug: {
          snapshot_last_chat_at: staleRow.last_chat_at,
          latest_chat_at: lastChat.created_at,
          note: '聊天在继续但快照 last_chat_at 没有推进——客户端 upsert 在静默失败，保活对这个用户实际是关闭的',
        },
      })
    } catch (err) {
      console.warn(`keepalive stale-check failed user=${staleRow.user_id}`, err)
    }
  }
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
    // Dead-cache guard: if the last touch is beyond the 1h TTL, the cache is
    // already gone and a ping can only COLD-WRITE the full prompt — a pure
    // gamble that the user returns before the fresh write expires. Skip and
    // let their next real message pay the (unavoidable) write instead.
    // In normal operation pings keep the gap ≤50min so this never fires; it
    // only triggers after a blackout (function downtime, deploy gap, quiet-
    // hours edge). MEASURED 2026-07-09 16:25: the quiet-hours change deployed
    // late, the first eligible ping arrived 71min after the last chat and
    // cold-wrote 84,428 tokens for nothing. Deliberately does NOT update
    // last_ping_at — the row keeps being skipped until a real chat restarts
    // the chain.
    if (Date.now() - lastTouchMs > 60 * 60 * 1000) {
      console.warn(
        `keepalive skip user=${row.user_id} reason=cache_already_expired gap_min=${Math.round((Date.now() - lastTouchMs) / 60000)}`,
      )
      continue
    }

    // Build the ping. The body in row.body is Anthropic-native shape (App.tsx
    // converts via convertOpenAiRequestToAnthropic before upserting) so we POST
    // it straight to the relay's /messages endpoint. Overrides:
    //   1. stream: true — must match the chat exactly (see the ⚠️ note at
    //      the pingBody construction below; "stream is neutral" was
    //      relay-specific and got falsified on treegpt 2026-07-09).
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
    //   5. keep `tool_choice` — it IS part of the Anthropic cache key.
    //      Deleting it previously caused a cache-key mismatch vs the real
    //      chat (which sends {type:'auto'}) → cold write on every ping.
    //      `usage` and `reasoning` are dropped defensively (they're OpenAI
    //      response fields that shouldn't appear in a stored Anthropic body).
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

    // ⚠️ stream MUST be true — identical to the real chat. "stream is
    // cache-key-neutral" was measured against 金瓜瓜 and is NOT true on
    // treegpt: MEASURED 2026-07-09 — a stream:false ping at 06:30 cold-wrote
    // the full 53887 tokens (couldn't read the 05:36 streaming chat's warm
    // cache), and the 06:55 streaming chat then cold-wrote AGAIN (couldn't
    // read the ping's 25-minute-old write). Non-stream requests evidently
    // land on a different upstream lineage there, so a non-stream ping warms
    // a copy the chat never reads — the exact §9 false-positive trap, stream
    // edition. Match the chat byte-for-byte and parse SSE for usage instead.
    const pingBody: Record<string, unknown> = {
      ...row.body,
      stream: true,
    }
    // row.body is already Anthropic-native (converted by App.tsx before upsert).
    // `reasoning` and `usage` are OpenAI-specific response fields that should
    // never appear in a stored Anthropic body, but delete them defensively.
    // `tool_choice` must NOT be deleted — the stored body carries it in
    // Anthropic format ({type:'auto'}) which IS part of the cache key. Removing
    // it caused a key mismatch vs the real chat → cold write on every ping.
    delete pingBody.reasoning
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
    // 冷却推进策略（2026-07-22）：只有「成功」或「永久失败」（认证类 401/403，
    // key 真坏了 → 别每 5min 猛戳）才把 last_ping_at 推到现在、走 50min 冷却。
    // 「瞬时失败」（5xx / 429 / 中转"请重试"型 400 / 网络异常）不推进冷却，
    // 让 5min 后的下一跳自动重试——否则一次中转打嗝就白白晾满 50min，而缓存
    // 60min 就过期，用户回来正好撞上冷写（实测 2026-07-22 08:40 的 keepalive_fail
    // 就是这样：一次瞬时 400 烧掉整个续命周期）。
    let advanceCooldown = true
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
          // stream:true → the body is SSE. Buffer it fully (ping output is
          // tiny — thinking budget caps it) and merge usage from
          // message_start (input/cache_read/cache_creation) + message_delta
          // (output_tokens). Fall back to plain JSON in case a relay ignores
          // the stream flag and answers non-streamed.
          const respText = await resp.text()
          type PingUsage = {
            cache_read_input_tokens?: number
            cache_creation_input_tokens?: number
            cache_creation?: { ephemeral_1h_input_tokens?: number }
            input_tokens?: number
            output_tokens?: number
          } & Record<string, unknown>
          let usage: PingUsage = {}
          if (respText.trimStart().startsWith('{')) {
            try {
              usage = (JSON.parse(respText)?.usage ?? {}) as PingUsage
            } catch { /* fall through with empty usage */ }
          } else {
            for (const line of respText.split('\n')) {
              if (!line.startsWith('data:')) continue
              const payload = line.slice(5).trim()
              if (!payload || payload === '[DONE]') continue
              try {
                const evt = JSON.parse(payload) as {
                  type?: string
                  message?: { usage?: Record<string, unknown> }
                  usage?: Record<string, unknown>
                }
                if (evt.type === 'message_start' && evt.message?.usage) {
                  usage = { ...usage, ...evt.message.usage }
                } else if (evt.type === 'message_delta' && evt.usage) {
                  usage = { ...usage, ...evt.usage }
                }
              } catch { /* ignore malformed SSE lines */ }
            }
          }
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
          // 把 ping 记进 usage_logs（source='keepalive'），让用户在「用量统计」
          // 里亲眼看到保活的工作状态：健康 ping = cache_read 很大 + cache_write
          // ≈ 0；ping 在冷写（body 和真实对话对不上 / 缓存已过期）= cache_write
          // 很大——排查「保活开着为什么还冷写」不再需要翻函数日志。
          // raw_usage 存 Anthropic 原生 usage，前端 mapRow 直接读
          // cache_read_input_tokens / cache_creation_input_tokens。
          try {
            await supabase.from('usage_logs').insert({
              user_id: row.user_id,
              model: (pingBody.model as string) ?? 'unknown',
              prompt_tokens: input + cacheRead + cacheCreate1h,
              completion_tokens: output,
              total_tokens: input + cacheRead + cacheCreate1h + output,
              cached_tokens: cacheRead,
              source: 'keepalive',
              provider: row.provider ?? 'openrouter',
              raw_usage: usage,
            })
          } catch (logErr) {
            console.warn(`keepalive usage_logs insert failed user=${row.user_id}`, logErr)
          }
        } catch (parseErr) {
          console.warn(`keepalive ok user=${row.user_id} (couldn't parse usage)`, parseErr)
        }
      } else {
        failed++
        // 瞬时失败不推进冷却 → 下一 5min 跳重试；只有认证类（key 坏）才退避。
        advanceCooldown = resp.status === 401 || resp.status === 403
        const bodyText = await resp.text().catch(() => '')
        console.warn(
          `keepalive non-2xx user=${row.user_id} status=${resp.status} retry=${!advanceCooldown} body=${bodyText.slice(0, 300)}`,
        )
        // 失败也记一行（0 token + request_debug 带状态码），让「ping 发了但
        // 上游拒了」在用量统计里可见——和「还没到 50 分钟没发」区分开。
        try {
          await supabase.from('usage_logs').insert({
            user_id: row.user_id,
            model: (pingBody.model as string) ?? 'unknown',
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
            source: 'keepalive_fail',
            provider: row.provider ?? 'openrouter',
            request_debug: { status: resp.status, body: bodyText.slice(0, 300) },
          })
        } catch (logErr) {
          console.warn(`keepalive fail-row insert failed user=${row.user_id}`, logErr)
        }
      }
    } catch (err) {
      failed++
      // 网络异常 = 瞬时，不推进冷却，让下一跳重试。
      advanceCooldown = false
      console.warn(`keepalive throw user=${row.user_id}`, err)
    }

    // 成功 / 永久失败（认证类）→ 推进 last_ping_at 走 50min 冷却；瞬时失败
    // 保持旧 last_ping_at → 下一 5min 跳仍判定「到期」而重试。ping_count 照增
    // 当尝试计数。
    if (advanceCooldown) {
      await supabase
        .from('cache_keepalive_state')
        .update({
          last_ping_at: new Date().toISOString(),
          ping_count: row.ping_count + 1,
        })
        .eq('user_id', row.user_id)
    } else {
      await supabase
        .from('cache_keepalive_state')
        .update({ ping_count: row.ping_count + 1 })
        .eq('user_id', row.user_id)
    }
  }

  return new Response(
    JSON.stringify({
      total: rows.length,
      pinged,
      cooled,
      failed,
      stale_flagged: staleFlagged,
      usage: usageReport,
    }),
    { headers: { 'Content-Type': 'application/json' } },
  )
})
