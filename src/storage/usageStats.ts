import { supabase } from '../supabase/client'

export type UsageSource = 'chat' | 'snacks' | 'syzygy' | 'memory_extract' | 'other'

export type UsageLogInput = {
  userId: string
  model: string
  promptTokens: number
  completionTokens: number
  totalTokens?: number
  cachedTokens?: number
  source?: UsageSource | string
  provider?: string
  sessionId?: string | null
  rawUsage?: unknown
  requestDebug?: unknown
  // Force-insert even when token counts are all zero. Used to persist a
  // failure row (with requestDebug) for troubleshooting — a hard 400 returns
  // no usage, so without this it would slip past the no-usage guard below.
  forceRecord?: boolean
}

export type UsageLogRow = {
  id: string
  userId: string
  model: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cachedTokens: number
  source: string
  provider: string
  sessionId: string | null
  sessionTitle: string | null
  createdAt: string
}

type UsageLogRecord = {
  id: string
  user_id: string
  model: string
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  cached_tokens: number | null
  source: string
  provider: string | null
  session_id: string | null
  created_at: string
  sessions?: { title: string | null } | { title: string | null }[] | null
}

const mapRow = (row: UsageLogRecord): UsageLogRow => ({
  id: row.id,
  userId: row.user_id,
  model: row.model,
  promptTokens: row.prompt_tokens ?? 0,
  completionTokens: row.completion_tokens ?? 0,
  totalTokens: row.total_tokens ?? 0,
  cachedTokens: row.cached_tokens ?? 0,
  source: row.source,
  provider: row.provider ?? 'openrouter',
  sessionId: row.session_id,
  sessionTitle: Array.isArray(row.sessions)
    ? row.sessions[0]?.title ?? null
    : row.sessions?.title ?? null,
  createdAt: row.created_at,
})

export const recordUsage = async (input: UsageLogInput): Promise<void> => {
  if (!supabase) {
    return
  }
  const promptTokens = Math.max(0, Math.round(input.promptTokens || 0))
  const completionTokens = Math.max(0, Math.round(input.completionTokens || 0))
  const totalTokens = Math.max(0, Math.round(input.totalTokens ?? promptTokens + completionTokens))
  const cachedTokens = Math.max(0, Math.min(promptTokens, Math.round(input.cachedTokens ?? 0)))
  if (!input.forceRecord && promptTokens === 0 && completionTokens === 0 && totalTokens === 0) {
    return
  }
  const { error } = await supabase.from('usage_logs').insert({
    user_id: input.userId,
    model: input.model || 'unknown',
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    cached_tokens: cachedTokens,
    source: input.source ?? 'chat',
    provider: input.provider ?? 'openrouter',
    session_id: input.sessionId ?? null,
    raw_usage: input.rawUsage ?? null,
    request_debug: input.requestDebug ?? null,
  })
  if (error) {
    console.warn('记录 usage 失败', error)
  }
}

export const fetchUsageLogs = async (
  userId: string,
  since?: Date,
): Promise<UsageLogRow[]> => {
  if (!supabase) {
    return []
  }
  let query = supabase
    .from('usage_logs')
    .select('id,user_id,model,prompt_tokens,completion_tokens,total_tokens,cached_tokens,source,provider,session_id,created_at,sessions(title)')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(5000)
  if (since) {
    query = query.gte('created_at', since.toISOString())
  }
  const { data, error } = await query
  if (error) {
    throw error
  }
  return (data ?? []).map((row) => mapRow(row as UsageLogRecord))
}

export type UsageAggregate = {
  model: string
  calls: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cachedTokens: number
}

export const aggregateByModel = (rows: UsageLogRow[]): UsageAggregate[] => {
  const map = new Map<string, UsageAggregate>()
  for (const row of rows) {
    const existing = map.get(row.model)
    if (existing) {
      existing.calls += 1
      existing.promptTokens += row.promptTokens
      existing.completionTokens += row.completionTokens
      existing.totalTokens += row.totalTokens
      existing.cachedTokens += row.cachedTokens
    } else {
      map.set(row.model, {
        model: row.model,
        calls: 1,
        promptTokens: row.promptTokens,
        completionTokens: row.completionTokens,
        totalTokens: row.totalTokens,
        cachedTokens: row.cachedTokens,
      })
    }
  }
  return Array.from(map.values()).sort((a, b) => b.totalTokens - a.totalTokens)
}
