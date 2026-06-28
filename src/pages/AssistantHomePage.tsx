import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent } from 'react'
import type { User } from '@supabase/supabase-js'
import { useNavigate } from 'react-router-dom'
import ConfirmDialog from '../components/ConfirmDialog'
import MarkdownRenderer from '../components/MarkdownRenderer'
import { fetchOpenRouter } from '../api/openrouter'
import { recordUsage } from '../storage/usageStats'
import type { SyzygyPost, SyzygyReply } from '../types'
import {
  createSyzygyPost,
  createSyzygyReply,
  fetchDeletedSyzygyPosts,
  fetchDeletedSyzygyReplies,
  fetchSyzygyPosts,
  fetchSyzygyReplies,
  fetchSyzygyRepliesByPost,
  restoreSyzygyPost,
  restoreSyzygyReply,
  softDeleteSyzygyPost,
  softDeleteSyzygyReply,
} from '../storage/supabaseSync'
import { supabase } from '../supabase/client'
import { withTimePrefix } from '../utils/time'
import {
  DEFAULT_SYZYGY_POST_PROMPT,
  DEFAULT_SYZYGY_REPLY_PROMPT,
  resolveSyzygyPostPrompt,
  resolveSyzygyReplyPrompt,
} from '../constants/aiOverlays'
import './MyHomePage.css'

type AssistantHomePageProps = {
  user: User | null
  snackAiConfig: {
    model: string
    reasoning: boolean
    temperature: number
    topP: number
    maxTokens: number
    systemPrompt: string
    snackSystemOverlay: string
    syzygyPostSystemPrompt: string
    syzygyReplySystemPrompt: string
  }
}

