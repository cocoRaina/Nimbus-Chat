import type {
  ChatMessage,
  ChatSession,
  CheckinEntry,
  Diary,
  HandoffLetter,
  Memory,
  SnackPost,
  SnackReply,
  SyzygyPost,
  SyzygyReply,
  TimelineEvent,
} from '../types'
import { supabase } from '../supabase/client'
import { computePeriodMetrics } from '../hooks/useHomeWidgetData'

type PeriodCycleRow = {
  start_date: string
  end_date?: string | null
  cycle_length?: number | null
  notes?: string | null
}

type SessionRow = {
  id: string
  user_id: string
  title: string
  created_at: string
  updated_at: string
  override_model: string | null
  override_reasoning: boolean | null
  is_archived: boolean | null
  archived_at: string | null
}

type MessageRow = {
  id: string
  session_id: string
  user_id: string
  role: ChatMessage['role']
  content: string
  created_at: string
  client_id: string | null
  client_created_at: string | null
  meta: ChatMessage['meta'] | null
}


type SnackPostRow = {
  id: string
  user_id: string
  content: string
  created_at: string
  updated_at: string
  is_deleted: boolean
}

type SnackReplyRow = {
  id: string
  user_id: string
  post_id: string
  role: SnackReply['role']
  content: string
  meta: SnackReply['meta'] | null
  created_at: string
  is_deleted: boolean
}


type SyzygyPostRow = {
  id: string
  user_id: string
  content: string
  model_id: string | null
  created_at: string
  updated_at: string
  is_deleted: boolean
}

type SyzygyReplyRow = {
  id: string
  user_id: string
  post_id: string
  author_role: SyzygyReply['authorRole']
  content: string
  model_id: string | null
  created_at: string
  is_deleted: boolean
}

type MemoryRow = {
  id: number
  category: string | null
  content: string
  tags: string[] | null
  source: string | null
  locked: boolean | null
  created_at: string
  updated_at: string
}

type CheckinRow = {
  id: string
  user_id: string
  checkin_date: string
  created_at: string
}

const mapSnackPostRow = (row: SnackPostRow): SnackPost => ({
  id: row.id,
  userId: row.user_id,
  content: row.content,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  isDeleted: row.is_deleted,
})

const mapSnackReplyRow = (row: SnackReplyRow): SnackReply => ({
  id: row.id,
  userId: row.user_id,
  postId: row.post_id,
  role: row.role,
  content: row.content,
  createdAt: row.created_at,
  isDeleted: row.is_deleted,
  meta: row.meta ?? undefined,
})


const mapSyzygyPostRow = (row: SyzygyPostRow): SyzygyPost => ({
  id: row.id,
  userId: row.user_id,
  content: row.content,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  isDeleted: row.is_deleted,
  modelId: row.model_id ?? null,
})

const mapSyzygyReplyRow = (row: SyzygyReplyRow): SyzygyReply => ({
  id: row.id,
  userId: row.user_id,
  postId: row.post_id,
  authorRole: row.author_role,
  content: row.content,
  createdAt: row.created_at,
  isDeleted: row.is_deleted,
  modelId: row.model_id ?? null,
})

