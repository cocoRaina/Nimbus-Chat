import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from 'jsr:@supabase/supabase-js@2'

// 🌙 睡眠巩固（每周一凌晨 5:00 北京时间，cron 调；也可手动 POST 触发）。
// 人在睡眠里把情景记忆固化成语义记忆——这里做同一件事：读近 14 天的每日
// 会话摘要（session_digests，情景层），用便宜 LLM 蒸馏出 0-3 条「模式级」
// 长期记忆（她的稳定倾向/反复出现的情绪模式/习惯），写进待确认队列
// （memory_entries pending），用户点头才真正入库——和自动提取同一套确认流。
//
// 为什么不叫"周摘要"：把七天摘要再缩写一遍没有增量信息，检索时还和日摘要
// 互相抢名额。这里产出的是**另一种记忆类型**：跨天才能看出的模式，单次
// 提取（只看 12 轮对话）永远抓不到的东西。
//
// 防重复：把已有记忆 + 待确认条目全部塞进提示词里让模型排除（单租户库
// 一共几十条、几 KB，塞得起）；每周最多提 3 条，宁缺毋滥。

const SF_CHAT_URL = 'https://api.siliconflow.cn/v1/chat/completions'
const OR_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions'
const SF_FALLBACK_MODEL = 'Qwen/Qwen2.5-14B-Instruct'
const SILICONFLOW_API_KEY = Deno.env.get('SILICONFLOW_API_KEY') ?? ''
const OPENROUTER_API_KEY = Deno.env.get('OPENROUTER_API_KEY') ?? ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const LOOKBACK_DAYS = 14
const MIN_DIGESTS = 5
const MAX_PROPOSALS = 3

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

const CONSOLIDATE_PROMPT =
  '你在为一个 AI 伴侣做「记忆巩固」：下面是它和她最近两周的每日回顾，以及它已经记住的长期记忆。\n' +
  '任务：从两周的回顾里找出**跨越多天才能看出的稳定模式**，提炼成 0-3 条值得长期记住的记忆。\n' +
  '要的是：反复出现的情绪规律（如"赶 deadline 前会失眠"）、稳定的习惯/偏好变化趋势、她在意但没明说的事。\n' +
  '不要的是：一次性事件（日摘要里已有）、已有记忆里已覆盖的内容、泛泛而谈（"她爱学习"这种没用）。\n' +
  '每条 15-60 字、具体、可指导未来相处。没有达标的模式就输出空数组——宁缺毋滥。\n' +
  '只输出 JSON 字符串数组，如 ["…","…"]，不要解释。'

// 从模型输出里抠第一个 JSON 数组（模型偶尔包 markdown 代码块）。
const parseArray = (raw: string): string[] => {
  const m = /\[[\s\S]*\]/.exec(raw)
  if (!m) return []
  try {
    const arr = JSON.parse(m[0])
    return Array.isArray(arr)
      ? arr.filter((x): x is string => typeof x === 'string' && x.trim().length >= 8).map((x) => x.trim())
      : []
  } catch {
    return []
  }
}

const callModel = async (
  url: string,
  apiKey: string,
  model: string,
  userPrompt: string,
): Promise<string[] | null> => {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        max_tokens: 400,
        messages: [
          { role: 'system', content: CONSOLIDATE_PROMPT },
          { role: 'user', content: userPrompt },
        ],
      }),
    })
    if (!r.ok) return null
    const data = await r.json()
    const text = data?.choices?.[0]?.message?.content
    return typeof text === 'string' ? parseArray(text) : null
  } catch {
    return null
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method not allowed' }, 405)
  }
  if (!SILICONFLOW_API_KEY || !SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return jsonResponse({ error: 'env vars not configured' }, 500)
  }
  const supa = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  // 单租户库：模型配置和 user_id 都取第一行。
  const { data: settingsRow } = await supa
    .from('user_settings')
    .select('user_id, memory_extract_model')
    .limit(1)
    .maybeSingle()
  const userId = settingsRow?.user_id as string | undefined
  if (!userId) {
    return jsonResponse({ error: 'no user_settings row (cannot determine user_id)' }, 500)
  }
  const extractModel =
    typeof settingsRow?.memory_extract_model === 'string' && settingsRow.memory_extract_model.trim()
      ? settingsRow.memory_extract_model.trim()
      : null

  const since = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10)
  const [digestsResult, memoriesResult, pendingResult] = await Promise.all([
    supa
      .from('session_digests')
      .select('digest_date, content')
      .gte('digest_date', since)
      .order('digest_date', { ascending: true }),
    supa.from('memories').select('content').order('created_at', { ascending: false }).limit(150),
    supa
      .from('memory_entries')
      .select('content')
      .eq('status', 'pending')
      .eq('is_deleted', false)
      .limit(50),
  ])

  const digests = digestsResult.data ?? []
  if (digests.length < MIN_DIGESTS) {
    return jsonResponse({ ok: true, skipped: `only ${digests.length} digests in last ${LOOKBACK_DAYS}d (<${MIN_DIGESTS})` })
  }

  const known = [
    ...(memoriesResult.data ?? []).map((r: { content: string }) => r.content),
    ...(pendingResult.data ?? []).map((r: { content: string }) => r.content),
  ]

  const userPrompt =
    `【近两周每日回顾】\n${digests.map((d: { digest_date: string; content: string }) => `${d.digest_date}：${d.content}`).join('\n')}\n\n` +
    `【已记住的长期记忆（不要重复提炼这些）】\n${known.map((c) => `- ${c}`).join('\n') || '（无）'}`

  let proposals: string[] | null = null
  let usedModel = ''
  if (extractModel && OPENROUTER_API_KEY) {
    proposals = await callModel(OR_CHAT_URL, OPENROUTER_API_KEY, extractModel, userPrompt)
    if (proposals) usedModel = extractModel
  }
  if (!proposals) {
    proposals = await callModel(SF_CHAT_URL, SILICONFLOW_API_KEY, SF_FALLBACK_MODEL, userPrompt)
    if (proposals) usedModel = SF_FALLBACK_MODEL
  }
  if (!proposals) {
    return jsonResponse({ error: 'llm failed' }, 502)
  }

  const picked = proposals.slice(0, MAX_PROPOSALS)
  if (picked.length === 0) {
    console.info('[巩固] 本周无达标模式，跳过')
    return jsonResponse({ ok: true, proposed: 0, model: usedModel })
  }

  const { error: insertError } = await supa.from('memory_entries').insert(
    picked.map((content) => ({
      user_id: userId,
      content,
      source: 'consolidation',
      status: 'pending',
    })),
  )
  if (insertError) {
    return jsonResponse({ error: insertError.message }, 500)
  }
  console.info(`[巩固] 提炼 ${picked.length} 条模式记忆进待确认`, picked.map((p) => p.slice(0, 30)))
  return jsonResponse({ ok: true, proposed: picked.length, items: picked, model: usedModel })
})
