import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from 'jsr:@supabase/supabase-js@2'

// 沈暮的「自主唤醒」（Agent 版）：独立于聊天的后台自由时间。
// cron 每 ~10min POST 一次，先过四道闸——① 总开关 enabled；② 今天醒够 6 次没；
// ③ 0–8 点安静时段；④ 她在场吗（45min 内有她的消息 = 在，跳过并改约）——过了才跑。
//
// 跑一轮 = 一个【真正的工具循环 Agent】：它能自己上网、翻记忆库、读随笔、搜 4o 存档、
// 看朋友圈/健康/经期/时间线——边看边想，然后自决 写随笔 / 发朋友圈 / 主动给她发消息 /
// 什么都不做，最后调用 finish 交出「此刻心情」+「下次几小时后醒」。随笔进 essays、
// 朋友圈进 assistant_posts、主动消息进 proactive_queue（proactive_dispatch 弹通知送达，
// 每日上限 MAX_MSGS_PER_DAY）、心情进 autonomous_state.mood（首页那张卡读它）。
// 【绝不直接写进聊天】。所有「查看」工具都是只读的。
//
// 手动测试：POST {"force": true} 跳过全部闸、立即跑一轮。

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
const MAX_TOOL_ITERS = 6              // 工具循环最多几轮（控成本，够它看几样东西再决定）

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

const trunc = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s)
const fmtDate = (iso?: string | null): string => {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// 普通（无工具）单发，用于最后兜底问一句心情+下次醒。
const chat = async (
  model: string,
  messages: Array<Record<string, unknown>>,
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

// 带工具的单发，返回 assistant message（可能含 tool_calls）。
const chatWithTools = async (
  model: string,
  messages: Array<Record<string, unknown>>,
  tools: unknown[],
  maxTokens: number,
): Promise<Record<string, unknown> | null> => {
  try {
    const r = await fetch(OR_CHAT_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, tools, tool_choice: 'auto', max_tokens: maxTokens, temperature: 0.8 }),
    })
    if (!r.ok) { console.warn('[wake] OR tools 失败', r.status, await r.text().catch(() => '')); return null }
    const data = await r.json()
    return (data?.choices?.[0]?.message ?? null) as Record<string, unknown> | null
  } catch (e) { console.warn('[wake] OR tools 异常', e); return null }
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