const maxLength = 1000
const createPendingReplyId = (postId: string) =>
  `pending-${postId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

const formatChineseTime = (timestamp: string) =>
  new Date(timestamp).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })


const isAuthExpiredError = (value: unknown) =>
  value instanceof Error && value.message.includes('登录状态异常')

const getReplyPreview = (reply: SyzygyReply | undefined) => {
  if (!reply) {
    return 'No replies yet'
  }
  return reply.content.length > 30 ? `${reply.content.slice(0, 30)}…` : reply.content
}

const AssistantHomePage = ({ user, snackAiConfig }: AssistantHomePageProps) => {
  const navigate = useNavigate()
  const [draft, setDraft] = useState('')
  const [posts, setPosts] = useState<SyzygyPost[]>([])
  const [repliesByPost, setRepliesByPost] = useState<Record<string, SyzygyReply[]>>({})
  const [expandedPostIds, setExpandedPostIds] = useState<Record<string, boolean>>({})
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [publishing, setPublishing] = useState(false)
  const [generatingPost, setGeneratingPost] = useState(false)
  const [submittingReplyPostId, setSubmittingReplyPostId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<SyzygyPost | null>(null)
  const [pendingDeleteReply, setPendingDeleteReply] = useState<SyzygyReply | null>(null)
  const [showTrash, setShowTrash] = useState(false)
  const [trashPosts, setTrashPosts] = useState<SyzygyPost[]>([])
  const [trashReplies, setTrashReplies] = useState<SyzygyReply[]>([])
  const [trashLoading, setTrashLoading] = useState(false)
  const [restoringPostId, setRestoringPostId] = useState<string | null>(null)
  const [restoringReplyId, setRestoringReplyId] = useState<string | null>(null)
  const [generatingPostId, setGeneratingPostId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [deletingPermanentPostId, setDeletingPermanentPostId] = useState<string | null>(null)
  const [deletingPermanentReplyId, setDeletingPermanentReplyId] = useState<string | null>(null)
  const replyInputRefs = useRef<Record<string, HTMLTextAreaElement | null>>({})

  const refreshPosts = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const list = await fetchSyzygyPosts()
      setPosts(list)
      const postIds = list.map((post) => post.id)
      const replies = await fetchSyzygyReplies(postIds)
      const nextReplies: Record<string, SyzygyReply[]> = {}
      replies.forEach((reply) => {
        if (!nextReplies[reply.postId]) {
          nextReplies[reply.postId] = []
        }
        nextReplies[reply.postId].push(reply)
      })
      setRepliesByPost(nextReplies)
    } catch (loadError) {
      console.warn('加载观察日志失败', loadError)
      setError('Load failed. Please try again.')
    } finally {
      setLoading(false)
    }
  }, [])

  const refreshTrashPosts = useCallback(async () => {
    setTrashLoading(true)
    setError(null)
    try {
      const [postList, replyList] = await Promise.all([fetchDeletedSyzygyPosts(), fetchDeletedSyzygyReplies()])
      setTrashPosts(postList)
      setTrashReplies(replyList)
    } catch (loadError) {
      console.warn('加载回收站失败', loadError)
      setError('Load failed. Please try again.')
    } finally {
      setTrashLoading(false)
    }
  }, [])

  useEffect(() => {
    void refreshPosts()
  }, [refreshPosts])

  useEffect(() => {
    if (showTrash) {
      void refreshTrashPosts()
    }
  }, [refreshTrashPosts, showTrash])

  useEffect(() => {
    // Only watch visibilitychange — `focus` fires for the same logical
    // transition on Android Capacitor (return-to-foreground) and used to
    // double-trigger a full feed refetch.
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      if (showTrash) {
        void refreshTrashPosts()
      } else {
        void refreshPosts()
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refreshPosts, refreshTrashPosts, showTrash])

  const trimmed = draft.trim()
  const draftTooLong = trimmed.length > maxLength
  const publishDisabled = !user || publishing || generatingPost || trimmed.length === 0 || draftTooLong
  const draftHint = useMemo(() => `${trimmed.length}/${maxLength}`, [trimmed.length])

  const handlePublish = async () => {
    if (!user || publishDisabled) {
      return
    }
    setPublishing(true)
    setError(null)
    setNotice(null)
    try {
      const created = await createSyzygyPost(trimmed, null)
      setPosts((current) => [created, ...current])
      setDraft('')
    } catch (publishError) {
      console.warn('发布观察日志失败', publishError)
      setError(isAuthExpiredError(publishError) ? 'Session expired. Please log in again.' : 'Failed to publish. Please try again.')
    } finally {
      setPublishing(false)
    }
  }

  const handleDelete = async () => {
    if (!pendingDelete || !user) {
      return
    }
    try {
      await softDeleteSyzygyPost(pendingDelete.id)
      setPosts((current) => current.filter((post) => post.id !== pendingDelete.id))
      setNotice('Moved to trash')
      setPendingDelete(null)
    } catch (deleteError) {
      console.warn('删除观察日志失败', deleteError)
      setError('Delete failed. Please try again.')
      setPendingDelete(null)
    }
  }

  const handleDeleteReply = async () => {
    if (!pendingDeleteReply) {
      return
    }
    try {
      await softDeleteSyzygyReply(pendingDeleteReply.id)
      setRepliesByPost((current) => ({
        ...current,
        [pendingDeleteReply.postId]: (current[pendingDeleteReply.postId] ?? []).filter(
          (reply) => reply.id !== pendingDeleteReply.id,
        ),
      }))
      setNotice('Moved to trash')
      setPendingDeleteReply(null)
    } catch (deleteError) {
      console.warn('删除观察日志回复失败', deleteError)
      setError('Failed to delete reply. Please try again.')
      setPendingDeleteReply(null)
    }
  }

  const handleRestore = async (postId: string) => {
    setRestoringPostId(postId)
    setError(null)
    try {
      await restoreSyzygyPost(postId)
      setTrashPosts((current) => current.filter((post) => post.id !== postId))
      await refreshPosts()
    } catch (restoreError) {
      console.warn('恢复观察日志失败', restoreError)
      setError('Restore failed. Please try again.')
    } finally {
      setRestoringPostId(null)
    }
  }

  const handleRestoreReply = async (reply: SyzygyReply) => {
    setRestoringReplyId(reply.id)
    setError(null)
    try {
      await restoreSyzygyReply(reply.id)
      setTrashReplies((current) => current.filter((item) => item.id !== reply.id))
      if (posts.some((post) => post.id === reply.postId)) {
        const refreshed = await fetchSyzygyRepliesByPost(reply.postId)
        setRepliesByPost((current) => ({
          ...current,
          [reply.postId]: refreshed,
        }))
      }
    } catch (restoreError) {
      console.warn('恢复观察日志回复失败', restoreError)
      setError('Failed to restore reply. Please try again.')
    } finally {
      setRestoringReplyId(null)
    }
  }

  const handlePermanentDeletePost = async (postId: string) => {
    if (!supabase || deletingPermanentPostId) {
      return
    }
    setDeletingPermanentPostId(postId)
    setError(null)
    setNotice(null)
    try {
      const { error: repliesError } = await supabase.from('assistant_replies').delete().eq('post_id', postId)
      if (repliesError) {
        throw repliesError
      }

      const { error: postError } = await supabase.from('assistant_posts').delete().eq('id', postId)
      if (postError) {
        throw postError
      }

      setNotice('Permanently deleted')
      await refreshTrashPosts()
    } catch (deleteError) {
      console.error(deleteError)
      setNotice('Permanent delete failed')
      setError('Permanent delete failed. Please try again.')
    } finally {
      setDeletingPermanentPostId(null)
    }
  }

  const handlePermanentDeleteReply = async (replyId: string) => {
    if (!supabase || deletingPermanentReplyId) {
      return
    }
    setDeletingPermanentReplyId(replyId)
    setError(null)
    setNotice(null)
    try {
      const { error } = await supabase.from('assistant_replies').delete().eq('id', replyId)
      if (error) {
        throw error
      }

      setNotice('Permanently deleted')
      await refreshTrashPosts()
    } catch (deleteError) {
      console.error(deleteError)
      setNotice('Permanent delete failed')
      setError('Permanent delete failed. Please try again.')
    } finally {
      setDeletingPermanentReplyId(null)
    }
  }

  const handlePermanentDeletePostClick = (e: MouseEvent<HTMLButtonElement>, postId: string) => {
    e.preventDefault()
    e.stopPropagation()
    console.log('[recycle] permanent delete clicked', { module: 'syzygy', kind: 'post', id: postId })
    const ok = window.confirm('Delete forever? This cannot be undone.')
    if (!ok) {
      return
    }
    void handlePermanentDeletePost(postId)
  }

  const handlePermanentDeleteReplyClick = (e: MouseEvent<HTMLButtonElement>, replyId: string) => {
    e.preventDefault()
    e.stopPropagation()
    console.log('[recycle] permanent delete clicked', { module: 'syzygy', kind: 'reply', id: replyId })
    const ok = window.confirm('Delete forever? This cannot be undone.')
    if (!ok) {
      return
    }
    void handlePermanentDeleteReply(replyId)
  }

  const toggleExpanded = (postId: string) => {
    setExpandedPostIds((current) => ({
      ...current,
      [postId]: !current[postId],
    }))
  }

  const expandAndFocusReply = (postId: string) => {
    setExpandedPostIds((current) => ({ ...current, [postId]: true }))
    setTimeout(() => {
      replyInputRefs.current[postId]?.focus()
    }, 0)
  }

  const handleReplyDraftChange = (postId: string, value: string) => {
    setReplyDrafts((current) => ({
      ...current,
      [postId]: value,
    }))
  }

  const handleSubmitReply = async (postId: string) => {
    const content = (replyDrafts[postId] ?? '').trim()
    if (!user || submittingReplyPostId || content.length === 0) {
      return
    }
    const pendingId = createPendingReplyId(postId)
    const pendingReply: SyzygyReply = {
      id: pendingId,
      postId,
      authorRole: 'user',
      content,
      createdAt: new Date().toISOString(),
      userId: user.id,
      isDeleted: false,
      modelId: null,
    }

    setSubmittingReplyPostId(postId)
    setError(null)
    setRepliesByPost((current) => ({
      ...current,
      [postId]: [...(current[postId] ?? []), pendingReply],
    }))
    setReplyDrafts((current) => ({ ...current, [postId]: '' }))

    try {
      const reply = await createSyzygyReply(postId, 'user', content, null)
      setRepliesByPost((current) => ({
        ...current,
        [postId]: (current[postId] ?? []).map((item) => (item.id === pendingId ? reply : item)),
      }))
    } catch (submitError) {
      console.warn('提交追问失败', submitError)
      setRepliesByPost((current) => ({
        ...current,
        [postId]: (current[postId] ?? []).filter((item) => item.id !== pendingId),
      }))
      setError(isAuthExpiredError(submitError) ? 'Session expired. Please log in again.' : 'Send failed. Please try again.')
    } finally {
      setSubmittingReplyPostId(null)
    }
  }


  const buildRequestBody = (messagesPayload: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>) => {
    const requestBody: Record<string, unknown> = {
      model: snackAiConfig.model,
      modelId: snackAiConfig.model,
      module: 'syzygy-feed',
      messages: messagesPayload,
      temperature: snackAiConfig.temperature,
      top_p: snackAiConfig.topP,
      max_tokens: snackAiConfig.maxTokens,
      stream: false,
    }

    if (snackAiConfig.reasoning && /claude|anthropic/i.test(snackAiConfig.model)) {
      requestBody.thinking = {
        type: 'enabled',
        budget_tokens: Math.max(256, Math.min(1024, snackAiConfig.maxTokens)),
      }
    }

    return requestBody
  }

  const requestOpenRouter = async (messagesPayload: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>) => {
    if (!supabase) {
      throw new Error('Supabase 客户端未配置')
    }
    const response = await fetchOpenRouter('/chat/completions', {
      body: buildRequestBody(messagesPayload),
    })

    if (!response.ok) {
      throw new Error(await response.text())
    }

    const payload = (await response.json()) as Record<string, unknown>
    const choice = (payload?.choices as unknown[] | undefined)?.[0] as
      | Record<string, unknown>
      | undefined
    const message = ((choice?.message as Record<string, unknown>) ?? choice ?? {}) as Record<string, unknown>
    const rawContent =
      typeof message.content === 'string'
        ? message.content
        : typeof choice?.text === 'string'
          ? choice.text
          : ''
    // Some models (especially the *-thinking variants) emit a literal
    // <thinking>…</thinking> block as TEXT even when extended thinking is
    // off. The chat path strips it via splitReasoningFromContent; the feed
    // path didn't, so the tags leaked into the published post. Strip here.
    const content = rawContent
      .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
      .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
      .trim()

    const reasoningCandidates = [
      message.reasoning,
      message.thinking,
      message.reasoning_content,
      message.thinking_content,
      choice?.reasoning,
      choice?.thinking,
      payload.reasoning,
      payload.thinking,
    ]
    const reasoningText = reasoningCandidates
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .join('')

    const resolvedModel = typeof payload.model === 'string' ? payload.model : snackAiConfig.model
    const usage = payload.usage as
      | {
          prompt_tokens?: number
          completion_tokens?: number
          total_tokens?: number
          prompt_tokens_details?: { cached_tokens?: number }
          cache_read_input_tokens?: number
        }
      | undefined
    if (user && usage) {
      void recordUsage({
        userId: user.id,
        model: resolvedModel,
        promptTokens: Number(usage.prompt_tokens ?? 0),
        completionTokens: Number(usage.completion_tokens ?? 0),
        totalTokens: Number(usage.total_tokens ?? 0),
        cachedTokens: Number(
          usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens ?? 0,
        ),
        source: 'syzygy',
      })
    }

    return {
      content: content || '(empty reply)',
      reasoningText: reasoningText || undefined,
      model: resolvedModel,
    }
  }

  const handleGeneratePost = async () => {
    if (!user || !supabase || generatingPost || publishing) {
      return
    }
    setGeneratingPost(true)
    setError(null)
    try {
      const basePrompt = snackAiConfig.systemPrompt.trim()
      const syzygyPostPrompt = resolveSyzygyPostPrompt(snackAiConfig.syzygyPostSystemPrompt)
      const now = new Date().toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
      const messagesPayload: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = []
      if (basePrompt) {
        messagesPayload.push({ role: 'system', content: basePrompt })
      }
      messagesPayload.push({ role: 'system', content: syzygyPostPrompt || DEFAULT_SYZYGY_POST_PROMPT })
      messagesPayload.push({ role: 'user', content: `本地时间：${now}\nWrite a short post.` })

      const result = await requestOpenRouter(messagesPayload)
      const created = await createSyzygyPost(result.content, snackAiConfig.model)
      setPosts((current) => [created, ...current])
    } catch (generateError) {
      console.warn('生成观察日志失败', generateError)
      setError(isAuthExpiredError(generateError) ? 'Session expired. Please log in again.' : 'Generation failed. Please try again.')
    } finally {
      setGeneratingPost(false)
    }
  }

  const handleGenerateReply = async (post: SyzygyPost) => {
    if (!user || !supabase || generatingPostId) {
      return
    }
    setExpandedPostIds((current) => ({ ...current, [post.id]: true }))
    setGeneratingPostId(post.id)
    setError(null)
    const pendingAssistantId = createPendingReplyId(post.id)
    const pendingAssistantReply: SyzygyReply = {
      id: pendingAssistantId,
      postId: post.id,
      authorRole: 'ai',
      content: 'Generating…',
      createdAt: new Date().toISOString(),
      userId: user.id,
      isDeleted: false,
      modelId: snackAiConfig.model,
    }
    setRepliesByPost((current) => ({
      ...current,
      [post.id]: [...(current[post.id] ?? []), pendingAssistantReply],
    }))

    try {
      const messagesPayload = [] as Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
      const basePrompt = snackAiConfig.systemPrompt.trim()
      if (basePrompt) {
        messagesPayload.push({ role: 'system', content: basePrompt })
      }
      const syzygyReplyPrompt = resolveSyzygyReplyPrompt(snackAiConfig.syzygyReplySystemPrompt)
      messagesPayload.push({ role: 'system', content: syzygyReplyPrompt || DEFAULT_SYZYGY_REPLY_PROMPT })
      messagesPayload.push({
        role: 'user',
        content: `原帖：${withTimePrefix(post.content, post.createdAt)}`,
      })

      const existingReplies = (repliesByPost[post.id] ?? []).filter(
        (reply) => reply.content && reply.content !== 'Generating…',
      )
      const lastReplies = existingReplies.slice(-6)
      if (lastReplies.length > 0) {
        messagesPayload.push({
          role: 'user',
          content: `最近回复：\n${lastReplies
            .map((reply) => `${reply.authorRole === 'ai' ? 'TA' : '我'}：${reply.content}`)
            .join('\n')}`,
        })
      }
      const latestUserComment = [...existingReplies].reverse().find((reply) => reply.authorRole === 'user')
      if (latestUserComment) {
        messagesPayload.push({ role: 'user', content: `我的最新留言：${latestUserComment.content}` })
      }

      const result = await requestOpenRouter(messagesPayload)

      setRepliesByPost((current) => ({
        ...current,
        [post.id]: (current[post.id] ?? []).map((item) =>
          item.id === pendingAssistantId ? { ...item, content: result.content } : item,
        ),
      }))

      await createSyzygyReply(post.id, 'ai', result.content, result.model)
      const latestReplies = await fetchSyzygyRepliesByPost(post.id)
      setRepliesByPost((current) => ({
        ...current,
        [post.id]: latestReplies,
      }))
    } catch (generateError) {
      console.warn('生成观察日志回复失败', generateError)
      setRepliesByPost((current) => ({
        ...current,
        [post.id]: (current[post.id] ?? []).filter((item) => item.id !== pendingAssistantId),
      }))
      setError(isAuthExpiredError(generateError) ? 'Session expired. Please log in again.' : 'Generation failed. Please try again.')
    } finally {
      setGeneratingPostId(null)
    }
  }

  if (!user) {
    return null
  }

  return (
    <div className="my-home-page app-shell__content">
      <header className="my-home-header">
        <button type="button" className="page-back-btn" onClick={() => navigate('/')}>‹</button>
        <h1 className="ui-title">{showTrash ? 'Claude Trash' : 'Claude'}</h1>
        <button
          type="button"
          className="ghost compact-action"
          onClick={() => {
            setShowTrash((current) => !current)
            setNotice(null)
          }}
        >
          {showTrash ? 'Back' : 'Trash'}
        </button>
      </header>

      {error ? <p className="error">{error}</p> : null}
      {notice ? <p className="tips">{notice}</p> : null}

      {showTrash ? (
        <main className="home-feed">
          {trashLoading ? <p className="tips">Loading trash…</p> : null}
          {!trashLoading && trashPosts.length === 0 && trashReplies.length === 0 ? (
            <p className="tips">Trash is empty.</p>
          ) : null}
          {trashPosts.map((post) => (
            <article key={post.id} className="post-card">
              <div className="post-header">
                <span className="feed-badge">Posts</span>
              </div>
              {post.modelId ? (
                <div className="post-content assistant-markdown">
                  <MarkdownRenderer content={post.content} />
                </div>
              ) : (
                <p className="post-content">{post.content}</p>
              )}
              <div className="post-footer">
                <span>{formatChineseTime(post.updatedAt || post.createdAt)}</span>
                <div className="post-actions">
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => void handleRestore(post.id)}
                    disabled={restoringPostId === post.id}
                  >
                    {restoringPostId === post.id ? 'Restoring…' : 'Restore'}
                  </button>
                  <button
                    type="button"
                    className="ghost danger"
                    onClick={(e) => handlePermanentDeletePostClick(e, post.id)}
                    disabled={deletingPermanentPostId === post.id}
                  >
                    {deletingPermanentPostId === post.id ? 'Deleting…' : 'Delete Forever'}
                  </button>
                </div>
              </div>
            </article>
          ))}
          {trashReplies.map((reply) => (
            <article key={reply.id} className="post-card">
              <div className="post-header">
                <span className="feed-badge">Deleted Reply</span>
              </div>
              {reply.authorRole === 'ai' ? (
                <div className="post-content assistant-markdown">
                  <MarkdownRenderer content={reply.content} />
                </div>
              ) : (
                <p className="post-content">{reply.content}</p>
              )}
              <div className="post-footer">
                <span>{formatChineseTime(reply.createdAt)}</span>
                <div className="post-actions">
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => void handleRestoreReply(reply)}
                    disabled={restoringReplyId === reply.id}
                  >
                    {restoringReplyId === reply.id ? 'Restoring…' : 'Restore'}
                  </button>
                  <button
                    type="button"
                    className="ghost danger"
                    onClick={(e) => handlePermanentDeleteReplyClick(e, reply.id)}
                    disabled={deletingPermanentReplyId === reply.id}
                  >
                    {deletingPermanentReplyId === reply.id ? 'Deleting…' : 'Delete Forever'}
                  </button>
                </div>
              </div>
            </article>
          ))}
        </main>
      ) : (
        <>
          <section className="profile-header-card" aria-label="TA主页头部">
            <div className="profile-cover-banner" />
            <div className="profile-meta">
              <h2 className="profile-title">Claude</h2>
              <p className="profile-bio">Claude's daily observations</p>
            </div>
          </section>

          <section className="my-home-composer">
            <textarea
              rows={2}
              placeholder="What's on your mind…"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              maxLength={maxLength + 10}
            />
            <div className="composer-footer">
              <span className={draftTooLong ? 'danger' : ''}>{draftHint}</span>
              <div className="post-actions">
                <button
                  type="button"
                  className="ghost"
                  onClick={() => void handleGeneratePost()}
                  disabled={generatingPost || publishing}
                  title="✦ Generate"
                >
                  {generatingPost ? '▶️ Generating…' : '▶️'}
                </button>
                <button type="button" className="primary" onClick={handlePublish} disabled={publishDisabled}>
                  {publishing ? 'Publishing…' : 'Post'}
                </button>
              </div>
            </div>
            {draftTooLong ? <p className="error">Content cannot exceed 1000 characters.</p> : null}
          </section>

          <main className="home-feed">
            {loading ? <p className="tips">Loading…</p> : null}
            {!loading && posts.length === 0 ? <p className="tips">No posts yet — publish the first one.</p> : null}
            {posts.map((post) => {
              const replies = repliesByPost[post.id] ?? []
              const isExpanded = expandedPostIds[post.id] ?? false
              const latestReply = replies.at(-1)
              const replyDraft = replyDrafts[post.id] ?? ''
              return (
                <article key={post.id} className="post-card">
                  <div className="post-header">
                    <span className="feed-badge">Posts</span>
                  </div>
                  {post.modelId ? (
                    <div className="post-content assistant-markdown">
                      <MarkdownRenderer content={post.content} />
                    </div>
                  ) : (
                    <p className="post-content">{post.content}</p>
                  )}
                  <div className="post-footer">
                    <span>{formatChineseTime(post.createdAt)}</span>
                    <div className="post-actions">
                      <button type="button" className="ghost danger" onClick={() => setPendingDelete(post)}>
                        Delete
                      </button>
                    </div>
                  </div>

                  <div className="reply-collapsed-row">
                    <button
                      type="button"
                      className="reply-toggle"
                      onClick={() => toggleExpanded(post.id)}
                      aria-expanded={isExpanded}
                    >
                      <span className="reply-toggle-main">Replies ({replies.length})</span>
                      <span className="reply-preview">{getReplyPreview(latestReply)}</span>
                      <span className="reply-chevron">{isExpanded ? '▾' : '▸'}</span>
                    </button>
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => void handleGenerateReply(post)}
                      disabled={generatingPostId !== null}
                      title="Generate AI reply"
                    >
                      ▶️
                    </button>
                    <button type="button" className="ghost" onClick={() => expandAndFocusReply(post.id)}>
                      Reply
                    </button>
                  </div>

                  {isExpanded ? (
                    <div className="reply-list">
                      {replies.map((reply) => (
                        <div key={reply.id} className={`reply-bubble ${reply.authorRole === 'ai' ? 'assistant' : 'user'}`}>
                          <div className="reply-content-wrap">
                            <div className="reply-role">
                              {reply.authorRole === 'ai' ? (
                                <>
                                  <span>Claude</span>
                                  <span className="reply-model-badge">{reply.modelId || 'unknown model'}</span>
                                </>
                              ) : (
                                <span>kitten</span>
                              )}
                            </div>
                            {reply.authorRole === 'ai' ? (
                              <div className="assistant-markdown">
                                <MarkdownRenderer content={reply.content} />
                              </div>
                            ) : (
                              <p>{reply.content}</p>
                            )}
                            <span className="reply-time">{formatChineseTime(reply.createdAt)}</span>
                          </div>
                          <button type="button" className="ghost danger" onClick={() => setPendingDeleteReply(reply)}>
                            Delete
                          </button>
                        </div>
                      ))}
                      {/* The pending placeholder is already pushed into `replies`
                          as a synthetic row with content "Generating…", so rendering
                          it again here would double-stack the bubble. */}

                      <div className="reply-composer">
                        <textarea
                          ref={(node) => {
                            replyInputRefs.current[post.id] = node
                          }}
                          rows={2}
                          placeholder="Write a reply…"
                          value={replyDraft}
                          onChange={(event) => handleReplyDraftChange(post.id, event.target.value)}
                        />
                        <button
                          type="button"
                          className="primary"
                          onClick={() => void handleSubmitReply(post.id)}
                          disabled={submittingReplyPostId === post.id || replyDraft.trim().length === 0}
                        >
                          {submittingReplyPostId === post.id ? 'Sending…' : 'Send'}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </article>
              )
            })}
          </main>

          <ConfirmDialog
            open={pendingDelete !== null}
            title="Delete this post?"
            confirmLabel="Delete"
            cancelLabel="Cancel"
            onCancel={() => setPendingDelete(null)}
            onConfirm={handleDelete}
          />
          <ConfirmDialog
            open={pendingDeleteReply !== null}
            title="Delete this reply?"
            confirmLabel="Delete"
            cancelLabel="Cancel"
            onCancel={() => setPendingDeleteReply(null)}
            onConfirm={handleDeleteReply}
          />
        </>
      )}
    </div>
  )
}

export default AssistantHomePage
