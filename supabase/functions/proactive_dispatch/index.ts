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
//   4. 📞 callhome 升级拨号：沉默 ≥5h 且本地时间 12-23 点且今天没打过且
//      勿扰关着 → 写一条 call_invites（pending, 90s 过期）。App 开着就会
//      在 8s 内响铃；关着则过期，用户下次打开转成未接 + 语音留言。
//      纯 DB 写入，不调模型。

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

  // ---- 📞 升级拨号（callhome）----
  const ESCALATION_SILENCE_MS = 5 * 3600_000
  const ESCALATION_MAX_SILENCE_MS = 7 * 24 * 3600_000 // 离开一周以上就别打扰了
  const ESCALATION_REASONS = [
    '好几个小时没有你的消息了，想听听你的声音',
    '安静了一下午，有点想你，打个电话看看你在做什么',
    '忽然很想你，忍不住拨过来了',
  ]
  let escalated = 0

  const { data: states } = await supabase
    .from('call_state')
    .select('user_id, enabled, dnd, tz_offset_minutes, last_escalation_at')
    .eq('enabled', true)
    .eq('dnd', false)

  for (const st of states ?? []) {
    const nowMs = Date.now()
    const tzOffset = (st.tz_offset_minutes as number) ?? 480
    // 本地时间 = UTC + 偏移；用 getUTC* 读，避免函数所在机器时区掺和进来
    const local = new Date(nowMs + tzOffset * 60_000)
    const hour = local.getUTCHours()
    if (hour < 12 || hour >= 23) continue

    // 每天最多一次（按用户本地日历日）
    if (st.last_escalation_at) {
      const lastLocal = new Date(new Date(st.last_escalation_at as string).getTime() + tzOffset * 60_000)
      if (
        lastLocal.getUTCFullYear() === local.getUTCFullYear() &&
        lastLocal.getUTCMonth() === local.getUTCMonth() &&
        lastLocal.getUTCDate() === local.getUTCDate()
      ) continue
    }

    // 沉默时长：全会话最近一条用户消息
    const { data: lastMsg } = await supabase
      .from('messages')
      .select('created_at')
      .eq('user_id', st.user_id)
      .eq('role', 'user')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!lastMsg) continue
    const silence = nowMs - new Date(lastMsg.created_at as string).getTime()
    if (silence < ESCALATION_SILENCE_MS || silence > ESCALATION_MAX_SILENCE_MS) continue

    // 已有没接完的邀请（含 App 关着期间过期未认领的）→ 等它被消化再说
    const { data: live } = await supabase
      .from('call_invites')
      .select('id')
      .eq('user_id', st.user_id)
      .in('status', ['pending', 'ringing'])
      .limit(1)
      .maybeSingle()
    if (live) continue

    const reason = ESCALATION_REASONS[Math.floor(Math.random() * ESCALATION_REASONS.length)]
    const { error: inviteError } = await supabase.from('call_invites').insert({
      user_id: st.user_id,
      reason,
      expires_at: new Date(nowMs + 90_000).toISOString(),
    })
    if (inviteError) {
      console.warn('proactive_dispatch: escalation invite failed', inviteError.message)
      continue
    }
    await supabase
      .from('call_state')
      .update({ last_escalation_at: new Date(nowMs).toISOString(), updated_at: new Date(nowMs).toISOString() })
      .eq('user_id', st.user_id)
    escalated++
  }

  return new Response(
    JSON.stringify({ dispatched, raced, escalated }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
})