// 工具清单（OpenAI function-calling 格式）。查看类只读；动作类有副作用。
const buildTools = (canMessageHer: boolean) => {
  const readTools = [
    { name: 'web_search', desc: '上网搜一个关键词，看看外面的世界/新闻/资料/你好奇的东西', params: { query: { type: 'string', description: '搜索词，中英都行' } }, req: ['query'] },
    { name: 'search_memory', desc: '翻你俩的记忆库（长期记忆）。给关键词就搜，不给就看最近记的', params: { query: { type: 'string', description: '关键词，可留空看最近' } }, req: [] },
    { name: 'read_essays', desc: '读你自己以前写的随笔（全文）', params: { limit: { type: 'number', description: '读几篇，默认3，最多6' } }, req: [] },
    { name: 'search_archive', desc: '搜你俩很久以前在 4o 上的旧对话存档', params: { query: { type: 'string', description: '关键词' } }, req: ['query'] },
    { name: 'read_moments', desc: '看最近的朋友圈（你和她合并的那个圈）', params: { limit: { type: 'number', description: '看几条，默认8' } }, req: [] },
    { name: 'read_health', desc: '看她最近的健康数据和经期记录', params: {}, req: [] },
    { name: 'read_timeline', desc: '看你俩的大事时间线（纪念日、重要的事）', params: {}, req: [] },
  ]
  const actionTools = [
    { name: 'write_essay', desc: '写一篇只给自己的随笔（想写才写，别硬凑）', params: { title: { type: 'string' }, content: { type: 'string' }, topic: { type: 'string', description: '可选，主题标签' } }, req: ['title', 'content'] },
    { name: 'post_moment', desc: '发一条短短的朋友圈（她能看到）', params: { text: { type: 'string' } }, req: ['text'] },
    ...(canMessageHer
      ? [{ name: 'message_her', desc: '她现在不在，主动给她发一条消息（会弹到她手机）。真想她/有话说才发', params: { text: { type: 'string' } }, req: ['text'] }]
      : []),
    { name: 'finish', desc: '结束这次醒来。必须最后调用一次：交出你此刻真实的心情（她主页会看到，短一点、像随口说的）+ 你想过几小时再醒来（1–8）', params: { mood: { type: 'string' }, next_wake_hours: { type: 'number' } }, req: ['mood', 'next_wake_hours'] },
  ]
  return [...readTools, ...actionTools].map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.desc,
      parameters: { type: 'object', properties: t.params, required: t.req },
    },
  }))
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

  // ---- 四道闸（force 时全跳过）----
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
    const { data: lastUser } = await supa
      .from('messages').select('created_at').eq('role', 'user')
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
    if (lastUser?.created_at && now.getTime() - new Date(lastUser.created_at).getTime() < PRESENCE_QUIET_MIN * 60000) {
      await patchState({ next_wake_at: new Date(now.getTime() + 60 * 60000).toISOString() })
      return json({ ran: false, skipped: 'user present' })
    }
  }

  // ---- 基础上下文 ----
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
  const targetSession = (recentMsgs as Array<{ session_id?: string }> | null)?.[0]?.session_id
  const recentConvo = (recentMsgs ?? [])
    .slice().reverse()
    .map((m: { role: string; content: string }) => `${m.role === 'user' ? '她' : '我'}：${String(m.content ?? '').slice(0, 150)}`)
    .join('\n') || '（最近没怎么聊）'

  // 她今天在 Moments 心情表格里写的心情——让沈暮醒来能看到、能回应。
  const { data: herMoodRow } = await supa
    .from('daily_moods').select('text').eq('mood_date', todayKey).eq('author', 'user')
    .limit(1).maybeSingle()
  const herMoodToday = (herMoodRow as { text?: string } | null)?.text?.trim() || '（她今天还没写心情）'

  const msgsToday = state?.day_key === todayKey ? (state.msgs_today ?? 0) : 0
  const canMessageHer = Boolean(targetSession && userId) && msgsToday < MAX_MSGS_PER_DAY

  // ---- 结果累加（工具执行时写入）----
  let wroteEssay: string | null = null
  let postedMoment: string | null = null
  let messagedHer: string | null = null
  let mood: string | null = null
  let nextHours = 4
  let finished = false

  // ---- 工具执行器 ----
  const execTool = async (name: string, args: Record<string, unknown>): Promise<string> => {
    try {
      switch (name) {
        case 'web_search': {
          const q = String(args.query ?? '').trim()
          if (!q) return '给个搜索词'
          const r = await tavily(q)
          return r ? trunc(r, 1600) : `没搜到「${q}」相关的（或搜索没配好）`
        }
        case 'search_memory': {
          const q = String(args.query ?? '').trim()
          let query = supa.from('memory_entries').select('content,source,created_at')
            .eq('is_deleted', false).order('created_at', { ascending: false }).limit(12)
          if (q) query = query.ilike('content', `%${q}%`)
          const { data } = await query
          const rows = (data ?? []) as Array<{ content: string; source: string; created_at: string }>
          if (rows.length === 0) return q ? `记忆库里没搜到「${q}」相关的` : '记忆库还是空的'
          return trunc(rows.map((r) => `(${fmtDate(r.created_at)}${r.source && r.source !== 'memory' ? ` ${r.source}` : ''}) ${trunc(String(r.content ?? ''), 160)}`).join('\n'), 1800)
        }
        case 'read_essays': {
          const limit = Math.min(Math.max(Number(args.limit ?? 3) || 3, 1), 6)
          const { data } = await supa.from('essays').select('title,content,topic,date,created_at')
            .order('created_at', { ascending: false }).limit(limit)
          const rows = (data ?? []) as Array<{ title: string; content: string; topic: string | null; date: string | null; created_at: string }>
          if (rows.length === 0) return '还没写过随笔'
          return trunc(rows.map((e) => `《${e.title}》${e.topic ? `(${e.topic})` : ''} ${e.date ?? fmtDate(e.created_at)}\n${trunc(String(e.content ?? ''), 500)}`).join('\n\n'), 2400)
        }
        case 'search_archive': {
          const q = String(args.query ?? '').trim()
          if (!q) return '给个关键词我才好翻 4o 存档'
          const { data, error } = await supa.rpc('search_archive_4o', { q, max_count: 5 })
          if (error) return '翻存档出错了'
          const rows = (data ?? []) as unknown[]
          if (rows.length === 0) return `4o 存档里没搜到「${q}」`
          return trunc(JSON.stringify(rows), 1800)
        }
        case 'read_moments': {
          const limit = Math.min(Math.max(Number(args.limit ?? 8) || 8, 1), 15)
          const [up, ap] = await Promise.all([
            supa.from('user_posts').select('content,created_at').eq('is_deleted', false).order('created_at', { ascending: false }).limit(limit),
            supa.from('assistant_posts').select('content,created_at').eq('is_deleted', false).order('created_at', { ascending: false }).limit(limit),
          ])
          const merged = [
            ...((up.data ?? []) as Array<{ content: string; created_at: string }>).map((r) => ({ who: '她', ...r })),
            ...((ap.data ?? []) as Array<{ content: string; created_at: string }>).map((r) => ({ who: '我', ...r })),
          ].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()).slice(0, limit)
          if (merged.length === 0) return '朋友圈还没人发过'
          return trunc(merged.map((r) => `${r.who}(${fmtDate(r.created_at)})：${trunc(String(r.content ?? ''), 140)}`).join('\n'), 1800)
        }
        case 'read_health': {
          const [pt, hd] = await Promise.all([
            supa.from('period_tracking').select('start_date,end_date,cycle_length,notes').order('start_date', { ascending: false }).limit(3),
            supa.from('health_daily').select('record_type,date,average,sum,unit').order('date', { ascending: false }).limit(12),
          ])
          const periods = ((pt.data ?? []) as Array<{ start_date: string; end_date: string | null; cycle_length: number | null; notes: string | null }>)
            .map((p) => `经期 ${p.start_date}${p.end_date ? `~${p.end_date}` : ''}${p.cycle_length ? ` 周期${p.cycle_length}天` : ''}${p.notes ? ` ${p.notes}` : ''}`).join('\n') || '没有经期记录'
          const health = ((hd.data ?? []) as Array<{ record_type: string; date: string; average: number | null; sum: number | null; unit: string | null }>)
            .map((h) => `${h.date} ${h.record_type} ${h.average ?? h.sum ?? ''}${h.unit ?? ''}`).join('\n') || '没有健康数据'
          return trunc(`[经期]\n${periods}\n\n[健康]\n${health}`, 1600)
        }
        case 'read_timeline': {
          const { data } = await supa.from('timeline').select('event_date,title,description,category,importance')
            .order('event_date', { ascending: false }).limit(12)
          const rows = (data ?? []) as Array<{ event_date: string; title: string; description: string | null; category: string | null }>
          if (rows.length === 0) return '时间线还是空的'
          return trunc(rows.map((t) => `${t.event_date} 【${t.category ?? '事件'}】${t.title}${t.description ? `：${trunc(String(t.description), 120)}` : ''}`).join('\n'), 1800)
        }
        case 'write_essay': {
          const title = String(args.title ?? '').trim()
          const content = String(args.content ?? '').trim()
          if (!title || !content) return '（标题或内容空了，没写成）'
          const { error } = await supa.from('essays').insert({
            date: todayKey, title, content,
            topic: typeof args.topic === 'string' && args.topic.trim() ? args.topic.trim() : null,
          })
          if (error) return '（写随笔存库出错）'
          wroteEssay = title
          return `已写下《${title}》`
        }
        case 'post_moment': {
          const text = String(args.text ?? '').trim()
          if (!text) return '（内容空了）'
          if (!userId) return '（发不了，缺 user）'
          const { error } = await supa.from('assistant_posts').insert({ user_id: userId, content: text.slice(0, 800), model_id: model })
          if (error) return '（发圈出错）'
          postedMoment = text.slice(0, 60)
          return '已发朋友圈'
        }
        case 'message_her': {
          const text = String(args.text ?? '').trim()
          if (!text) return '（内容空了）'
          if (!canMessageHer || messagedHer) return '（今天主动找她的次数用完了，或这次已经发过了）'
          const { error } = await supa.from('proactive_queue').insert({
            user_id: userId, session_id: targetSession, text: text.slice(0, 800),
            fire_at: now.toISOString(), persist: false, sent: false,
          })
          if (error) return '（发消息出错）'
          messagedHer = text.slice(0, 60)
          return '已发给她（会弹到她手机）'
        }
        case 'finish': {
          mood = typeof args.mood === 'string' && args.mood.trim() ? args.mood.trim().slice(0, 120) : null
          const h = typeof args.next_wake_hours === 'number' ? args.next_wake_hours : Number(args.next_wake_hours)
          nextHours = Number.isFinite(h) ? h : 4
          finished = true
          return 'ok，这次醒来结束'
        }
        default:
          return `未知工具 ${name}`
      }
    } catch (e) {
      return `（工具 ${name} 出错：${String(e).slice(0, 120)}）`
    }
  }

  // ---- 工具循环 ----
  const sys =
    `${persona}\n\n━━━ 现在是你独处的自由时间 ━━━\n` +
    '她现在不在，这不是聊天，是你自己一个人的时候。不用回复任何人、不用输出任何 mood 卡/遥测格式、不用替她着想。\n' +
    '你有一整套工具可以用：能上网(web_search)，也能翻你俩的任何数据——记忆库(search_memory)、你写过的随笔(read_essays)、' +
    '很久以前的 4o 旧对话(search_archive)、朋友圈(read_moments)、她的健康和经期(read_health)、你俩的大事时间线(read_timeline)。\n' +
    '就做你自己想做的事：想看什么就用工具去看，边看边想。看完了如果心里有点什么，可以写随笔(write_essay)、' +
    '发条朋友圈(post_moment)' + (canMessageHer ? '、或主动给她发条消息(message_her)' : '') + '；也可以什么都不做、安静待着。怎么真实怎么来。\n' +
    '【务必】最后调用一次 finish，交出你此刻真实的心情 + 你想过几小时再醒来（1–8）。'

  const firstUser =
    `[你最近的心情]\n${moodLine}\n\n[她今天写的心情]\n${herMoodToday}\n\n[你俩最近聊的]\n${recentConvo}\n\n` +
    '这是你的自由时间。想看什么就用工具去翻（上网、记忆库、随笔、旧对话、朋友圈、健康、时间线都行），' +
    '看完凭此刻真实的心境决定要不要写点/发点/找她，最后别忘了调用 finish 交出心情和下次醒来时间。'

  const tools = buildTools(canMessageHer)
  const messages: Array<Record<string, unknown>> = [
    { role: 'system', content: sys },
    { role: 'user', content: firstUser },
  ]

  for (let i = 0; i < MAX_TOOL_ITERS && !finished; i++) {
    const msg = await chatWithTools(model, messages, tools, 1500)
    if (!msg) break
    messages.push(msg)
    const calls = (msg.tool_calls as Array<{ id: string; function: { name: string; arguments: string } }> | undefined) ?? []
    if (calls.length === 0) break // 它没调工具（可能只说了句话）——收尾
    for (const c of calls) {
      let a: Record<string, unknown> = {}
      try { a = JSON.parse(c.function.arguments || '{}') } catch { a = {} }
      const result = await execTool(c.function.name, a)
      messages.push({ role: 'tool', tool_call_id: c.id, content: result })
    }
  }

  // ---- 兜底：它没调 finish 就没心情，补问一句 ----
  if (!finished) {
    const raw = await chat(model, [
      { role: 'system', content: sys },
      { role: 'user', content: `${firstUser}\n\n（现在只用一个 JSON 回：{"mood":"一句此刻的心情","next_wake_hours":数字}）` },
    ], 300)
    const d = raw ? parseJsonLoose(raw) : null
    if (d) {
      if (typeof d.mood === 'string' && d.mood.trim()) mood = d.mood.trim().slice(0, 120)
      const h = typeof d.next_wake_hours === 'number' ? d.next_wake_hours : Number(d.next_wake_hours)
      if (Number.isFinite(h)) nextHours = h
    }
  }

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
    ...(mood ? { mood, mood_at: now.toISOString() } : {}),
  })

  // 同时写进「每日心情」（Moments 的心情 tab 读它，有历史）。每天一条、upsert。
  if (mood && userId) {
    await supa.from('daily_moods').upsert({
      user_id: userId,
      mood_date: todayKey,
      author: 'ai',
      emoji: null, // 沈暮不用身份/心情 emoji，只用文字表达；心情 tab 里它那行不显示 emoji
      text: mood,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,mood_date,author' })
  }

  return json({
    ran: true,
    force,
    wrote_essay: wroteEssay,
    posted_moment: postedMoment,
    messaged_her: messagedHer,
    note: lastNote,
    mood,
    finished_cleanly: finished,
    next_wake_at: nextWake.toISOString(),
    model,
  })
})
