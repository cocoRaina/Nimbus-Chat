// proactive_dispatch — server-side delivery of AI-scheduled proactive messages.
//
// Scheduled flow ONLY (the spontaneous idle-nudge that called the LLM every run
// was removed 2026-06: too expensive). This function does pure DB work — no
// model calls, no tokens — so running it every 5 min is effectively free.
//
//   1. Select proactive_queue rows where fire_at <= now AND sent = false
//   2. Atomic claim via UPDATE SET sent=true WHERE sent=false
//   3. If claimed: INSERT message, touch session, append to keepalive body
//      so the proactive message stays warm in cache (no cold write on the
//      user's next real chat).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1'

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
    // triggered it — skip delivery.
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

    // Append to cache_keepalive_state.body so the next keepalive ping includes
    // this proactive message. Without this, the user's next real chat would
    // have a longer message list than the stored ping body → cold write.
    // (Do NOT touch last_chat_at — dispatch is server activity, not the user's.)
    const { data: ksRow } = await supabase
      .from('cache_keepalive_state')
      .select('body')
      .eq('user_id', entry.user_id)
      .maybeSingle()

    if (ksRow?.body) {
      const body = ksRow.body as Record<string, unknown>
      const messages = Array.isArray(body.messages) ? [...body.messages] : []
      // keepalive body is Anthropic-native: content must be an array of blocks.
      messages.push({ role: 'assistant', content: [{ type: 'text', text: entry.text }] })
      await supabase
        .from('cache_keepalive_state')
        .update({ body: { ...body, messages } })
        .eq('user_id', entry.user_id)
    }

    dispatched++
  }

  return new Response(
    JSON.stringify({ dispatched, raced }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
})
