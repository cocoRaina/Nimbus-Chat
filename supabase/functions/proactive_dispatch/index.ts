// proactive_dispatch — server-side delivery of AI-scheduled proactive messages.
// Called by pg_cron every 5 minutes (same cadence as cache_keepalive).
//
// Flow:
//   1. Select all proactive_queue rows where fire_at <= now AND sent = false
//   2. For each, UPDATE SET sent = true WHERE sent = false (atomic claim)
//   3. If claim succeeded, INSERT into messages with client_created_at = fire_at
//   4. Touch sessions.updated_at so the client sees a change on next refresh
//   5. Update cache_keepalive_state to include the proactive message in body,
//      so the next keepalive ping uses the correct (up-to-date) cache key.
//
// Claim logic (UPDATE WHERE sent=false) makes client + server race safe:
// whichever side wins the UPDATE, the other finds sent=true and skips.

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
    .select('id, user_id, session_id, text, fire_at')
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
    const { data: ksRow } = await supabase
      .from('cache_keepalive_state')
      .select('body')
      .eq('user_id', entry.user_id)
      .maybeSingle()

    if (ksRow?.body) {
      const body = ksRow.body as Record<string, unknown>
      const messages = Array.isArray(body.messages) ? [...body.messages] : []
      messages.push({ role: 'assistant', content: entry.text })
      await supabase
        .from('cache_keepalive_state')
        .update({ body: { ...body, messages }, last_chat_at: now })
        .eq('user_id', entry.user_id)
    }

    dispatched++
  }

  return new Response(JSON.stringify({ dispatched, raced, now }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
