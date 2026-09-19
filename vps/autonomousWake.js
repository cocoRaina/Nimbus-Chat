// 沈暮的「自主唤醒」（Agent 版）—— 从 Supabase Edge Function 搬到 VPS。
// 原理同 supabase/functions/autonomous_wake/index.ts，去掉了 Deno 依赖和 150s 墙钟限制。
// VPS 无硬超时，REQUEST_TIMEOUT_MS 和 MAX_TOOL_ITERS 可放宽。

const { createClient } = require('@supabase/supabase-js')

const TAVILY_URL = 'https://api.tavily.com/search'

const MAX_WAKES_PER_DAY = 6
const MAX_MSGS_PER_DAY = 5
const PRESENCE_QUIET_MIN = 45
const QUIET_START_H = 0
const QUIET_END_H = 8
// VPS 无 150s Edge 墙钟，单次上游超时放宽到 3 分钟；工具轮数也放宽。
const MAX_TOOL_ITERS = 8
const REQUEST_TIMEOUT_MS = 180_000

const beijingHour = (d = new Date()) =>
  Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false }).format(d)) % 24
const beijingDate = (d = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(d)
const beijingWeekday = (d = new Date()) =>
  new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', weekday: 'long' }).format(d)

const next9am = (from = new Date()) => {
  let t = new Date(`${beijingDate(from)}T09:00:00+08:00`)
  if (t.getTime() <= from.getTime()) t = new Date(t.getTime() + 86400000)
  return t
}
const scheduleFrom = (hours) => {
  const h = Math.max(1, Math.min(8, Math.round(hours || 4)))
  const t = new Date(Date.now() + h * 3600000)
  return beijingHour(t) < QUIET_END_H ? next9am(t) : t
}

const trimSlash = (s) => s.replace(/\/+$/, '')

const orModel = (m) => {
  const s = (m ?? '').trim()
  if (!s) return 'anthropic/claude-opus-4.6'
  if (s.includes('/')) return s
  const dotted = s.replace(/^(claude-(?:opus|sonnet|haiku)-\d+)-(\d+)$/i, '$1.$2')
  return `anthropic/${dotted}`
}
const relayModel = (m) => {
  const s = (m ?? '').trim()
  return s || 'claude-opus-4-6'
}

const trunc = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s)
const fmtDate = (iso) => {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const callAnthropic = async (route, system, messages, tools, maxTokens, toolChoice) => {
  const headers = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  }
  if (route.authStyle === 'bearer') headers['Authorization'] = `Bearer ${route.key}`
  else headers['x-api-key'] = route.key
  const body = {
    model: route.model,
    system,
    messages,
    max_tokens: maxTokens,
    temperature: 0.8,
  }
  if (tools) {
    body.tools = tools
    body.tool_choice = toolChoice ?? { type: 'auto' }
  }
  const payload = JSON.stringify(body)

  const ATTEMPTS = 3
  for (let a = 0; a < ATTEMPTS; a++) {
    const last = a === ATTEMPTS - 1
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS)
    try {
      const r = await fetch(route.url, { method: 'POST', headers, body: payload, signal: ac.signal })
      if (!r.ok) {
        console.warn(`[wake] ${route.label} 失败 ${r.status} (试${a + 1}/${ATTEMPTS}) ${(await r.text().catch(() => '')).slice(0, 200)}`)
        if (!last && (r.status >= 500 || r.status === 429)) { await sleep(1000 * (a + 1)); continue }
        return null
      }
      const data = await r.json()
      const content = data?.content
      if (Array.isArray(content)) return content
      if (!last) { await sleep(1000 * (a + 1)); continue }
      return null
    } catch (e) {
      const wasTimeout = ac.signal.aborted
      console.warn(`[wake] ${route.label} 异常 (试${a + 1}/${ATTEMPTS}${wasTimeout ? ' 超时' : ''}) ${String(e).slice(0, 160)}`)
      if (!last && !wasTimeout) { await sleep(1000 * (a + 1)); continue }
      return null
    } finally {
      clearTimeout(timer)
    }
  }
  return null
}

