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

// 环形日志（仅本次启动，内存态）：Diagnostics「记忆状态」tab 读它来判断
// 每轮召回是否健康运行。hits=-1 表示该轮召回超时/失败（消息照常发出）。
export type RecallLogEntry = { at: number; query: string; hits: number; preview: string }
const recallLog: RecallLogEntry[] = []
const MAX_LOG = 20
const logRecall = (entry: RecallLogEntry) => {
  recallLog.push(entry)
  if (recallLog.length > MAX_LOG) recallLog.shift()
}
export const getRecallLog = (): RecallLogEntry[] => [...recallLog].reverse()

type RecallRow = {
  id?: unknown
  source?: string
  title?: string | null
  content?: string | null
  created_at?: string | null
}

// 每条召回带上日期——不带的话小机的时间线是糊的:「她提过想去海边」分不清
// 是上周还是三个月前。diary/letter 的 created_at 已是真实日期(2026-06-12
// 迁移),memory 条目的 created_at 是记下来的时间,同样有定位价值。
const fmtRecallDate = (iso?: string | null): string => {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
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
    if (error) {
      logRecall({ at: Date.now(), query: q.slice(0, 40), hits: -1, preview: String(error.message ?? error) })
      return null
    }
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
      const date = fmtRecallDate(row.created_at)
      // 非 memory 来源（diary/letter/timeline/snack_post…）标注出处；全部带日期。
      const tag =
        row.source && row.source !== 'memory'
          ? `[${row.source}${date ? ` ${date}` : ''}] `
          : date
            ? `(${date}) `
            : ''
      picked.push(`${tag}${snippet}`)
    }
    const line = picked.length > 0 ? picked.join('；') : null
    logRecall({
      at: Date.now(),
      query: q.slice(0, 40),
      hits: picked.length,
      preview: line ? line.slice(0, 120) : '（无新命中，可能已注入过或库里没有相关记忆）',
    })
    return line
  } catch (err) {
    // 召回是锦上添花——超时/报错一律静默放弃，绝不挡住正常发消息。
    logRecall({ at: Date.now(), query: q.slice(0, 40), hits: -1, preview: String(err) })
    return null
  }
}
