import { supabase } from '../supabase/client'

// 每轮自动召回：发送前拿用户这条新消息去打 search_memory Edge Function
// （和 AI 手动调的 search_memory 工具同一条混合检索管线：向量 + 关键词 RRF
// + 时间近度），把 top 命中拼成一行注入用户消息前缀。锁定记忆已常驻
// system prompt，这里补的是"AI 没想起来去搜"的未锁定长尾。
//
// 结果冻结进该消息的 meta.memoryRecall（和天气/心情旁白同款模式），重放
// 逐字节稳定，不碰缓存前缀。

const MIN_QUERY_LEN = 6
const MAX_ITEMS = 3
const SNIPPET_LEN = 80
const TIMEOUT_MS = 3500

// 本次 App 会话里已经注入过的条目 id —— 同一条记忆不要每轮重复注入
// （省 token，也避免模型被同一条记忆反复带节奏）。
const injectedKeys = new Set<string>()

type RecallRow = {
  id?: unknown
  source?: string
  title?: string | null
  content?: string | null
}

export const fetchAutoRecall = async (query: string): Promise<string | null> => {
  if (!supabase) return null
  const q = query.trim()
  // 太短的消息（"嗯"/"好"）搜出来全是噪声，直接跳过。
  if (q.length < MIN_QUERY_LEN) return null
  try {
    // lean：跳过 Edge Function 里的 period/health 附带查询（健康数据已每条
    // 消息注入）；exclude_locked：锁定记忆已常驻 system prompt，不重复召回。
    const invoke = supabase.functions.invoke('search_memory', {
      body: { query: q.slice(0, 300), count: 8, lean: true, exclude_locked: true },
    })
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('recall timeout')), TIMEOUT_MS)
    })
    const { data, error } = await Promise.race([invoke, timeout])
    if (error) return null
    const rows = ((data as { results?: RecallRow[] } | null)?.results ?? []) as RecallRow[]
    const picked: string[] = []
    for (const row of rows) {
      if (picked.length >= MAX_ITEMS) break
      const content = String(row.content ?? row.title ?? '').trim()
      if (!content) continue
      const key = `${row.source ?? ''}:${String(row.id ?? content.slice(0, 40))}`
      if (injectedKeys.has(key)) continue
      injectedKeys.add(key)
      const snippet = content.length > SNIPPET_LEN ? `${content.slice(0, SNIPPET_LEN)}…` : content
      // 非 memory 来源（diary/letter/timeline/snack_post…）标注出处。
      picked.push(row.source && row.source !== 'memory' ? `[${row.source}] ${snippet}` : snippet)
    }
    return picked.length > 0 ? picked.join('；') : null
  } catch {
    // 召回是锦上添花——超时/报错一律静默放弃，绝不挡住正常发消息。
    return null
  }
}