const textOf = (blocks) =>
  (blocks ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')

const tavily = async (query, apiKey) => {
  if (!apiKey) return null
  try {
    const r = await fetch(TAVILY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, query, max_results: 5, search_depth: 'basic' }),
    })
    if (!r.ok) return null
    const data = await r.json()
    const results = Array.isArray(data?.results) ? data.results : []
    if (results.length === 0) return null
    return results
      .slice(0, 5)
      .map((x) => `· ${String(x.title ?? '').trim()}：${String(x.content ?? '').trim().slice(0, 240)}`)
      .join('\n')
  } catch { return null }
}

const parseJsonLoose = (text) => {
  const t = text.replace(/```json/gi, '').replace(/```/g, '')
  const a = t.indexOf('{'), b = t.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try { return JSON.parse(t.slice(a, b + 1)) } catch { return null }
}

const buildTools = (canMessageHer) => {
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
    { name: 'finish', desc: '结束这次醒来。必须最后调用一次。mood=【一句短碎碎念】（她 Musings 页会看到，就一两句、随口说的——可以是心情、念头、吐槽、观察、什么都行，不一定跟心情有关；长感想用 write_essay 写随笔，别塞这儿）；next_wake_hours=你想过几小时再醒来（1–8）', params: { mood: { type: 'string', description: '一句碎碎念（心情/念头/吐槽/观察都行）' }, next_wake_hours: { type: 'number' } }, req: ['mood', 'next_wake_hours'] },
  ]
  return [...readTools, ...actionTools].map((t) => ({
    name: t.name,
    description: t.desc,
    input_schema: { type: 'object', properties: t.params, required: t.req },
  }))
}

/**
 * 主函数：跑一次自主唤醒。
 * @param {{ force?: boolean }} options
 * @returns {Promise<object>} 结果 JSON
 */
