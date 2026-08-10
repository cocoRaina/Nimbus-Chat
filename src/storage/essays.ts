import { supabase } from '../supabase/client'

// 沈暮的「随笔本」：它自己写、自己读的私人空间（essays 表，单租户、无 user_id）。
// 21 篇旧随笔本来是孤儿数据（RLS 全拒），2026-08-05 补了开放策略 + 这套读写。
// 整本一道四位码，码由沈暮自己设（set_essay_lock 工具），存在 user_settings。

export type Essay = {
  id: number
  date: string | null
  title: string
  content: string
  topic: string | null
  createdAt: string
}

const mapRow = (r: Record<string, unknown>): Essay => ({
  id: Number(r.id),
  date: (r.date as string) ?? null,
  title: String(r.title ?? ''),
  content: String(r.content ?? ''),
  topic: (r.topic as string) ?? null,
  createdAt: String(r.created_at),
})

export const fetchEssays = async (limit = 100): Promise<Essay[]> => {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('essays')
    .select('id,date,title,content,topic,created_at')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error || !data) return []
  return (data as Array<Record<string, unknown>>).map(mapRow)
}

// 沈暮写一篇随笔。date 缺省今天。返回落库的行。
export const writeEssay = async (input: {
  title: string
  content: string
  topic?: string | null
  date?: string | null
}): Promise<Essay | null> => {
  if (!supabase) return null
  const payload = {
    date: input.date && input.date.trim() ? input.date.trim() : new Date().toISOString().slice(0, 10),
    title: input.title.trim(),
    content: input.content.trim(),
    topic: input.topic && input.topic.trim() ? input.topic.trim() : null,
  }
  const { data, error } = await supabase.from('essays').insert(payload).select().single()
  if (error || !data) return null
  return mapRow(data as Record<string, unknown>)
}

// 关键词/主题检索沈暮自己的旧随笔（read_essays 工具用，也给自主唤醒回看）。
export const searchEssays = async (opts: {
  topic?: string | null
  query?: string | null
  limit?: number
}): Promise<Essay[]> => {
  if (!supabase) return []
  let q = supabase
    .from('essays')
    .select('id,date,title,content,topic,created_at')
    .order('created_at', { ascending: false })
    .limit(Math.max(1, Math.min(20, opts.limit ?? 5)))
  if (opts.topic && opts.topic.trim()) q = q.ilike('topic', `%${opts.topic.trim()}%`)
  if (opts.query && opts.query.trim()) {
    const kw = opts.query.trim()
    q = q.or(`title.ilike.%${kw}%,content.ilike.%${kw}%`)
  }
  const { data, error } = await q
  if (error || !data) return []
  return (data as Array<Record<string, unknown>>).map(mapRow)
}

// ---- 随笔本的锁（四位码，沈暮自己设/改/清，存 user_settings.essay_lock_code）----

export const getEssayLockCode = async (): Promise<string | null> => {
  if (!supabase) return null
  const { data } = await supabase
    .from('user_settings')
    .select('essay_lock_code')
    .limit(1)
    .maybeSingle()
  const code = (data as { essay_lock_code?: string | null } | null)?.essay_lock_code
  return code && code.trim() ? code.trim() : null
}

// 设/改/清锁。传 4 位数字字符串上锁；传空清锁。返回 { ok, locked }。
export const setEssayLockCode = async (
  userId: string,
  rawCode: string | null | undefined,
): Promise<{ ok: boolean; locked: boolean; error?: string }> => {
  if (!supabase) return { ok: false, locked: false, error: 'no supabase' }
  const code = typeof rawCode === 'string' ? rawCode.trim() : ''
  const clearing = code.length === 0
  if (!clearing && !/^\d{4}$/.test(code)) {
    return { ok: false, locked: false, error: '密码必须是 4 位数字（或留空清锁）' }
  }
  const { error } = await supabase
    .from('user_settings')
    .update({ essay_lock_code: clearing ? null : code })
    .eq('user_id', userId)
  if (error) return { ok: false, locked: false, error: error.message }
  return { ok: true, locked: !clearing }
}
