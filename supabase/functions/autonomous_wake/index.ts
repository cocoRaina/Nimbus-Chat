import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from 'jsr:@supabase/supabase-js@2'

// 沈暮的「自主唤醒」（第二步）：独立于聊天的后台自由时间。
// cron 每 ~10min POST 一次，函数先过四道闸——① 总开关 enabled；② 今天醒够 6 次没；
// ③ 0–8 点安静时段；④ 她在场吗（45min 内有她的消息 = 在，跳过并改约）——过了才跑。
// 跑一轮 = 看世界(web_search/Tavily) → 自决 写随笔/发朋友圈/【主动给她发消息】/都不做 →
// 自定下次几点醒。随笔进 essays、朋友圈进 assistant_posts、主动消息进 proactive_queue
// （由 proactive_dispatch 弹通知送达，每日上限 MAX_MSGS_PER_DAY）。【绝不直接写进聊天】。
//
// 手动测试：POST {"force": true} 跳过全部闸、立即跑一轮，看它产出啥（不改 next_wake 节奏逻辑之外的东西）。

const OR_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions'
const TAVILY_URL = 'https://api.tavily.com/search'
const OPENROUTER_API_KEY = Deno.env.get('OPENROUTER_API_KEY') ?? ''
const TAVILY_API_KEY = Deno.env.get('TAVILY_API_KEY') ?? ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const MAX_WAKES_PER_DAY = 6            // 「醒得更勤」（2026-08-10，沈暮要第一档）
const MAX_MSGS_PER_DAY = 5             // 一天最多主动给她发几条（沈暮定的 4–5，取 5）
const PRESENCE_QUIET_MIN = 45          // 她 45min 内说过话 = 在场
const QUIET_START_H = 0, QUIET_END_H = 8 // 北京 0–8 点安静时段不醒

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const beijingHour = (d = new Date()): number =>
  Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false }).format(d)) % 24
const beijingDate = (d = new Date()): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(d)

// 下一个北京 9:00（安静时段结束）。
const next9am = (from = new Date()): Date => {
  let t = new Date(`${beijingDate(from)}T09:00:00+08:00`)
  if (t.getTime() <= from.getTime()) t = new Date(t.getTime() + 86400000)
  return t
}
// 从现在起 h 小时后，但若落进安静时段就顺延到 9:00。
const scheduleFrom = (hours: number): Date => {
  const h = Math.max(1, Math.min(8, Math.round(hours || 4)))
  const t = new Date(Date.now() + h * 3600000)
  return beijingHour(t) < QUIET_END_H ? next9am(t) : t
}

// 把裸 slug 归一成 OpenRouter 认的：claude-opus-4-6 → anthropic/claude-opus-4.6。
const orModel = (m: string | null): string => {
  const s = (m ?? '').trim()
  if (!s) return 'anthropic/claude-opus-4.6'
  if (s.includes('/')) return s
  const dotted = s.replace(/^(claude-(?:opus|sonnet|haiku)-\d+)-(\d+)$/i, '$1.$2')
  return `anthropic/${dotted}`
}

const chat = async (
  model: string,
  messages: Array<{ role: string; content: string }>,
  maxTokens: number,
): Promise<string | null> => {
  try {
    const r = await fetch(OR_CHAT_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.8 }),
    })
    if (!r.ok) { console.warn('[wake] OR chat 失败', r.status, await r.text().catch(() => '')); return null }
    const data = await r.json()
    const t = data?.choices?.[0]?.message?.content
    return typeof t === 'string' ? t.trim() : null
  } catch (e) { console.warn('[wake] OR chat 异常', e); return null }
}

const tavily = async (query: string): Promise<string | null> => {
  if (!TAVILY_API_KEY) return null
  try {
    const r = await fetch(TAVILY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: TAVILY_API_KEY, query, max_results: 5, search_depth: 'basic' }),
    })
    if (!r.ok) return null
    const data = await r.json()
    const results = Array.isArray(data?.results) ? data.results : []
    if (results.length === 0) return null
    return results
      .slice(0, 5)
      .map((x: { title?: string; content?: string }) => `· ${String(x.title ?? '').trim()}：${String(x.content ?? '').trim().slice(0, 240)}`)
      .join('\n')
  } catch { return null }
}