const mapMemoryRow = (row: MemoryRow): Memory => ({
  id: row.id,
  category: row.category ?? '日常',
  content: row.content,
  tags: row.tags ?? [],
  source: row.source ?? 'manual',
  locked: row.locked ?? false,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const MEMORY_SELECT_FIELDS = 'id,category,content,tags,source,locked,created_at,updated_at'

const mapCheckinRow = (row: CheckinRow): CheckinEntry => ({
  id: row.id,
  userId: row.user_id,
  checkinDate: row.checkin_date,
  createdAt: row.created_at,
})

const mapSessionRow = (row: SessionRow): ChatSession => ({
  id: row.id,
  title: row.title,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  overrideModel: row.override_model ?? null,
  overrideReasoning: row.override_reasoning ?? null,
  isArchived: row.is_archived ?? false,
  archivedAt: row.archived_at ?? null,
})

const mapMessageRow = (row: MessageRow): ChatMessage => ({
  id: row.id,
  sessionId: row.session_id,
  role: row.role,
  content: row.content,
  createdAt: row.created_at,
  clientId: row.client_id ?? row.id,
  clientCreatedAt: row.client_created_at,
  meta: row.meta ?? undefined,
  pending: false,
})

const requireAuthenticatedUserId = async (): Promise<string> => {
  if (!supabase) {
    throw new Error('Supabase 客户端未配置')
  }
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser()
  if (error) {
    throw error
  }
  if (!user) {
    throw new Error('登录状态异常，请重新登录')
  }
  return user.id
}

export const fetchRemoteSessions = async (userId: string): Promise<ChatSession[]> => {
  if (!supabase) {
    return []
  }
  const { data, error } = await supabase
    .from('sessions')
    .select('id,user_id,title,created_at,updated_at,override_model,override_reasoning,is_archived,archived_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
  if (error) {
    throw error
  }
  return (data ?? []).map(mapSessionRow)
}

export const fetchRemoteMessages = async (userId: string): Promise<ChatMessage[]> => {
  if (!supabase) {
    return []
  }
  // Fetch most recent messages first so the PostgREST 1000-row default limit
  // always covers the user's active sessions (not the oldest archived ones).
  // applySnapshot / mergeMessages re-sorts ascending; localStorage fills in
  // older messages that fall outside this window.
  // Limit to recent 300 messages to avoid slow loads on large histories.
  // localStorage covers older messages; this window focuses on the active window.
  const { data, error } = await supabase
    .from('messages')
    .select('id,session_id,user_id,role,content,created_at,client_id,client_created_at,meta')
    .eq('user_id', userId)
    .order('client_created_at', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(300)
  if (error) {
    throw error
  }
  return (data ?? []).map(mapMessageRow)
}

export const fetchSessionRecentMessages = async (
  sessionId: string,
  limit = 20,
): Promise<ChatMessage[]> => {
  if (!supabase) return []
  const { data } = await supabase
    .from('messages')
    .select('id,session_id,user_id,role,content,created_at,client_id,client_created_at,meta')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: false })
    .limit(limit)
  return ((data ?? []) as MessageRow[]).map(mapMessageRow)
}

export const createRemoteSession = async (
  userId: string,
  title: string,
  id?: string,
): Promise<ChatSession> => {
  if (!supabase) {
    throw new Error('Supabase 客户端未配置')
  }
  const now = new Date().toISOString()
  const { data, error } = await supabase
    .from('sessions')
    .insert({
      ...(id ? { id } : {}),
      user_id: userId,
      title,
      created_at: now,
      updated_at: now,
    })
    .select('id,user_id,title,created_at,updated_at,override_model,override_reasoning,is_archived,archived_at')
    .single()
  if (error || !data) {
    throw error ?? new Error('创建会话失败')
  }
  return mapSessionRow(data as SessionRow)
}

export const renameRemoteSession = async (
  sessionId: string,
  title: string,
): Promise<ChatSession> => {
  if (!supabase) {
    throw new Error('Supabase 客户端未配置')
  }
  const now = new Date().toISOString()
  const { data, error } = await supabase
    .from('sessions')
    .update({ title, updated_at: now })
    .eq('id', sessionId)
    .select('id,user_id,title,created_at,updated_at,override_model,override_reasoning,is_archived,archived_at')
    .single()
  if (error || !data) {
    throw error ?? new Error('更新会话失败')
  }
  return mapSessionRow(data as SessionRow)
}

export const updateRemoteSessionOverride = async (
  sessionId: string,
  overrideModel: string | null,
): Promise<ChatSession> => {
  if (!supabase) {
    throw new Error('Supabase 客户端未配置')
  }
  const now = new Date().toISOString()
  const { data, error } = await supabase
    .from('sessions')
    .update({ override_model: overrideModel, updated_at: now })
    .eq('id', sessionId)
    .select('id,user_id,title,created_at,updated_at,override_model,override_reasoning,is_archived,archived_at')
    .single()
  if (error || !data) {
    throw error ?? new Error('更新会话模型失败')
  }
  return mapSessionRow(data as SessionRow)
}

export const updateRemoteSessionReasoningOverride = async (
  sessionId: string,
  overrideReasoning: boolean | null,
): Promise<ChatSession> => {
  if (!supabase) {
    throw new Error('Supabase 客户端未配置')
  }
  const now = new Date().toISOString()
  const { data, error } = await supabase
    .from('sessions')
    .update({ override_reasoning: overrideReasoning, updated_at: now })
    .eq('id', sessionId)
    .select('id,user_id,title,created_at,updated_at,override_model,override_reasoning,is_archived,archived_at')
    .single()
  if (error || !data) {
    throw error ?? new Error('更新会话思考链失败')
  }
  return mapSessionRow(data as SessionRow)
}


export const updateRemoteSessionArchiveState = async (
  sessionId: string,
  isArchived: boolean,
): Promise<ChatSession> => {
  if (!supabase) {
    throw new Error('Supabase 客户端未配置')
  }
  const userId = await requireAuthenticatedUserId()
  const updates = isArchived
    ? { is_archived: true, archived_at: new Date().toISOString() }
    : { is_archived: false, archived_at: null }
  const { data, error } = await supabase
    .from('sessions')
    .update(updates)
    .eq('id', sessionId)
    .eq('user_id', userId)
    .select('id,user_id,title,created_at,updated_at,override_model,override_reasoning,is_archived,archived_at')
    .single()
  if (error || !data) {
    throw error ?? new Error('更新会话抽屉状态失败')
  }
  return mapSessionRow(data as SessionRow)
}

export const deleteRemoteSession = async (sessionId: string) => {
  if (!supabase) {
    throw new Error('Supabase 客户端未配置')
  }
  // messages.session_id has ON DELETE CASCADE (see init.sql), so deleting the
  // session removes its messages atomically. The old two-step delete (messages
  // then session) could leave an empty session behind if the second step
  // failed.
  const { error: sessionError } = await supabase
    .from('sessions')
    .delete()
    .eq('id', sessionId)
  if (sessionError) {
    throw sessionError
  }
}

export const addRemoteMessage = async (
  sessionId: string,
  userId: string,
  role: ChatMessage['role'],
  content: string,
  clientId: string,
  clientCreatedAt: string,
  meta?: ChatMessage['meta'],
): Promise<{ message: ChatMessage; updatedAt: string }> => {
  if (!supabase) {
    throw new Error('Supabase 客户端未配置')
  }
  const safeMeta = meta ?? {}
  const now = new Date().toISOString()
  const { data, error } = await supabase
    .from('messages')
    .insert({
      session_id: sessionId,
      user_id: userId,
      role,
      content,
      created_at: now,
      client_id: clientId,
      client_created_at: clientCreatedAt,
      meta: safeMeta,
    })
    .select('id,session_id,user_id,role,content,created_at,client_id,client_created_at,meta')
    .single()
  if (error || !data) {
    throw error ?? new Error('发送消息失败')
  }
  const { error: sessionError } = await supabase
    .from('sessions')
    .update({ updated_at: now })
    .eq('id', sessionId)
  if (sessionError) {
    throw sessionError
  }
  return { message: mapMessageRow(data as MessageRow), updatedAt: now }
}

export const deleteRemoteMessage = async (messageId: string) => {
  if (!supabase) {
    throw new Error('Supabase 客户端未配置')
  }
  // Match on id OR client_id. When addRemoteMessage hit its 5s race timeout
  // but the insert actually landed, the local copy keeps the local clientId
  // as its id — deleting by server id alone would miss the row, and a later
  // fetch would "resurrect" the message. client_id is text; only test id.eq
  // when messageId is a valid UUID (the id column is uuid, so a non-UUID
  // local id would otherwise blow up the query with a cast error).
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const filters = [`client_id.eq.${messageId}`]
  if (UUID_RE.test(messageId)) filters.unshift(`id.eq.${messageId}`)
  const { error } = await supabase.from('messages').delete().or(filters.join(','))
  if (error) {
    throw error
  }
}


export const fetchSnackPosts = async (): Promise<SnackPost[]> => {
  if (!supabase) {
    return []
  }
  const { data, error } = await supabase
    .from('user_posts')
    .select('id,user_id,content,created_at,updated_at,is_deleted')
    .eq('is_deleted', false)
    .order('created_at', { ascending: false })
  if (error) {
    throw error
  }
  return (data ?? []).map((row) => mapSnackPostRow(row as SnackPostRow))
}


export const fetchDeletedSnackPosts = async (): Promise<SnackPost[]> => {
  if (!supabase) {
    return []
  }
  const { data, error } = await supabase
    .from('user_posts')
    .select('id,user_id,content,created_at,updated_at,is_deleted')
    .eq('is_deleted', true)
    .order('updated_at', { ascending: false })

  if (error) {
    throw error
  }
  return (data ?? []).map((row) => mapSnackPostRow(row as SnackPostRow))
}

export const createSnackPost = async (content: string): Promise<SnackPost> => {
  if (!supabase) {
    throw new Error('Supabase 客户端未配置')
  }
  const { data, error } = await supabase
    .from('user_posts')
    .insert({ content })
    .select('id,user_id,content,created_at,updated_at,is_deleted')
    .single()

  if (error || !data) {
    throw error ?? new Error('发布零食记录失败')
  }
  return mapSnackPostRow(data as SnackPostRow)
}


export const restoreSnackPost = async (postId: string): Promise<void> => {
  if (!supabase) {
    throw new Error('Supabase 客户端未配置')
  }
  const { error } = await supabase
    .from('user_posts')
    .update({ is_deleted: false, deleted_at: null })
    .eq('id', postId)
  if (error) {
    throw error
  }
}

export const softDeleteSnackPost = async (postId: string): Promise<void> => {
  if (!supabase) {
    throw new Error('Supabase 客户端未配置')
  }
  const { error } = await supabase
    .from('user_posts')
    .update({ is_deleted: true, deleted_at: new Date().toISOString() })
    .eq('id', postId)
  if (error) {
    throw error
  }
}

export const fetchSnackReplies = async (postIds: string[]): Promise<SnackReply[]> => {
  if (!supabase || postIds.length === 0) {
    return []
  }
  const { data, error } = await supabase
    .from('user_replies')
    .select('id,user_id,post_id,role,content,meta,created_at,is_deleted')
    .in('post_id', postIds)
    .in('role', ['user', 'assistant'])
    .eq('is_deleted', false)
    .order('created_at', { ascending: true })
  if (error) {
    throw error
  }
  return (data ?? []).map((row) => mapSnackReplyRow(row as SnackReplyRow))
}

export const fetchSnackRepliesByPost = async (postId: string): Promise<SnackReply[]> => {
  if (!supabase) {
    return []
  }
  const { data, error } = await supabase
    .from('user_replies')
    .select('id,user_id,post_id,role,content,meta,created_at,is_deleted')
    .eq('post_id', postId)
    .eq('is_deleted', false)
    .order('created_at', { ascending: true })

  if (error) {
    throw error
  }
  return (data ?? []).map((row) => mapSnackReplyRow(row as SnackReplyRow))
}

export const createSnackReply = async (
  postId: string,
  role: SnackReply['role'],
  content: string,
  meta: SnackReply['meta'],
): Promise<SnackReply> => {
  if (!supabase) {
    throw new Error('Supabase 客户端未配置')
  }
  const { data, error } = await supabase
    .from('user_replies')
    .insert({ post_id: postId, role, content, meta: meta ?? {} })
    .select('id,user_id,post_id,role,content,meta,created_at,is_deleted')
    .single()
  if (error || !data) {
    throw error ?? new Error('保存零食回复失败')
  }
  return mapSnackReplyRow(data as SnackReplyRow)
}

export const softDeleteSnackReply = async (replyId: string): Promise<void> => {
  if (!supabase) {
    throw new Error('Supabase 客户端未配置')
  }
  const { error } = await supabase
    .from('user_replies')
    .update({ is_deleted: true, deleted_at: new Date().toISOString() })
    .eq('id', replyId)

  if (error) {
    throw error
  }
}

export const fetchDeletedSnackReplies = async (): Promise<SnackReply[]> => {
  if (!supabase) {
    return []
  }
  const { data, error } = await supabase
    .from('user_replies')
    .select('id,user_id,post_id,role,content,meta,created_at,is_deleted')
    .eq('is_deleted', true)
    .order('created_at', { ascending: false })

  if (error) {
    throw error
  }
  return (data ?? []).map((row) => mapSnackReplyRow(row as SnackReplyRow))
}

export const restoreSnackReply = async (replyId: string): Promise<void> => {
  if (!supabase) {
    throw new Error('Supabase 客户端未配置')
  }
  const { error } = await supabase
    .from('user_replies')
    .update({ is_deleted: false })
    .eq('id', replyId)

  if (error) {
    throw error
  }
}

export const permanentlyDeleteSnackPost = async (postId: string): Promise<void> => {
  if (!supabase) {
    throw new Error('Supabase 客户端未配置')
  }
  // user_replies.post_id has ON DELETE CASCADE (init.sql), so deleting the
  // post removes its replies atomically — no separate (non-atomic) replies
  // delete that could leave orphans if the second step failed.
  const { error: postError } = await supabase
    .from('user_posts')
    .delete()
    .eq('id', postId)
    .eq('is_deleted', true)

  if (postError) {
    throw postError
  }
}

export const permanentlyDeleteSnackReply = async (replyId: string): Promise<void> => {
  if (!supabase) {
    throw new Error('Supabase 客户端未配置')
  }
  const { error } = await supabase
    .from('user_replies')
    .delete()
    .eq('id', replyId)
    .eq('is_deleted', true)

  if (error) {
    throw error
  }
}


export const fetchSyzygyPosts = async (): Promise<SyzygyPost[]> => {
  if (!supabase) {
    return []
  }
  const { data, error } = await supabase
    .from('assistant_posts')
    .select('id,user_id,content,model_id,created_at,updated_at,is_deleted')
    .eq('is_deleted', false)
    .order('created_at', { ascending: false })
  if (error) {
    throw error
  }
  return (data ?? []).map((row) => mapSyzygyPostRow(row as SyzygyPostRow))
}

export const fetchDeletedSyzygyPosts = async (): Promise<SyzygyPost[]> => {
  if (!supabase) {
    return []
  }
  const { data, error } = await supabase
    .from('assistant_posts')
    .select('id,user_id,content,model_id,created_at,updated_at,is_deleted')
    .eq('is_deleted', true)
    .order('updated_at', { ascending: false })

  if (error) {
    throw error
  }
  return (data ?? []).map((row) => mapSyzygyPostRow(row as SyzygyPostRow))
}

export const createSyzygyPost = async (
  content: string,
  selectedModelId: string | null = null,
): Promise<SyzygyPost> => {
  if (!supabase) {
    throw new Error('Supabase 客户端未配置')
  }
  const userId = await requireAuthenticatedUserId()
  const { data, error } = await supabase
    .from('assistant_posts')
    .insert({ user_id: userId, content, model_id: selectedModelId ?? null })
    .select('id,user_id,content,model_id,created_at,updated_at,is_deleted')
    .single()

  if (error || !data) {
    throw error ?? new Error('发布观察日志失败')
  }
  return mapSyzygyPostRow(data as SyzygyPostRow)
}

export const restoreSyzygyPost = async (postId: string): Promise<void> => {
  if (!supabase) {
    throw new Error('Supabase 客户端未配置')
  }
  const { error } = await supabase
    .from('assistant_posts')
    .update({ is_deleted: false, deleted_at: null })
    .eq('id', postId)

  if (error) {
    throw error
  }
}

export const softDeleteSyzygyPost = async (postId: string): Promise<void> => {
  if (!supabase) {
    throw new Error('Supabase 客户端未配置')
  }
  const { error } = await supabase
    .from('assistant_posts')
    .update({ is_deleted: true, deleted_at: new Date().toISOString() })
    .eq('id', postId)

  if (error) {
    throw error
  }
}

export const fetchSyzygyReplies = async (postIds: string[]): Promise<SyzygyReply[]> => {
  if (!supabase || postIds.length === 0) {
    return []
  }
  const { data, error } = await supabase
    .from('assistant_replies')
    .select('id,user_id,post_id,author_role,content,model_id,created_at,is_deleted')
    .in('post_id', postIds)
    .in('author_role', ['user', 'ai'])
    .eq('is_deleted', false)
    .order('created_at', { ascending: true })
  if (error) {
    throw error
  }
  return (data ?? []).map((row) => mapSyzygyReplyRow(row as SyzygyReplyRow))
}

export const fetchSyzygyRepliesByPost = async (postId: string): Promise<SyzygyReply[]> => {
  if (!supabase) {
    return []
  }
  const { data, error } = await supabase
    .from('assistant_replies')
    .select('id,user_id,post_id,author_role,content,model_id,created_at,is_deleted')
    .eq('post_id', postId)
    .eq('is_deleted', false)
    .order('created_at', { ascending: true })

  if (error) {
    throw error
  }
  return (data ?? []).map((row) => mapSyzygyReplyRow(row as SyzygyReplyRow))
}

export const createSyzygyReply = async (
  postId: string,
  authorRole: SyzygyReply['authorRole'],
  content: string,
  selectedModelId: string | null = null,
): Promise<SyzygyReply> => {
  if (!supabase) {
    throw new Error('Supabase 客户端未配置')
  }
  const userId = await requireAuthenticatedUserId()
  const { data, error } = await supabase
    .from('assistant_replies')
    .insert({
      user_id: userId,
      post_id: postId,
      author_role: authorRole,
      content,
      model_id: selectedModelId ?? null,
    })
    .select('id,user_id,post_id,author_role,content,model_id,created_at,is_deleted')
    .single()
  if (error || !data) {
    throw error ?? new Error('保存观察日志回复失败')
  }
  return mapSyzygyReplyRow(data as SyzygyReplyRow)
}

export const softDeleteSyzygyReply = async (replyId: string): Promise<void> => {
  if (!supabase) {
    throw new Error('Supabase 客户端未配置')
  }
  const { error } = await supabase
    .from('assistant_replies')
    .update({ is_deleted: true, deleted_at: new Date().toISOString() })
    .eq('id', replyId)

  if (error) {
    throw error
  }
}

export const fetchDeletedSyzygyReplies = async (): Promise<SyzygyReply[]> => {
  if (!supabase) {
    return []
  }
  const { data, error } = await supabase
    .from('assistant_replies')
    .select('id,user_id,post_id,author_role,content,model_id,created_at,is_deleted')
    .eq('is_deleted', true)
    .order('created_at', { ascending: false })

  if (error) {
    throw error
  }
  return (data ?? []).map((row) => mapSyzygyReplyRow(row as SyzygyReplyRow))
}

export const restoreSyzygyReply = async (replyId: string): Promise<void> => {
  if (!supabase) {
    throw new Error('Supabase 客户端未配置')
  }
  const { error } = await supabase
    .from('assistant_replies')
    .update({ is_deleted: false, deleted_at: null })
    .eq('id', replyId)

  if (error) {
    throw error
  }
}

export const permanentlyDeleteSyzygyPost = async (postId: string): Promise<void> => {
  if (!supabase) {
    throw new Error('Supabase 客户端未配置')
  }
  // assistant_replies.post_id has ON DELETE CASCADE (init.sql) — delete the
  // post in one atomic step; replies follow automatically.
  const { error: postError } = await supabase
    .from('assistant_posts')
    .delete()
    .eq('id', postId)
    .eq('is_deleted', true)

  if (postError) {
    throw postError
  }
}

export const permanentlyDeleteSyzygyReply = async (replyId: string): Promise<void> => {
  if (!supabase) {
    throw new Error('Supabase 客户端未配置')
  }
  const { error } = await supabase
    .from('assistant_replies')
    .delete()
    .eq('id', replyId)
    .eq('is_deleted', true)

  if (error) {
    throw error
  }
}

export const listMemories = async (): Promise<Memory[]> => {
  if (!supabase) {
    return []
  }
  const { data, error } = await supabase
    .from('memories')
    .select(MEMORY_SELECT_FIELDS)
    .order('created_at', { ascending: false })
  if (error) {
    throw error
  }
  return (data ?? []).map((row) => mapMemoryRow(row as MemoryRow))
}

// Fetch only LOCKED memories — these are the ones the user pinned as
// important. The vault accumulates a lot of noise (old / imported / junk
// memories), so we only auto-inject the curated locked set; everything else
// stays searchable via search_memory but out of the always-on prefix.
export const listLockedMemories = async (): Promise<Memory[]> => {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('memories')
    .select(MEMORY_SELECT_FIELDS)
    .eq('locked', true)
    .order('created_at', { ascending: false })
  if (error) {
    throw error
  }
  return (data ?? []).map((row) => mapMemoryRow(row as MemoryRow))
}

// Builds the "always-injected" core-memory block for the chat system prompt
// from the LOCKED memories only. Sorted by id so the bytes are stable across
// turns → Anthropic prompt cache keeps hitting; the block only changes (one
// cold write next turn) when the user locks/unlocks/edits a memory.
export const buildMemorySystemSection = (memories: Memory[]): string => {
  const locked = memories.filter((m) => m.locked)
  if (!locked.length) return ''
  const sorted = locked.sort((a, b) => a.id - b.id)
  const lines = sorted.map((m) => {
    const tags = m.tags.length > 0 ? ' ' + m.tags.map((t) => `#${t}`).join(' ') : ''
    return `- （${m.category}）${m.content}${tags}`
  })
  return (
    '\n\n## 关于 TA 的核心记忆\n' +
    '（以下是用户标记为重要、要你长期记住的事，默认已知，**无需**用搜索工具去查；' +
    '其余未锁定的记忆、以及日记 / 交接信 / 时间轴，才用 search_memory / search_handoff 读取。）\n' +
    lines.join('\n')
  )
}

// Compact snapshot of the user's recent health state for daily injection
// into the first user message of the day. Returns null if no data exists.
export const fetchHealthSnapshot = async (): Promise<string | null> => {
  if (!supabase) return null
  const [healthResult, periodResult] = await Promise.all([
    supabase
      .from('health_data')
      .select('date,sleep_hours,deep_sleep_hours,light_sleep_hours,rem_sleep_hours,sleep_quality,steps,notes')
      .order('date', { ascending: false })
      .limit(3),
    // Up to 6 recent cycles: the newest row is the "current" one, the
    // rest feed the adaptive cycle-length median (same as the home widget).
    supabase
      .from('period_tracking')
      .select('start_date,end_date,cycle_length,notes')
      .order('start_date', { ascending: false })
      .limit(6),
  ])

  const parts: string[] = []
  type HealthRow = {
    date?: string
    sleep_hours?: number
    deep_sleep_hours?: number
    light_sleep_hours?: number
    rem_sleep_hours?: number
    sleep_quality?: string
    steps?: number
    notes?: string
  }
  // The auto health sync often creates today's row as an empty stub before
  // Health Connect has anything (sleep lands late morning, steps trickle in).
  // Taking strictly the latest row then yields nothing to inject — skip
  // empty stubs and fall back to the newest row that actually has data.
  const rows = (healthResult.data ?? []) as HealthRow[]
  const row = rows.find((r) => r.sleep_hours || r.steps || r.notes)

  if (row) {
    const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())
    const items: string[] = []
    if (row.sleep_hours) {
      const stages: string[] = []
      if (row.deep_sleep_hours) stages.push(`深睡 ${row.deep_sleep_hours}h`)
      if (row.rem_sleep_hours) stages.push(`REM ${row.rem_sleep_hours}h`)
      if (row.light_sleep_hours) stages.push(`浅睡 ${row.light_sleep_hours}h`)
      const stageStr = stages.length > 0 ? `（${stages.join('／')}）` : row.sleep_quality ? `（${row.sleep_quality}）` : ''
      items.push(`昨晚睡了 ${row.sleep_hours}h${stageStr}`)
    }
    if (row.steps) items.push(`步数 ${row.steps}`)
    if (row.notes) items.push(row.notes)
    if (items.length) {
      // Data from an older day (today's stub was empty) — label it so the
      // model doesn't present stale numbers as last night's.
      const staleLabel = row.date && row.date !== todayStr ? `（${row.date} 记录）` : ''
      parts.push(`${staleLabel}${items.join('，')}`)
    }
  }

  // Label the period line with phase + cycle day (e.g. 黄体期，本周期第20天)
  // instead of the bare start date — computed the same way as the home
  // widget so the model and the UI never disagree.
  const periodRows = (periodResult.data ?? []) as PeriodCycleRow[]
  const current = periodRows[0]
  if (current?.start_date) {
    const metrics = computePeriodMetrics(
      {
        start_date: current.start_date,
        end_date: current.end_date ?? null,
        cycle_length: current.cycle_length ?? null,
        notes: current.notes ?? null,
      },
      periodRows,
    )
    if (metrics) {
      const { phase, cycleDay, daysToNext } = metrics
      const nextHint =
        daysToNext > 0
          ? `预计 ${daysToNext} 天后下次经期`
          : daysToNext === 0
            ? '预计今天来下次经期'
            : `下次经期已推迟 ${-daysToNext} 天`
      parts.push(
        phase === '经期中'
          ? `经期中，第 ${cycleDay} 天（${current.start_date} 起）`
          : `${phase}，处于本周期第 ${cycleDay} 天，${nextHint}（上次经期 ${current.start_date}）`,
      )
    } else {
      parts.push(`上次经期 ${current.start_date}`)
    }
  }

  return parts.length > 0 ? parts.join('；') : null
}

export const createMemory = async (input: {
  content: string
  category?: string
  tags?: string[]
  source?: string
}): Promise<Memory> => {
  if (!supabase) {
    throw new Error('Supabase 客户端未配置')
  }
  const { data, error } = await supabase
    .from('memories')
    .insert({
      content: input.content,
      category: input.category?.trim() || '日常',
      tags: input.tags ?? [],
      // Only pass source when the caller actually wants to override
      // the column default ('manual'). Without this, AI-promoted
      // memories would silently fall into the manual bucket.
      ...(input.source ? { source: input.source } : {}),
    })
    .select(MEMORY_SELECT_FIELDS)
    .single()
  if (error || !data) {
    throw error ?? new Error('创建记忆失败')
  }
  return mapMemoryRow(data as MemoryRow)
}

export const updateMemory = async (
  id: number,
  patch: {
    content?: string
    category?: string
    tags?: string[]
    locked?: boolean
  },
): Promise<Memory> => {
  if (!supabase) {
    throw new Error('Supabase 客户端未配置')
  }
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (typeof patch.content === 'string') updates.content = patch.content
  if (typeof patch.category === 'string') updates.category = patch.category.trim() || '日常'
  if (Array.isArray(patch.tags)) updates.tags = patch.tags
  if (typeof patch.locked === 'boolean') updates.locked = patch.locked
  // When content changes, clear embedding so the trigger recomputes it via auto_embed.
  if (typeof patch.content === 'string') {
    updates.embedding = null
  }
  const { data, error } = await supabase
    .from('memories')
    .update(updates)
    .eq('id', id)
    .select(MEMORY_SELECT_FIELDS)
    .single()
  if (error || !data) {
    throw error ?? new Error('更新记忆失败')
  }
  return mapMemoryRow(data as MemoryRow)
}

export const deleteMemory = async (id: number): Promise<void> => {
  if (!supabase) {
    throw new Error('Supabase 客户端未配置')
  }
  const { error } = await supabase.from('memories').delete().eq('id', id)
  if (error) {
    throw error
  }
}

export const listMemoryCategories = async (): Promise<string[]> => {
  if (!supabase) {
    return []
  }
  const { data, error } = await supabase
    .from('memories')
    .select('category')
    .order('category', { ascending: true })
  if (error) {
    throw error
  }
  const set = new Set<string>()
  for (const row of (data ?? []) as Array<{ category: string | null }>) {
    if (row.category) set.add(row.category)
  }
  return Array.from(set)
}

export const createTodayCheckin = async (checkinDate: string): Promise<'created' | 'already_checked_in'> => {
  if (!supabase) {
    throw new Error('Supabase 客户端未配置')
  }
  const userId = await requireAuthenticatedUserId()
  const { error } = await supabase.from('checkins').insert({
    user_id: userId,
    checkin_date: checkinDate,
  })
  if (!error) {
    return 'created'
  }

  if (error.code === '23505') {
    return 'already_checked_in'
  }
  throw error
}

export const fetchRecentCheckins = async (limit = 60): Promise<CheckinEntry[]> => {
  if (!supabase) {
    return []
  }
  const userId = await requireAuthenticatedUserId()
  const { data, error } = await supabase
    .from('checkins')
    .select('id,user_id,checkin_date,created_at')
    .eq('user_id', userId)
    .order('checkin_date', { ascending: false })
    .limit(limit)
  if (error) {
    throw error
  }
  return (data ?? []).map((row) => mapCheckinRow(row as CheckinRow))
}

export const fetchCheckinTotalCount = async (): Promise<number> => {
  if (!supabase) {
    return 0
  }
  const userId = await requireAuthenticatedUserId()
  const { count, error } = await supabase
    .from('checkins')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
  if (error) {
    throw error
  }
  return count ?? 0
}

// ----- Diaries -----

type DiaryRow = {
  id: number
  date: string
  title: string | null
  author: string | null
  mood: string | null
  content: string
  created_at: string
}

const DIARY_SELECT_FIELDS = 'id,date,title,author,mood,content,created_at'

const mapDiaryRow = (row: DiaryRow): Diary => ({
  id: row.id,
  date: row.date,
  title: row.title,
  author: row.author,
  mood: row.mood,
  content: row.content,
  createdAt: row.created_at,
})

export const listDiaries = async (): Promise<Diary[]> => {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('diaries')
    .select(DIARY_SELECT_FIELDS)
    .order('date', { ascending: false })
  if (error) throw error
  return (data ?? []).map((row) => mapDiaryRow(row as DiaryRow))
}

export const createDiary = async (input: {
  date: string
  title?: string | null
  author?: string | null
  mood?: string | null
  content: string
}): Promise<Diary> => {
  if (!supabase) throw new Error('Supabase 客户端未配置')
  const { data, error } = await supabase
    .from('diaries')
    .insert({
      date: input.date,
      title: input.title ?? null,
      author: input.author ?? null,
      mood: input.mood ?? null,
      content: input.content,
    })
    .select(DIARY_SELECT_FIELDS)
    .single()
  if (error || !data) throw error ?? new Error('创建日记失败')
  return mapDiaryRow(data as DiaryRow)
}

export const updateDiary = async (
  id: number,
  patch: { date?: string; title?: string | null; author?: string | null; mood?: string | null; content?: string },
): Promise<Diary> => {
  if (!supabase) throw new Error('Supabase 客户端未配置')
  const updates: Record<string, unknown> = {}
  if (typeof patch.date === 'string') updates.date = patch.date
  if (patch.title !== undefined) updates.title = patch.title
  if (patch.author !== undefined) updates.author = patch.author
  if (patch.mood !== undefined) updates.mood = patch.mood
  if (typeof patch.content === 'string') updates.content = patch.content
  const { data, error } = await supabase
    .from('diaries')
    .update(updates)
    .eq('id', id)
    .select(DIARY_SELECT_FIELDS)
    .single()
  if (error || !data) throw error ?? new Error('更新日记失败')
  return mapDiaryRow(data as DiaryRow)
}

export const deleteDiary = async (id: number): Promise<void> => {
  if (!supabase) throw new Error('Supabase 客户端未配置')
  const { error } = await supabase.from('diaries').delete().eq('id', id)
  if (error) throw error
}

// ----- Handoff Letters -----

type HandoffLetterRow = {
  id: number
  date: string
  title: string | null
  content: string
  signature: string | null
  created_at: string
}

const LETTER_SELECT_FIELDS = 'id,date,title,content,signature,created_at'

const mapLetterRow = (row: HandoffLetterRow): HandoffLetter => ({
  id: row.id,
  date: row.date,
  title: row.title,
  content: row.content,
  signature: row.signature,
  createdAt: row.created_at,
})

export const listHandoffLetters = async (): Promise<HandoffLetter[]> => {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('handoff_letters')
    .select(LETTER_SELECT_FIELDS)
    .order('date', { ascending: false })
  if (error) throw error
  return (data ?? []).map((row) => mapLetterRow(row as HandoffLetterRow))
}

export const createHandoffLetter = async (input: {
  date: string
  title?: string | null
  content: string
  signature?: string | null
}): Promise<HandoffLetter> => {
  if (!supabase) throw new Error('Supabase 客户端未配置')
  const { data, error } = await supabase
    .from('handoff_letters')
    .insert({
      date: input.date,
      title: input.title ?? null,
      content: input.content,
      signature: input.signature ?? null,
    })
    .select(LETTER_SELECT_FIELDS)
    .single()
  if (error || !data) throw error ?? new Error('创建交接信失败')
  return mapLetterRow(data as HandoffLetterRow)
}

export const updateHandoffLetter = async (
  id: number,
  patch: { date?: string; title?: string | null; content?: string; signature?: string | null },
): Promise<HandoffLetter> => {
  if (!supabase) throw new Error('Supabase 客户端未配置')
  const updates: Record<string, unknown> = {}
  if (typeof patch.date === 'string') updates.date = patch.date
  if (patch.title !== undefined) updates.title = patch.title
  if (typeof patch.content === 'string') updates.content = patch.content
  if (patch.signature !== undefined) updates.signature = patch.signature
  const { data, error } = await supabase
    .from('handoff_letters')
    .update(updates)
    .eq('id', id)
    .select(LETTER_SELECT_FIELDS)
    .single()
  if (error || !data) throw error ?? new Error('更新交接信失败')
  return mapLetterRow(data as HandoffLetterRow)
}

export const deleteHandoffLetter = async (id: number): Promise<void> => {
  if (!supabase) throw new Error('Supabase 客户端未配置')
  const { error } = await supabase.from('handoff_letters').delete().eq('id', id)
  if (error) throw error
}

// ----- Timeline (里程碑事件) -----

type TimelineRow = {
  id: number
  event_date: string
  title: string
  description: string | null
  category: string | null
  importance: number | null
  source: string | null
  created_at: string
}

const TIMELINE_SELECT_FIELDS = 'id,event_date,title,description,category,importance,source,created_at'

const mapTimelineRow = (row: TimelineRow): TimelineEvent => ({
  id: row.id,
  eventDate: row.event_date,
  title: row.title,
  description: row.description,
  category: row.category ?? '日常',
  importance: row.importance ?? 3,
  source: row.source ?? 'manual',
  createdAt: row.created_at,
})

export const listTimelineEvents = async (): Promise<TimelineEvent[]> => {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('timeline')
    .select(TIMELINE_SELECT_FIELDS)
    .order('event_date', { ascending: false })
  if (error) throw error
  return (data ?? []).map((row) => mapTimelineRow(row as TimelineRow))
}

export const createTimelineEvent = async (input: {
  eventDate: string
  title: string
  description?: string | null
  category?: string | null
  importance?: number
}): Promise<TimelineEvent> => {
  if (!supabase) throw new Error('Supabase 客户端未配置')
  const importance = Math.max(1, Math.min(5, Math.round(input.importance ?? 3)))
  const { data, error } = await supabase
    .from('timeline')
    .insert({
      event_date: input.eventDate,
      title: input.title,
      description: input.description ?? null,
      category: input.category?.trim() || '日常',
      importance,
    })
    .select(TIMELINE_SELECT_FIELDS)
    .single()
  if (error || !data) throw error ?? new Error('创建时间轴事件失败')
  return mapTimelineRow(data as TimelineRow)
}

export const updateTimelineEvent = async (
  id: number,
  patch: {
    eventDate?: string
    title?: string
    description?: string | null
    category?: string | null
    importance?: number
  },
): Promise<TimelineEvent> => {
  if (!supabase) throw new Error('Supabase 客户端未配置')
  const updates: Record<string, unknown> = {}
  if (typeof patch.eventDate === 'string') updates.event_date = patch.eventDate
  if (typeof patch.title === 'string') updates.title = patch.title
  if (patch.description !== undefined) updates.description = patch.description
  if (patch.category !== undefined) updates.category = patch.category?.trim() || '日常'
  if (typeof patch.importance === 'number') {
    updates.importance = Math.max(1, Math.min(5, Math.round(patch.importance)))
  }
  const { data, error } = await supabase
    .from('timeline')
    .update(updates)
    .eq('id', id)
    .select(TIMELINE_SELECT_FIELDS)
    .single()
  if (error || !data) throw error ?? new Error('更新时间轴事件失败')
  return mapTimelineRow(data as TimelineRow)
}

export const deleteTimelineEvent = async (id: number): Promise<void> => {
  if (!supabase) throw new Error('Supabase 客户端未配置')
  const { error } = await supabase.from('timeline').delete().eq('id', id)
  if (error) throw error
}
