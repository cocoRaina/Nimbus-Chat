// proactive_dispatch — server-side delivery of AI-scheduled proactive messages
// + spontaneous AI-initiated messages when user is idle.
//
// Scheduled flow (unchanged):
//   1. Select proactive_queue rows where fire_at <= now AND sent = false
//   2. Atomic claim via UPDATE SET sent=true WHERE sent=false
//   3. If claimed: INSERT message, touch session, update keepalive body
//
// Spontaneous flow (new, runs after scheduled):
//   - Triggers when: last msg was scheduled proactive →30min idle / otherwise →1h idle
//   - Calls user's real model (Anthropic-native) with recent conversation context
//   - AI returns either a message to send or "NO_SEND"
//   - Cooldown: 2h after sending, 30min after NO_SEND / error

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1'

const IDLE_THRESHOLD_MS          = 60 * 60 * 1000  // default: 1h silence
const IDLE_THRESHOLD_AFTER_SCH_MS = 30 * 60 * 1000  // after scheduled proactive, no reply: 30min
const COOLDOWN_AFTER_SEND_MS = 2 * 60 * 60 * 1000
const COOLDOWN_AFTER_SKIP_MS = 30 * 60 * 1000
const ALLOWED_AUTH_STYLES = new Set(['bearer', 'x-api-key'])

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { status: 200 })
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const now = new Date().toISOString()

  const { data: entries, error: fetchError } = await supabase
    .from('proactive_queue')
    .select('id, user_id, session_id, text, fire_at, persist, created_at')
    .lte('fire_at', now)
    .eq('sent', false)

  if (fetchError) {
    return new Response(JSON.stringify({ error: fetchError.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  let dispatched = 0
  let raced = 0

  for (const entry of entries ?? []) {
    // Atomic claim: only one of (client / this cron) will see sent=false here.
    const { data: claimed } = await supabase
      .from('proactive_queue')
      .update({ sent: true })
      .eq('id', entry.id)
      .eq('sent', false)
      .select('id')
      .maybeSingle()

    if (!claimed) {
      raced++
      continue
    }

    const fireAt = entry.fire_at as string
    const persist = entry.persist as boolean

    // For non-persist reminders: if the user was active at any point after
    // this proactive was SCHEDULED, they're already past the context that
    // triggered it — skip delivery. (fire_at is in the future relative to
    // scheduling, so checking created_at catches activity between schedule
    // and fire_at that the fire_at check would miss.)
    // For persist alarms (wake-up, etc.): only skip if user replied AFTER
    // fire_at — the alarm should still ring even if they chatted before bed.
    const activityCutoff = persist ? fireAt : (entry.created_at as string)
    const { data: userReplied } = await supabase
      .from('messages')
      .select('id')
      .eq('session_id', entry.session_id)
      .eq('role', 'user')
      .gt('created_at', activityCutoff)
      .limit(1)
      .maybeSingle()

    if (userReplied) {
      raced++
      continue
    }

    const { error: msgError } = await supabase.from('messages').insert({
      session_id: entry.session_id,
      user_id: entry.user_id,
      role: 'assistant',
      content: entry.text,
      client_id: `proactive-server-${entry.id}`,
      client_created_at: fireAt,
      meta: { model: 'proactive', provider: 'server' },
    })

    if (msgError) {
      // Roll back claim so client can retry on next open.
      await supabase.from('proactive_queue').update({ sent: false }).eq('id', entry.id)
      console.warn('proactive_dispatch: insert failed', msgError.message)
      continue
    }

    // Touch session so refreshRemoteSessions picks up the change.
    await supabase
      .from('sessions')
      .update({ updated_at: now })
      .eq('id', entry.session_id)

    // Update cache_keepalive_state so the next keepalive ping includes this
    // proactive message in body.messages. Without this, the user's next real
    // chat would have a longer message list than the stored ping body → cold write.
    //
    // Do NOT update last_chat_at here. The dispatch is server activity, not
    // user activity. Touching last_chat_at resets the keepalive cooldown to
    // dispatch time, which can suppress the next scheduled ping (e.g. a
    // 23:55 ping after a 23:43 dispatch) and cause the cache to expire
    // earlier than it would have. It also makes the today-gate pass for
    // morning dispatches, triggering a cold-write ping before the user
    // has even opened the app — costing ¥1.32 unnecessarily.
    const { data: ksRow } = await supabase
      .from('cache_keepalive_state')
      .select('body')
      .eq('user_id', entry.user_id)
      .maybeSingle()

    if (ksRow?.body) {
      const body = ksRow.body as Record<string, unknown>
      const messages = Array.isArray(body.messages) ? [...body.messages] : []
      // keepalive body is Anthropic-native: content must be an array of blocks,
      // not a plain string, or the cache key won't match the real chat's format.
      messages.push({ role: 'assistant', content: [{ type: 'text', text: entry.text }] })
      await supabase
        .from('cache_keepalive_state')
        .update({ body: { ...body, messages } })
        .eq('user_id', entry.user_id)
    }

    dispatched++
  }

  // ── Spontaneous AI-initiated messages ──────────────────────────────────────
  // After dispatching all scheduled messages, check if conditions are met to
  // ask the AI to spontaneously reach out to the user.

  let spontaneous: string = 'skipped'

  // Don't send spontaneous if a scheduled proactive just fired this run —
  // two messages arriving simultaneously would be jarring.
  if (dispatched > 0) {
    spontaneous = 'scheduled_sent'
  } else {

  // We need a user to work with. Use the first user found in cache_keepalive_state
  // that has API config (this function is called per-project, single-user assumed).
  const { data: ksConfig } = await supabase
    .from('cache_keepalive_state')
    .select('user_id, base_url, api_key, auth_style, model, body, proactive_ai_cooldown_until')
    .maybeSingle()

  if (!ksConfig) {
    spontaneous = 'no_config'
  } else {
    const { user_id, base_url, api_key, auth_style, model, proactive_ai_cooldown_until } = ksConfig as {
      user_id: string
      base_url: string | null
      api_key: string | null
      auth_style: string | null
      model: string | null
      body: Record<string, unknown> | null
      proactive_ai_cooldown_until: string | null
    }

    // Validate routing: must be Anthropic-native path (https:// base_url, valid auth_style)
    const validRouting =
      base_url &&
      base_url.startsWith('https://') &&
      api_key &&
      auth_style &&
      ALLOWED_AUTH_STYLES.has(auth_style) &&
      model

    if (!validRouting) {
      spontaneous = 'bad_routing'
    } else if (proactive_ai_cooldown_until && new Date(proactive_ai_cooldown_until) > new Date()) {
      spontaneous = 'cooldown'
    } else if (((new Date().getUTCHours() + 8) % 24) < 8) {
      // 00:00-08:00 CST (UTC+8) — don't disturb during sleep hours
      spontaneous = 'nighttime'
    } else {
      // Find the most recent message (user or assistant) across all sessions for this user
      const { data: lastUserMsg } = await supabase
        .from('messages')
        .select('created_at, session_id, meta')
        .eq('user_id', user_id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (!lastUserMsg) {
        spontaneous = 'no_messages'
      } else {
        const idleMs = Date.now() - new Date(lastUserMsg.created_at as string).getTime()
        // If the last message was a scheduled proactive (dispatched by this function,
        // provider='server') and the user hasn't replied yet, be more eager: 30min.
        // In all other cases (normal conversation silence), wait the full hour.
        const lastMsgProvider = (lastUserMsg.meta as { provider?: string } | null)?.provider
        const idleThreshold = lastMsgProvider === 'server'
          ? IDLE_THRESHOLD_AFTER_SCH_MS
          : IDLE_THRESHOLD_MS

        // Today-gate: mirrors cache_keepalive — only fire spontaneous if the
        // user has sent at least one message today (after 08:00 Beijing = UTC 00:00).
        // Prevents the AI from reaching out based on yesterday's last message
        // before the user has even woken up and started their day.
        const nowBeijingMs = Date.now() + 8 * 60 * 60 * 1000
        const todayWakingStartMs = new Date(nowBeijingMs).setUTCHours(0, 0, 0, 0)
        const lastMsgMs = new Date(lastUserMsg.created_at as string).getTime()

        if (lastMsgMs < todayWakingStartMs) {
          spontaneous = 'not_active_today'
        } else if (idleMs < idleThreshold) {
          spontaneous = 'active'
        } else {
          // Check no pending scheduled proactives (don't double-send)
          const { count: pendingCount } = await supabase
            .from('proactive_queue')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', user_id)
            .eq('sent', false)

          if ((pendingCount ?? 0) > 0) {
            spontaneous = 'pending_exists'
          } else {
            // Get last 20 messages from the most recent session
            const { data: recentMsgs } = await supabase
              .from('messages')
              .select('role, content')
              .eq('session_id', lastUserMsg.session_id)
              .order('created_at', { ascending: false })
              .limit(20)

            const history = (recentMsgs ?? [])
              .reverse()
              .map((m) => ({
                role: m.role as 'user' | 'assistant',
                content: [{ type: 'text', text: String(m.content ?? '').slice(0, 800) }],
              }))
            // Anthropic requires the FIRST message to be role 'user'. The 20-msg
            // window can begin on an assistant turn (mid-conversation cut, or a
            // prior proactive/spontaneous message) → 400. Drop leading assistant
            // turns so the array always starts with user.
            while (history.length > 0 && history[0].role !== 'user') history.shift()
            // Append a synthetic user turn so the array ENDS on user. The normal
            // idle case ends with the AI's last reply (assistant); without this,
            // Claude would "continue" that reply instead of writing a fresh
            // standalone message.
            const triggerTurn = {
              role: 'user' as const,
              content: [{ type: 'text', text: '（系统：现在请你按上面的指示，决定是否主动给我发一条消息。）' }],
            }
            const contextMessages = [...history, triggerTurn]

            // Volatile per-run instruction block: appended AFTER the cached system
            // so it never disturbs the cache_control prefix (idle minutes changes
            // every run, so it must stay outside the cached bytes).
            const idleMinutes = Math.round(idleMs / 60000)
            const spontaneousBlock = {
              type: 'text',
              text:
                `\n\n---\n你现在处于"主动触达"模式。对话已经沉默了 ${idleMinutes} 分钟（包括你自己发的消息）。` +
                `\n请根据上面的对话历史，决定是否要主动发一条消息给用户。` +
                `\n- 如果你觉得合适，直接输出你想发送的消息内容（简短自然，像朋友一样）。` +
                `\n- 如果你觉得不需要打扰，只输出 NO_SEND（不要输出其他任何内容）。` +
                `\n不要解释你的决定。`,
            }

            // Reuse the FULL keepalive body so EVERY cache-key component matches
            // the warm lineage the keepalive ping refreshes every ~55min: tools
            // (part of the cached prefix — dropping them changes the key), system
            // (with its cache_control breakpoints), thinking/budget (a thinking-ful
            // vs thinking-less request lands on DISJOINT cache lineages, measured),
            // and metadata.user_id (sticky upstream routing). We only swap in the
            // spontaneous system tail + the trigger messages. Sending a bare system
            // without tools/thinking would MISS the warm cache and — because system
            // still carries cache_control — COLD-WRITE ~¥1.5 each run, the opposite
            // of the optimization. See docs/caching.md + docs/changelog.md.
            const ksBody = ksConfig.body as Record<string, unknown> | null
            const ksBodySystem = ksBody?.system
            let requestBody: Record<string, unknown>
            if (ksBody && Array.isArray(ksBodySystem) && ksBodySystem.length > 0) {
              requestBody = {
                ...ksBody,
                system: [...ksBodySystem, spontaneousBlock],
                messages: contextMessages,
                stream: false,
              }
              delete requestBody.reasoning
              delete requestBody.usage
              // Keep `tools` (cache prefix) but forbid calls so the model emits a
              // text decision instead of a tool_use. tool_choice is NOT part of the
              // cache key (proven by the tool-iteration fix), so this keeps the hit.
              if (Array.isArray(requestBody.tools) && (requestBody.tools as unknown[]).length > 0) {
                requestBody.tool_choice = { type: 'none' }
              } else {
                delete requestBody.tool_choice
              }
              // max_tokens is cache-key-neutral, so size it freely: extended
              // thinking requires max_tokens > budget_tokens, with headroom for a
              // short reply. Adaptive / no-thinking: a modest cap is plenty. The
              // budget is a ceiling, not a target — the model self-limits on a
              // trivial "should I message?" decision, so cost stays ~¥0.1.
              const th = requestBody.thinking as { type?: string; budget_tokens?: number } | undefined
              requestBody.max_tokens =
                th?.type === 'enabled' && typeof th.budget_tokens === 'number'
                  ? th.budget_tokens + 1024
                  : 1024
            } else {
              // Fallback: no warm keepalive body yet (first run / cold start).
              // Plain-string system → NO cache_control → no cold-write risk, just
              // a small full-price request.
              const { data: settingsRow } = await supabase
                .from('user_settings')
                .select('system_prompt')
                .eq('user_id', user_id)
                .maybeSingle()
              const systemPrompt = (settingsRow?.system_prompt as string | null) ?? ''
              requestBody = {
                model: model,
                max_tokens: 1024,
                system: systemPrompt + spontaneousBlock.text,
                messages: contextMessages,
              }
            }

            // Build auth headers matching the Anthropic-native path used by keepalive
            const headers: Record<string, string> = {
              'Content-Type': 'application/json',
              'anthropic-version': '2023-06-01',
            }
            if (auth_style === 'bearer') {
              headers['Authorization'] = `Bearer ${api_key}`
            } else {
              headers['x-api-key'] = api_key!
            }

            try {
              const endpoint = `${base_url!.replace(/\/$/, '')}/messages`
              const resp = await fetch(endpoint, {
                method: 'POST',
                headers,
                body: JSON.stringify(requestBody),
              })

              if (!resp.ok) {
                const errText = await resp.text().catch(() => '')
                console.warn('spontaneous: API error', resp.status, errText.slice(0, 200))
                // Back off on failure (e.g. credit exhausted / rate limit) so we
                // don't re-hit a broken API every 5-min cron tick.
                await supabase
                  .from('cache_keepalive_state')
                  .update({ proactive_ai_cooldown_until: new Date(Date.now() + COOLDOWN_AFTER_SKIP_MS).toISOString() })
                  .eq('user_id', user_id)
                spontaneous = 'api_error'
              } else {
                const respJson = await resp.json() as {
                  content?: Array<{ type: string; text?: string }>
                }
                const text = (respJson.content?.[0]?.text ?? '').trim()

                if (!text || text === 'NO_SEND') {
                  // Set 30min cooldown so we don't hammer the API
                  const cooldownUntil = new Date(Date.now() + COOLDOWN_AFTER_SKIP_MS).toISOString()
                  await supabase
                    .from('cache_keepalive_state')
                    .update({ proactive_ai_cooldown_until: cooldownUntil })
                    .eq('user_id', user_id)
                  spontaneous = 'no_send'
                } else {
                  // Insert the spontaneous message
                  const clientId = `spontaneous-${Date.now()}`
                  const { error: insertErr } = await supabase.from('messages').insert({
                    session_id: lastUserMsg.session_id,
                    user_id,
                    role: 'assistant',
                    content: text,
                    client_id: clientId,
                    client_created_at: now,
                    meta: { model: model, provider: 'spontaneous' },
                  })

                  if (insertErr) {
                    console.warn('spontaneous: insert failed', insertErr.message)
                    spontaneous = 'insert_error'
                  } else {
                    // Touch session + update keepalive body
                    await supabase
                      .from('sessions')
                      .update({ updated_at: now })
                      .eq('id', lastUserMsg.session_id)

                    if (ksConfig.body) {
                      const body = ksConfig.body as Record<string, unknown>
                      const messages = Array.isArray(body.messages) ? [...body.messages] : []
                      messages.push({ role: 'assistant', content: [{ type: 'text', text }] })
                      const cooldownUntil = new Date(Date.now() + COOLDOWN_AFTER_SEND_MS).toISOString()
                      await supabase
                        .from('cache_keepalive_state')
                        .update({ body: { ...body, messages }, proactive_ai_cooldown_until: cooldownUntil })
                        .eq('user_id', user_id)
                    } else {
                      const cooldownUntil = new Date(Date.now() + COOLDOWN_AFTER_SEND_MS).toISOString()
                      await supabase
                        .from('cache_keepalive_state')
                        .update({ proactive_ai_cooldown_until: cooldownUntil })
                        .eq('user_id', user_id)
                    }

                    spontaneous = 'sent'
                  }
                }
              }
            } catch (e) {
              console.warn('spontaneous: fetch error', String(e).slice(0, 200))
              // Back off on network failure too, same rationale as api_error.
              await supabase
                .from('cache_keepalive_state')
                .update({ proactive_ai_cooldown_until: new Date(Date.now() + COOLDOWN_AFTER_SKIP_MS).toISOString() })
                .eq('user_id', user_id)
              spontaneous = 'fetch_error'
            }
          }
        }
      }
    }
  }

  } // end spontaneous else block

  return new Response(JSON.stringify({ dispatched, raced, now, spontaneous }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
