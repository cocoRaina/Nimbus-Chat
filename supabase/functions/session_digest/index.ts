import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from 'jsr:@supabase/supabase-js@2'

// 会话摘要生成器（cron 每天凌晨调，也可手动 POST 触发回填）。
// 扫最近 N 天（默认 3，today 除外——当天还没聊完）：每个「当日消息 ≥ 6 条
// 且还没有摘要行」的会话，把当天对话喂给便宜 LLM 写 2-4 句摘要，
// BGE-M3 嵌入后写入 session_digests。混合检索的 session_digest 源随即可命中。
// 摘要 + 嵌入任一失败则整行不写，下一次 cron 自然重试。
//
// body 可选参数：{ days?: number }（1-30，手动回填历史用）。

const SF_EMBED_URL = 'https://api.siliconflow.cn/v1/embeddings'
const SF_CHAT_URL = 'https://api.siliconflow.cn/v1/chat/completions'
const EMBED_MODEL = 'BAAI/bge-m3'
// 14B：7B 实测摘要掉字（"对AI的的不满"）；摘要长期留存，质量优先，成本仍可忽略。
const CHAT_MODEL = 'Qwen/Qwen2.5-14B-Instruct'
const SILICONFLOW_API_KEY = Deno.env.get('SILICONFLOW_API_KEY') ?? ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const MIN_MESSAGES = 6
const MAX_SESSION_DAYS_PER_RUN = 10
const MAX_TRANSCRIPT_CHARS = 10000

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

// Beijing-date helpers: digest_date follows Asia/Shanghai days.
const beijingDateOf = (d: Date): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(d)
const dayRangeUtc = (dateStr: string): { start: string; end: string } => {
  const start = new Date(`${dateStr}T00:00:00+08:00`)
  const end = new Date(start.getTime() + 86400000)
  return { start: start.toISOString(), end: end.toISOString() }
}

const summarize = async (transcript: string, dateStr: string): Promise<string | null> => {
  const r = await fetch(SF_CHAT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SILICONFLOW_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: CHAT_MODEL,
      temperature: 0.3,
      max_tokens: 300,
      messages: [
        {
          role: 'system',
          content:
            '你是对话归档员。给你一段某一天「用户」和「AI 伙伴」的聊天记录，' +
            '用中文写 2-4 句第三人称摘要：聊了哪些话题、发生了什么重要的事/决定/情绪变化。' +
            '只输出摘要正文，不要标题、不要列表、不要评价。',
        },
        { role: 'user', content: `日期：${dateStr}\n\n${transcript}` },
      ],
    }),
  })
  if (!r.ok) return null
  const data = await r.json()
  const text = data?.choices?.[0]?.message?.content
  return typeof text === 'string' && text.trim().length > 0 ? text.trim() : null
}

const embed = async (input: string): Promise<number[] | null> => {
  const r = await fetch(SF_EMBED_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SILICONFLOW_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: EMBED_MODEL, input }),
  })
  if (!r.ok) return null
  const data = await r.json()
  const v = data?.data?.[0]?.embedding
  return Array.isArray(v) ? v : null
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method not allowed' }, 405)
  }
  if (!SILICONFLOW_API_KEY || !SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return jsonResponse({ error: 'env vars not configured' }, 500)
  }
  let days = 3
  try {
    const payload = await req.json()
    if (typeof payload?.days === 'number' && payload.days >= 1) {
      days = Math.min(30, Math.floor(payload.days))
    }
  } catch (_) { /* empty body from cron is fine */ }

  const supa = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
  const results: Array<{ date: string; session_id: string; ok: boolean; reason?: string }> = []
  let processed = 0

  try {
    for (let back = 1; back <= days && processed < MAX_SESSION_DAYS_PER_RUN; back += 1) {
      const dateStr = beijingDateOf(new Date(Date.now() - back * 86400000))
      const { start, end } = dayRangeUtc(dateStr)

      const { data: msgs, error: msgErr } = await supa
        .from('messages')
        .select('session_id,role,content,created_at')
        .gte('created_at', start)
        .lt('created_at', end)
        .order('created_at', { ascending: true })
        .limit(2000)
      if (msgErr || !msgs || msgs.length === 0) continue

      const { data: existing } = await supa
        .from('session_digests')
        .select('session_id')
        .eq('digest_date', dateStr)
      const done = new Set((existing ?? []).map((r: { session_id: string }) => r.session_id))

      const bySession = new Map<string, Array<{ role: string; content: string }>>()
      for (const m of msgs as Array<{ session_id: string; role: string; content: string }>) {
        if (!m.content || done.has(m.session_id)) continue
        const arr = bySession.get(m.session_id) ?? []
        arr.push({ role: m.role, content: m.content })
        bySession.set(m.session_id, arr)
      }

      for (const [sessionId, dayMsgs] of bySession) {
        if (processed >= MAX_SESSION_DAYS_PER_RUN) break
        if (dayMsgs.length < MIN_MESSAGES) continue
        processed += 1

        let transcript = dayMsgs
          .map((m) => `${m.role === 'user' ? '用户' : 'AI'}：${m.content.slice(0, 200)}`)
          .join('\n')
        if (transcript.length > MAX_TRANSCRIPT_CHARS) {
          // Head + tail: keep the day's opening and how it ended.
          transcript = `${transcript.slice(0, 7000)}\n……（中间省略）……\n${transcript.slice(-3000)}`
        }

        const summary = await summarize(transcript, dateStr)
        if (!summary) {
          results.push({ date: dateStr, session_id: sessionId, ok: false, reason: 'llm failed' })
          continue
        }
        const vector = await embed(summary)
        if (!vector) {
          results.push({ date: dateStr, session_id: sessionId, ok: false, reason: 'embed failed' })
          continue
        }
        const { error: insErr } = await supa.from('session_digests').insert({
          session_id: sessionId,
          digest_date: dateStr,
          content: summary,
          embedding: vector,
        })
        results.push({
          date: dateStr,
          session_id: sessionId,
          ok: !insErr,
          ...(insErr ? { reason: insErr.message } : {}),
        })
      }
    }
    return jsonResponse({ ok: true, processed, results })
  } catch (err) {
    return jsonResponse({ error: String(err), results }, 500)
  }
})
