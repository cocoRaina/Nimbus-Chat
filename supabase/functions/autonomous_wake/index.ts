import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from 'jsr:@supabase/supabase-js@2'

// 沈暮的「自主唤醒」（Agent 版）：独立于聊天的后台自由时间。
// cron 每 ~10min POST 一次，先过四道闸——① 总开关 enabled；② 今天醒够 N 次没；
// ③ 0–8 点安静时段；④ 她在场吗（45min 内有她的消息 = 在，跳过并改约）——过了才跑。
//
// 跑一轮 = 一个【真正的工具循环 Agent】：能上网、翻记忆/随笔/存档/朋友圈/健康/时间线，
// 自决 写随笔 / 发朋友圈 / 主动给她发消息 / 什么都不做，最后调 finish 交出「此刻心情」+
// 「下次几小时后醒」。产出写 essays/assistant_posts/daily_moods，主动消息进 proactive_queue。
//
// ⚠️ 走 A 社原生 /v1/messages（跟聊天同一条路，用 Anthropic 工具 tool_use），不再走
// OpenAI /chat/completions——treegpt 这类中转的便宜档（Claude-hyper）在 OpenAI 那扇门里
// 翻译工具调用会翻车（只吐短文本、不吐 tool_calls），但 Anthropic 原生门是好的（聊天就靠它
// 调 search_memory 等工具）。选站看 autonomous_state.wake_provider：
//   relay → {RELAY_BASE_URL}/messages + x-api-key（聊天用的 treegpt）
//   openrouter → openrouter.ai/api/v1/messages + Bearer
// 【无跨站兜底】：选谁就打谁，打不通这轮就空过（下一 tick 再来）。
//
// 手动测试：POST {"force": true} 跳过全部闸、立即跑一轮。

const TAVILY_URL = 'https://api.tavily.com/search'
const OPENROUTER_API_KEY = Deno.env.get('OPENROUTER_API_KEY') ?? ''
const TAVILY_API_KEY = Deno.env.get('TAVILY_API_KEY') ?? ''
// 中转（treegpt 等）凭证——cron 没有客户端在场、读不到手机 localStorage，故单独存密钥。
// RELAY_BASE_URL 例：https://api.treegpt.cc/v1（会自动补 /messages）。
const RELAY_BASE_URL = Deno.env.get('RELAY_BASE_URL') ?? ''
const RELAY_API_KEY = Deno.env.get('RELAY_API_KEY') ?? ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const MAX_WAKES_PER_DAY = 6            // 缺省每天最多醒几次（autonomous_state.max_wakes_per_day 可覆盖）
const MAX_MSGS_PER_DAY = 5             // 一天最多主动给她发几条
const PRESENCE_QUIET_MIN = 45          // 她 45min 内说过话 = 在场
const QUIET_START_H = 0, QUIET_END_H = 8 // 北京 0–8 点安静时段不醒
const MAX_TOOL_ITERS = 6              // 工具循环最多几轮
// 单次上游请求超时：上游吊住若没超时会把整个 Edge 运行时拖到墙钟上限被杀，patchState 都跑不到。
const REQUEST_TIMEOUT_MS = 40_000

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const beijingHour = (d = new Date()): number =>
  Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false }).format(d)) % 24
const beijingDate = (d = new Date()): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(d)

const next9am = (from = new Date()): Date => {
  let t = new Date(`${beijingDate(from)}T09:00:00+08:00`)
  if (t.getTime() <= from.getTime()) t = new Date(t.getTime() + 86400000)
  return t
}
const scheduleFrom = (hours: number): Date => {
  const h = Math.max(1, Math.min(8, Math.round(hours || 4)))
  const t = new Date(Date.now() + h * 3600000)
  return beijingHour(t) < QUIET_END_H ? next9am(t) : t
}

const trimSlash = (s: string) => s.replace(/\/+$/, '')