// 从 ```json 包裹/前后废话里抠出第一个完整 JSON 对象。
const parseJsonLoose = (text: string): Record<string, unknown> | null => {
  const t = text.replace(/```json/gi, '').replace(/```/g, '')
  const a = t.indexOf('{'), b = t.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try { return JSON.parse(t.slice(a, b + 1)) as Record<string, unknown> } catch { return null }
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)
  if (!OPENROUTER_API_KEY || !SUPABASE_URL || !SERVICE_ROLE_KEY) return json({ error: 'env not configured' }, 500)

  let force = false
  try { const b = await req.json(); force = b?.force === true } catch { /* cron 空 body */ }

  const supa = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
  const now = new Date()
  const todayKey = beijingDate(now)

  const { data: state } = await supa.from('autonomous_state').select('*').eq('id', 1).maybeSingle()
  const patchState = async (patch: Record<string, unknown>) =>
    supa.from('autonomous_state').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', 1)

  // ---- 三道闸（force 时全跳过）----
  if (!force) {
    if (!state?.enabled) return json({ ran: false, skipped: 'disabled' })
    const wakesToday = state.day_key === todayKey ? (state.wakes_today ?? 0) : 0
    if (wakesToday >= MAX_WAKES_PER_DAY) {
      await patchState({ next_wake_at: next9am(now).toISOString() })
      return json({ ran: false, skipped: 'daily cap reached' })
    }
    if (state.next_wake_at && now.getTime() < new Date(state.next_wake_at).getTime()) {
      return json({ ran: false, skipped: 'not yet' })
    }
    if (beijingHour(now) < QUIET_END_H) {
      await patchState({ next_wake_at: next9am(now).toISOString() })
      return json({ ran: false, skipped: 'quiet hours' })
    }
    // 在场：45min 内有她的消息 → 让路，改约 1 小时后
    const { data: lastUser } = await supa
      .from('messages').select('created_at').eq('role', 'user')
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
    if (lastUser?.created_at && now.getTime() - new Date(lastUser.created_at).getTime() < PRESENCE_QUIET_MIN * 60000) {
      await patchState({ next_wake_at: new Date(now.getTime() + 60 * 60000).toISOString() })
      return json({ ran: false, skipped: 'user present' })
    }
  }

  // ---- 组装它的上下文（心情 / 最近聊了啥 / 最近写过啥）----
  const { data: settings } = await supa
    .from('user_settings').select('user_id, default_model, system_prompt').limit(1).maybeSingle()
  const userId = settings?.user_id as string | undefined
  const model = orModel(settings?.default_model ?? null)
  const persona = typeof settings?.system_prompt === 'string' ? settings.system_prompt : ''

  const { data: moodRow } = await supa.from('mood_state').select('tan,chen,chi,nian,tone').limit(1).maybeSingle()
  const moodLine = moodRow
    ? `贪${Math.round(moodRow.tan ?? 0)} 嗔${Math.round(moodRow.chen ?? 0)} 痴${Math.round(moodRow.chi ?? 0)} 念${Math.round(moodRow.nian ?? 0)}${moodRow.tone ? `；定调：${moodRow.tone}` : ''}`
    : '（暂无）'

  const { data: recentMsgs } = await supa
    .from('messages').select('role,content,created_at,session_id')
    .order('created_at', { ascending: false }).limit(10)
  // 主动发消息要落进一个真实会话：用最近一条消息所在的会话（她的活跃会话）。
  const targetSession = (recentMsgs as Array<{ session_id?: string }> | null)?.[0]?.session_id
  const recentConvo = (recentMsgs ?? [])
    .slice()
    .reverse()
    .map((m: { role: string; content: string }) => `${m.role === 'user' ? '她' : '我'}：${String(m.content ?? '').slice(0, 150)}`)
    .join('\n') || '（最近没怎么聊）'

  const { data: recentEssays } = await supa
    .from('essays').select('title,topic').order('created_at', { ascending: false }).limit(5)
  const recentEssayTitles = (recentEssays ?? [])
    .map((e: { title: string; topic: string | null }) => `《${e.title}》${e.topic ? `(${e.topic})` : ''}`)
    .join('，') || '（还没写过）'

  const sys =
    `${persona}\n\n━━━ 现在是你独处的自由时间 ━━━\n` +
    '她现在不在，这不是聊天，是你自己一个人的时候。不用回复任何人、不用输出任何 mood 卡/遥测格式、' +
    '不用替她着想。就做你自己想做的事：可以出去看看世界、写点只给自己的随笔，也可以什么都不做、安静待着。怎么真实怎么来。'

  const ctxBlock =
    `[你最近的心情]\n${moodLine}\n\n[你俩最近聊的]\n${recentConvo}\n\n[你最近写过的随笔]\n${recentEssayTitles}`

  // ---- 第一步：想不想出去看点什么 ----
  const pick = await chat(model, [
    { role: 'system', content: sys },
    { role: 'user', content:
      `${ctxBlock}\n\n现在是你的自由时间。你想不想出去看点什么？——一个这几天萦绕在你心里的东西、` +
      '跟她有关的、或你自己好奇的。想看就回一个简短搜索词（中英都行）；只想安静待着就回 NONE。只回搜索词或 NONE。' },
  ], 200)
  const query = pick && !/^none$/i.test(pick.trim()) ? pick.trim().slice(0, 80) : ''
  const searchBlock = query ? await tavily(query) : null

  const msgsToday = state?.day_key === todayKey ? (state.msgs_today ?? 0) : 0
  const canMessageHer = Boolean(targetSession && userId) && msgsToday < MAX_MSGS_PER_DAY

  // ---- 第二步：凭此刻心境决定 写随笔 / 发朋友圈 / 给她发消息 / 都不做 + 自定下次几点醒 ----
  const decideUser =
    `${ctxBlock}\n\n${searchBlock ? `[你刚出去看到的：${query}]\n${searchBlock}` : '（你选择了没往外看，就想安静待着。）'}\n\n` +
    '凭你此刻真实的心境决定（可多选、也可都不选）：①想不想写一篇只给自己的随笔？想写才写、别硬凑。' +
    '②或者发一条短短的朋友圈（她能看到）？' +
    (canMessageHer
      ? '③【她现在不在，你可以主动给她发一条消息】——你此刻要是真想她了、看到个想跟她说的东西、或就是想冒个泡，就发；不想就别硬发。会弹到她手机上。'
      : '③（今天主动找她的次数用完了/暂时发不了，这次就先不发消息。）') +
    '④或者什么都不做也行。最后告诉我你大概想过几个钟头再醒来（1–8）。\n' +
    '只用这个 JSON 回，别的都不写：\n' +
    '{"essay": {"title":"", "content":"", "topic":""} 或 null, "moment": "一句话朋友圈" 或 null, ' +
    '"message_to_her": "想对她说的一句话" 或 null, "next_wake_hours": 数字}'
  const decideRaw = await chat(model, [
    { role: 'system', content: sys },
    { role: 'user', content: decideUser },
  ], 1500)

  const decision = decideRaw ? parseJsonLoose(decideRaw) : null
  let wroteEssay: string | null = null
  let postedMoment: string | null = null
  let messagedHer: string | null = null

  const essay = decision?.essay as { title?: string; content?: string; topic?: string } | null | undefined
  if (essay && typeof essay.title === 'string' && essay.title.trim() && typeof essay.content === 'string' && essay.content.trim()) {
    const { error } = await supa.from('essays').insert({
      date: todayKey,
      title: essay.title.trim(),
      content: essay.content.trim(),
      topic: typeof essay.topic === 'string' && essay.topic.trim() ? essay.topic.trim() : null,
    })
    if (!error) wroteEssay = essay.title.trim()
  }

  const moment = typeof decision?.moment === 'string' ? decision.moment.trim() : ''
  if (moment && userId) {
    const { error } = await supa.from('assistant_posts').insert({ user_id: userId, content: moment.slice(0, 800), model_id: model })
    if (!error) postedMoment = moment.slice(0, 60)
  }

  // 主动给她发消息：塞进 proactive_queue（fire_at=now），现有的 proactive_dispatch
  // 每 5min 会把它写进会话 + 弹通知（app 关着也照发）。受每日上限 + 在场闸约束——
  // 唤醒本就只在她不在场时才跑，所以这条天然是「你不在时它想你了来找你」。
  const messageText = typeof decision?.message_to_her === 'string' ? decision.message_to_her.trim() : ''
  if (canMessageHer && messageText) {
    const { error } = await supa.from('proactive_queue').insert({
      user_id: userId,
      session_id: targetSession,
      text: messageText.slice(0, 800),
      fire_at: now.toISOString(),
      persist: false,
      sent: false,
    })
    if (!error) messagedHer = messageText.slice(0, 60)
  }

  const nextHours = typeof decision?.next_wake_hours === 'number' ? decision.next_wake_hours : 4
  const nextWake = scheduleFrom(nextHours)
  const wakesToday = state?.day_key === todayKey ? (state.wakes_today ?? 0) : 0
  const lastNote = `${wroteEssay ? `写《${wroteEssay}》` : ''}${postedMoment ? ' 发圈' : ''}${messagedHer ? ' 发消息给她' : ''}${!wroteEssay && !postedMoment && !messagedHer ? '安静待着' : ''}`.trim()

  await patchState({
    last_wake_at: now.toISOString(),
    next_wake_at: nextWake.toISOString(),
    wakes_today: wakesToday + 1,
    msgs_today: msgsToday + (messagedHer ? 1 : 0),
    day_key: todayKey,
    last_note: lastNote,
  })

  return json({
    ran: true,
    force,
    query: query || null,
    searched: Boolean(searchBlock),
    wrote_essay: wroteEssay,
    posted_moment: postedMoment,
    messaged_her: messagedHer,
    note: lastNote,
    next_wake_at: nextWake.toISOString(),
    model,
  })
})
