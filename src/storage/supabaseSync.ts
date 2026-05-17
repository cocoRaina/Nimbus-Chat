import type {
  ChatMessage,
  ChatSession,
  CheckinEntry,
  Memory,
  SnackPost,
  SnackReply,
  SyzygyPost,
  SyzygyReply,
} from '../types'
import { supabase } from '../supabase/client'

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
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const MEMORY_SELECT_FIELDS = 'id,category,content,tags,created_at,updated_at'

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
  const { data, error } = await supabase
    .from('messages')
    .select('id,session_id,user_id,role,content,created_at,client_id,client_created_at,meta')
    .eq('user_id', userId)
    .order('client_created_at', { ascending: true })
    .order('created_at', { ascending: true })
  if (error) {
    throw error
  }
  return (data ?? []).map(mapMessageRow)
}

export const createRemoteSession = async (
  userId: string,
  title: string,
): Promise<ChatSession> => {
  if (!supabase) {
    throw new Error('Supabase 客户端未配置')
  }
  const now = new Date().toISOString()
  const { data, error } = await supabase
    .from('sessions')
    .insert({
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
  const { error: messagesError } = await supabase
    .from('messages')
    .delete()
    .eq('session_id', sessionId)
  if (messagesError) {
    throw messagesError
  }
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
  const { error } = await supabase.from('messages').delete().eq('id', messageId)
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
  const { error } = await supabase.rpc('restore_snack_post', { p_post_id: postId })

  if (error) {
    throw error
  }
}

export const softDeleteSnackPost = async (postId: string): Promise<void> => {
  if (!supabase) {
    throw new Error('Supabase 客户端未配置')
  }
  const { error } = await supabase.rpc('soft_delete_snack_post', { p_post_id: postId })

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
  const { error } = await supabase.rpc('soft_delete_snack_reply', { p_reply_id: replyId })

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
  const { error: repliesError } = await supabase.from('user_replies').delete().eq('post_id', postId)
  if (repliesError) {
    throw repliesError
  }

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
  const { error: repliesError } = await supabase.from('assistant_replies').delete().eq('post_id', postId)
  if (repliesError) {
    throw repliesError
  }

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

export const createMemory = async (input: {
  content: string
  category?: string
  tags?: string[]
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
  },
): Promise<Memory> => {
  if (!supabase) {
    throw new Error('Supabase 客户端未配置')
  }
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (typeof patch.content === 'string') updates.content = patch.content
  if (typeof patch.category === 'string') updates.category = patch.category.trim() || '日常'
  if (Array.isArray(patch.tags)) updates.tags = patch.tags
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