// OpenRouter 原生 /messages 认 anthropic/<model> 这种 slug；裸 slug 归一：claude-opus-4-6 → anthropic/claude-opus-4.6
const orModel = (m: string | null): string => {
  const s = (m ?? '').trim()
  if (!s) return 'anthropic/claude-opus-4.6'
  if (s.includes('/')) return s
  const dotted = s.replace(/^(claude-(?:opus|sonnet|haiku)-\d+)-(\d+)$/i, '$1.$2')
  return `anthropic/${dotted}`
}
// 中转 /v1/messages 走它模型广场里的裸 id，跟聊天发的一模一样。
const relayModel = (m: string | null): string => {
  const s = (m ?? '').trim()
  return s || 'claude-opus-4-6'
}

// 一条上游路由：打哪个 /messages、用哪个 key、发哪个模型名、什么认证头。
type Route = {
  url: string
  key: string
  model: string
  authStyle: 'bearer' | 'x-api-key'
  label: 'relay' | 'openrouter'
}

type AnthropicBlock = { type: string; text?: string; id?: string; name?: string; input?: unknown }

const trunc = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s)
const fmtDate = (iso?: string | null): string => {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// A 社原生 /v1/messages 单发。tools 传 null = 不带工具（收尾问心情）。
// 返回助手回复的 content 块数组（含 text / tool_use），失败返回 null。
const callAnthropic = async (
  route: Route,
  system: string,
  messages: Array<Record<string, unknown>>,
  tools: unknown[] | null,
  maxTokens: number,
  // 可选：强制它调某个工具（收尾时逼它调 finish 交心情，比"求它自觉调"稳）。
  toolChoice?: Record<string, unknown>,
): Promise<AnthropicBlock[] | null> => {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS)
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    }
    if (route.authStyle === 'bearer') headers['Authorization'] = `Bearer ${route.key}`
    else headers['x-api-key'] = route.key

    const body: Record<string, unknown> = {
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

    const r = await fetch(route.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ac.signal,
    })
    if (!r.ok) {
      console.warn(`[wake] ${route.label} 失败 ${r.status} ${(await r.text().catch(() => '')).slice(0, 300)}`)
      return null
    }
    const data = await r.json()
    const content = data?.content
    return Array.isArray(content) ? (content as AnthropicBlock[]) : null
  } catch (e) {
    console.warn(`[wake] ${route.label} 异常 ${String(e).slice(0, 200)}`)
    return null
  } finally {
    clearTimeout(timer)
  }
}