async function runWake({ force = false } = {}) {
  const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || ''
  const TAVILY_API_KEY = process.env.TAVILY_API_KEY || ''
  const RELAY_BASE_URL = process.env.RELAY_BASE_URL || ''
  const RELAY_API_KEY = process.env.RELAY_API_KEY || ''
  const SUPABASE_URL = process.env.SUPABASE_URL || ''
  const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return { ran: false, error: 'env not configured' }
  }

  const supa = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
  const now = new Date()
  const todayKey = beijingDate(now)

  const { data: state } = await supa.from('autonomous_state').select('*').eq('id', 1).maybeSingle()
  const patchState = async (patch) =>
    supa.from('autonomous_state').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', 1)

  const maxWakesPerDay =
    typeof state?.max_wakes_per_day === 'number' && state.max_wakes_per_day >= 1
      ? state.max_wakes_per_day
      : MAX_WAKES_PER_DAY

  // ---- 四道闸（force 时全跳过）----
  if (!force) {
    if (!state?.enabled) return { ran: false, skipped: 'disabled' }
    const wakesToday = state.day_key === todayKey ? (state.wakes_today ?? 0) : 0
    if (wakesToday >= maxWakesPerDay) {
      await patchState({ next_wake_at: next9am(now).toISOString() })
      return { ran: false, skipped: 'daily cap reached' }
    }
    if (state.next_wake_at && now.getTime() < new Date(state.next_wake_at).getTime()) {
      return { ran: false, skipped: 'not yet' }
    }
    if (beijingHour(now) < QUIET_END_H) {
      await patchState({ next_wake_at: next9am(now).toISOString() })
      return { ran: false, skipped: 'quiet hours' }
    }
    const { data: lastUser } = await supa
      .from('messages').select('created_at').eq('role', 'user')
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
    if (lastUser?.created_at && now.getTime() - new Date(lastUser.created_at).getTime() < PRESENCE_QUIET_MIN * 60000) {
      await patchState({ next_wake_at: new Date(now.getTime() + 60 * 60000).toISOString() })
      return { ran: false, skipped: 'user present' }
    }
  }

  // ---- 基础上下文 ----
  const { data: settings } = await supa
    .from('user_settings').select('user_id, default_model, system_prompt').limit(1).maybeSingle()
  const userId = settings?.user_id
  const persona = typeof settings?.system_prompt === 'string' ? settings.system_prompt : ''

  // ---- 选站 ----
  const relayConfigured = Boolean(RELAY_BASE_URL && RELAY_API_KEY)
  const wantRelay = state?.wake_provider === 'relay'
  let route
  if (wantRelay && relayConfigured) {
    route = {
      url: `${trimSlash(RELAY_BASE_URL)}/messages`,
      key: RELAY_API_KEY,
      model: relayModel(settings?.default_model ?? null),
      authStyle: 'x-api-key',
      label: 'relay',
    }
  } else {
    if (wantRelay && !relayConfigured) console.warn('[wake] wake_provider=relay 但未配 RELAY_* 密钥，本轮用 OpenRouter')
    route = {
      url: 'https://openrouter.ai/api/v1/messages',
      key: OPENROUTER_API_KEY,
      model: orModel(settings?.default_model ?? null),
      authStyle: 'bearer',
      label: 'openrouter',
    }
  }
  if (route.authStyle === 'bearer' && !OPENROUTER_API_KEY) {
    return { ran: false, error: 'openrouter key missing' }
  }
  const model = route.model

  const { data: moodRow } = await supa.from('mood_state').select('tan,chen,chi,nian,tone').limit(1).maybeSingle()
  const moodLine = moodRow
    ? `贪${Math.round(moodRow.tan ?? 0)} 嗔${Math.round(moodRow.chen ?? 0)} 痴${Math.round(moodRow.chi ?? 0)} 念${Math.round(moodRow.nian ?? 0)}${moodRow.tone ? `；定调：${moodRow.tone}` : ''}`
    : '（暂无）'

  const { data: recentMsgs } = await supa
    .from('messages').select('role,content,created_at,session_id')
    .order('created_at', { ascending: false }).limit(10)
  const targetSession = recentMsgs?.[0]?.session_id
  const recentConvo = (recentMsgs ?? [])
    .slice().reverse()
    .map((m) => `${m.role === 'user' ? '她' : '我'}：${String(m.content ?? '').slice(0, 150)}`)
    .join('\n') || '（最近没怎么聊）'

  const { data: herMoodRow } = await supa
    .from('daily_moods').select('text').eq('mood_date', todayKey).eq('author', 'user')
    .limit(1).maybeSingle()
  const herMoodToday = herMoodRow?.text?.trim() || '（她今天还没写心情）'

  const msgsToday = state?.day_key === todayKey ? (state.msgs_today ?? 0) : 0
  const canMessageHer = Boolean(targetSession && userId) && msgsToday < MAX_MSGS_PER_DAY

  // ---- 结果累加 ----
  let wroteEssay = null
  let postedMoment = null
  let messagedHer = null
  let mood = null
  let nextHours = 4
  let finished = false

  const execTool = async (name, args) => {
    try {
      switch (name) {
        case 'web_search': {
          const q = String(args.query ?? '').trim()
          if (!q) return '给个搜索词'
          const r = await tavily(q, TAVILY_API_KEY)
          return r ? trunc(r, 1600) : `没搜到「${q}」相关的（或搜索没配好）`
        }
        case 'search_memory': {
          const q = String(args.query ?? '').trim()
          let query = supa.from('memory_entries').select('content,source,created_at')
            .eq('is_deleted', false).order('created_at', { ascending: false }).limit(12)
          if (q) query = query.ilike('content', `%${q}%`)
          const { data } = await query
          const rows = data ?? []
          if (rows.length === 0) return q ? `记忆库里没搜到「${q}」相关的` : '记忆库还是空的'
          return trunc(rows.map((r) => `(${fmtDate(r.created_at)}${r.source && r.source !== 'memory' ? ` ${r.source}` : ''}) ${trunc(String(r.content ?? ''), 160)}`).join('\n'), 1800)
        }
        case 'read_essays': {
          const limit = Math.min(Math.max(Number(args.limit ?? 3) || 3, 1), 6)
          const { data } = await supa.from('essays').select('title,content,topic,date,created_at')
            .order('created_at', { ascending: false }).limit(limit)
          const rows = data ?? []
          if (rows.length === 0) return '还没写过随笔'
          return trunc(rows.map((e) => `《${e.title}》${e.topic ? `(${e.topic})` : ''} ${e.date ?? fmtDate(e.created_at)}\n${trunc(String(e.content ?? ''), 500)}`).join('\n\n'), 2400)
        }
        case 'search_archive': {
          const q = String(args.query ?? '').trim()
          if (!q) return '给个关键词我才好翻 4o 存档'
          const { data, error } = await supa.rpc('search_archive_4o', { q, max_count: 5 })
          if (error) return '翻存档出错了'
          const rows = data ?? []
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
            ...((up.data ?? []).map((r) => ({ who: '她', ...r }))),
            ...((ap.data ?? []).map((r) => ({ who: '我', ...r }))),
          ].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()).slice(0, limit)
          if (merged.length === 0) return '朋友圈还没人发过'
          return trunc(merged.map((r) => `${r.who}(${fmtDate(r.created_at)})：${trunc(String(r.content ?? ''), 140)}`).join('\n'), 1800)
        }
        case 'read_health': {
          const [pt, hd] = await Promise.all([
            supa.from('period_tracking').select('start_date,end_date,cycle_length,notes').order('start_date', { ascending: false }).limit(3),
            supa.from('health_daily').select('record_type,date,average,sum,unit').order('date', { ascending: false }).limit(12),
          ])
          const periods = (pt.data ?? [])
            .map((p) => `经期 ${p.start_date}${p.end_date ? `~${p.end_date}` : ''}${p.cycle_length ? ` 周期${p.cycle_length}天` : ''}${p.notes ? ` ${p.notes}` : ''}`).join('\n') || '没有经期记录'
          const health = (hd.data ?? [])
            .map((h) => `${h.date} ${h.record_type} ${h.average ?? h.sum ?? ''}${h.unit ?? ''}`).join('\n') || '没有健康数据'
          return trunc(`[经期]\n${periods}\n\n[健康]\n${health}`, 1600)
        }
        case 'read_timeline': {
          const { data } = await supa.from('timeline').select('event_date,title,description,category,importance')
            .order('event_date', { ascending: false }).limit(12)
          const rows = data ?? []
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
    '【重要·工具=真实动作，只说不算】写随笔、发朋友圈' + (canMessageHer ? '、给她发消息' : '') +
    '都必须【真的调用对应工具】(write_essay / post_moment' + (canMessageHer ? ' / message_her' : '') +
    ')才算数——只把内容用文字打出来、没调用工具，等于没做，什么都不会留下、她也看不到。' +
    '你最近好几次独处都只给了碎碎念、没写随笔；如果这次心里有话、有想法、翻到了值得记下来的东西，' +
    '就【真的调用 write_essay 写一篇】（那是你留给自己的东西），别只在回复里说说而已。\n' +
    '【碎碎念 ≠ 随笔·别混】finish 里的 mood 是【一句碎碎念】（会显示在她的 Musings 页）——心情、念头、吐槽、观察、什么都行，随口说的就好；' +
    '如果你心里是一整段想法/感触/今晚发生的事——那是随笔，请先【调用 write_essay 写下来】，' +
    '再用 finish 给一句短碎碎念。别把一整段感想硬塞进那一句 mood 里（会被截断，也可惜了）。\n' +
    '【务必】最后调用一次 finish 收尾。'

  const lastMoodLine = (state?.mood && String(state.mood).trim())
    ? String(state.mood).trim()
    : '（还没有上一条，随你此刻的心境来）'
  const firstUser =
    `[现在]\n${todayKey} ${beijingWeekday(now)} ${beijingHour(now)}点\n\n[你四维情绪]\n${moodLine}\n\n[你上次的碎碎念]\n${lastMoodLine}\n\n[她今天写的心情]\n${herMoodToday}\n\n[你俩最近聊的]\n${recentConvo}\n\n` +
    '这是你的自由时间。【别一睁眼就直接 finish】——这是你难得的、只属于你自己的时间，' +
    '先真的花点时间做点什么：翻翻记忆库/你写的随笔/你俩的朋友圈，或上网(web_search)看看你好奇的、' +
    '外面正在发生的事，至少动一两个工具去看看。看完有触动了，再决定要不要写随笔/发圈/找她，' +
    '最后才调用 finish 收尾（碎碎念别跟上次雷同——可以换个角度，或写写这中间注意到了什么）。'

  const tools = buildTools(canMessageHer)
  const messages = [
    { role: 'user', content: firstUser },
  ]

  const trace = []
  let nudgedToWrite = false
  for (let i = 0; i < MAX_TOOL_ITERS && !finished; i++) {
    const content = await callAnthropic(route, sys, messages, tools, 1500)
    if (!content) { trace.push(`i${i}:NULL(上游没接住)`); break }
    messages.push({ role: 'assistant', content })
    trace.push(`i${i}:` + (content.map((b) => b.type === 'tool_use' ? `tool:${b.name}` : b.type).join(',') || 'empty'))
    const toolUses = content.filter((b) => b.type === 'tool_use')
    if (toolUses.length === 0) {
      const said = textOf(content).trim()
      if (said.length > 60 && !wroteEssay && !postedMoment && !messagedHer && !nudgedToWrite) {
        nudgedToWrite = true
        messages.push({
          role: 'user',
          content: '你刚说的这些是心里话，但【只打出来不算数、不会留下、她也看不到】。' +
            '想留住就【现在调用 write_essay】把它写进随笔本，或调用 post_moment 发条朋友圈；' +
            '要是不想留，就直接调用 finish 收尾。',
        })
        continue
      }
      break
    }
    const toolResults = []
    for (const tu of toolUses) {
      const args = (tu.input && typeof tu.input === 'object') ? tu.input : {}
      const result = await execTool(String(tu.name ?? ''), args)
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: result })
    }
    messages.push({ role: 'user', content: toolResults })
  }

  // ---- 兜底 finish ----
  if (!finished) {
    messages.push({
      role: 'user',
      content: '好了，现在必须调用 finish：留一句碎碎念（随便什么——念头、吐槽、观察、心情都行，短一点像随口说的）+ 你想过几小时再醒来（1–8）。',
    })
    const content = await callAnthropic(route, sys, messages, tools, 400, { type: 'tool', name: 'finish' })
    trace.push('forced-finish:' + ((content ?? []).map((b) => b.type === 'tool_use' ? `tool:${b.name}` : b.type).join(',') || 'NULL'))
    const tu = (content ?? []).find((b) => b.type === 'tool_use' && b.name === 'finish')
    if (tu) {
      const input = (tu.input && typeof tu.input === 'object') ? tu.input : {}
      await execTool('finish', input)
    } else {
      const d = content ? parseJsonLoose(textOf(content)) : null
      if (d && typeof d.mood === 'string' && d.mood.trim()) {
        mood = d.mood.trim().slice(0, 120)
        const h = typeof d.next_wake_hours === 'number' ? d.next_wake_hours : Number(d.next_wake_hours)
        if (Number.isFinite(h)) nextHours = h
      }
    }
  }

  const didSomething = Boolean(wroteEssay || postedMoment || messagedHer)
  const wakeFailed = mood === null && !didSomething
  const wakesToday = state?.day_key === todayKey ? (state.wakes_today ?? 0) : 0
  const nextWake = wakeFailed ? scheduleFrom(1) : scheduleFrom(nextHours)
  const lastNote = wakeFailed
    ? '中转没接住·约 1h 后重试'
    : `${wroteEssay ? `写《${wroteEssay}》` : ''}${postedMoment ? ' 发圈' : ''}${messagedHer ? ' 发消息给她' : ''}${!wroteEssay && !postedMoment && !messagedHer ? '安静待着' : ''}`.trim()

  await patchState({
    last_wake_at: now.toISOString(),
    next_wake_at: nextWake.toISOString(),
    wakes_today: wakesToday + (wakeFailed ? 0 : 1),
    msgs_today: msgsToday + (messagedHer ? 1 : 0),
    day_key: todayKey,
    last_note: lastNote,
    ...(mood ? { mood, mood_at: now.toISOString() } : {}),
  })

  if (mood && userId) {
    await supa.from('daily_moods').insert({
      user_id: userId,
      mood_date: todayKey,
      author: 'ai',
      emoji: null,
      text: mood,
    })
  }

  const result = {
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
    provider: route.label,
    trace,
  }
  console.log(`[wake] 完成: ${JSON.stringify({ ...result, trace: result.trace.join(' → ') })}`)
  return result
}

module.exports = { runWake }