const textOf = (blocks: AnthropicBlock[] | null): string =>
  (blocks ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')

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

const parseJsonLoose = (text: string): Record<string, unknown> | null => {
  const t = text.replace(/```json/gi, '').replace(/```/g, '')
  const a = t.indexOf('{'), b = t.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try { return JSON.parse(t.slice(a, b + 1)) as Record<string, unknown> } catch { return null }
}

// 工具清单（Anthropic 原生格式：name/description/input_schema）。查看类只读；动作类有副作用。
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
    name: t.name,
    description: t.desc,
    input_schema: { type: 'object', properties: t.params, required: t.req },
  }))
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return json({ error: 'env not configured' }, 500)

  let force = false
  try { const b = await req.json(); force = b?.force === true } catch { /* cron 空 body */ }

  const supa = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
  const now = new Date()
  const todayKey = beijingDate(now)

  const { data: state } = await supa.from('autonomous_state').select('*').eq('id', 1).maybeSingle()
  const patchState = async (patch: Record<string, unknown>) =>
    supa.from('autonomous_state').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', 1)

  const maxWakesPerDay =
    typeof state?.max_wakes_per_day === 'number' && state.max_wakes_per_day >= 1
      ? state.max_wakes_per_day
      : MAX_WAKES_PER_DAY

  // ---- 四道闸（force 时全跳过）----
  if (!force) {
    if (!state?.enabled) return json({ ran: false, skipped: 'disabled' })
    const wakesToday = state.day_key === todayKey ? (state.wakes_today ?? 0) : 0
    if (wakesToday >= maxWakesPerDay) {
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
  const persona = typeof settings?.system_prompt === 'string' ? settings.system_prompt : ''

  // ---- 选站（无跨站兜底）：relay 且密钥齐 → 走中转 /messages；否则 OpenRouter /messages ----
  const relayConfigured = Boolean(RELAY_BASE_URL && RELAY_API_KEY)
  const wantRelay = state?.wake_provider === 'relay'
  let route: Route
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
  if (route.authStyle === 'bearer' && !OPENROUTER_API_KEY) return json({ error: 'openrouter key missing' }, 500)
  const model = route.model

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

  const { data: herMoodRow } = await supa
    .from('daily_moods').select('text').eq('mood_date', todayKey).eq('author', 'user')
    .limit(1).maybeSingle()
  const herMoodToday = (herMoodRow as { text?: string } | null)?.text?.trim() || '（她今天还没写心情）'

  const msgsToday = state?.day_key === todayKey ? (state.msgs_today ?? 0) : 0
  const canMessageHer = Boolean(targetSession && userId) && msgsToday < MAX_MSGS_PER_DAY

  // ---- 结果累加 ----
  let wroteEssay: string | null = null
  let postedMoment: string | null = null
  let messagedHer: string | null = null
  let mood: string | null = null
  let nextHours = 4
  let finished = false

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
    { role: 'user', content: firstUser },
  ]

  for (let i = 0; i < MAX_TOOL_ITERS && !finished; i++) {
    const content = await callAnthropic(route, sys, messages, tools, 1500)
    if (!content) break
    // 把助手这轮的完整 content（text + tool_use）原样回填历史
    messages.push({ role: 'assistant', content })
    const toolUses = content.filter((b) => b.type === 'tool_use')
    if (toolUses.length === 0) break // 它没调工具（只说了句话）——收尾
    const toolResults = [] as Array<Record<string, unknown>>
    for (const tu of toolUses) {
      const args = (tu.input && typeof tu.input === 'object') ? tu.input as Record<string, unknown> : {}
      const result = await execTool(String(tu.name ?? ''), args)
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: result })
    }
    messages.push({ role: 'user', content: toolResults })
  }

  // ---- 兜底：它没主动调 finish 就没心情。别求它自觉——带着完整历史再发一次，
  // 用 tool_choice 【强制】它调 finish，心情/下次时间从结构化工具参数直接读
  // （不再 parse JSON，彻底避开"心情文字带引号顶破 JSON"的坑，实测就是它害 08-18
  // 写了随笔却没心情）。强制调用几乎必中；execTool('finish') 会置 mood/nextHours。----
  if (!finished) {
    messages.push({
      role: 'user',
      content: '好了，现在必须调用 finish：交出你此刻真实的心情（短一点、像随口说的）+ 你想过几小时再醒来（1–8）。',
    })
    const content = await callAnthropic(route, sys, messages, tools, 400, { type: 'tool', name: 'finish' })
    const tu = (content ?? []).find((b) => b.type === 'tool_use' && b.name === 'finish')
    if (tu) {
      const input = (tu.input && typeof tu.input === 'object') ? tu.input as Record<string, unknown> : {}
      await execTool('finish', input)
    } else {
      // 极少数强制也没吐 tool_use：退回从文本里捞个 JSON，能捞到算赚。
      const d = content ? parseJsonLoose(textOf(content)) : null
      if (d && typeof d.mood === 'string' && d.mood.trim()) {
        mood = d.mood.trim().slice(0, 120)
        const h = typeof d.next_wake_hours === 'number' ? d.next_wake_hours : Number(d.next_wake_hours)
        if (Number.isFinite(h)) nextHours = h
      }
    }
  }

  // 抽风判定：只有【啥都没干成 + 也没交出心情】才算真·中转没接住 → 1h 重试、不占名额。
  // 只要写了随笔/发了圈/发了消息（write_essay 等当场就写库了），就算这轮**干活了**，
  // 哪怕心情没交出来也不能当失败（否则会像 08-18 那样：写了《后颈》却被记成"中转没接住"、
  // 名额还不算）——那种情况按正常轮处理，last_note 照实显示干了啥。
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
    await supa.from('daily_moods').upsert({
      user_id: userId,
      mood_date: todayKey,
      author: 'ai',
      emoji: null,
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
    provider: route.label,
  })
})
