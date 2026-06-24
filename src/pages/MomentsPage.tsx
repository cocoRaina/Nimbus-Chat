import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { User } from '@supabase/supabase-js'
import { useNavigate } from 'react-router-dom'
import MarkdownRenderer from '../components/MarkdownRenderer'
import LocalAvatar from '../components/LocalAvatar'
import { fetchOpenRouter } from '../api/openrouter'
import { recordUsage } from '../storage/usageStats'
import type { SnackPost, SnackReply, SyzygyPost, SyzygyReply } from '../types'
import {
  createSnackPost,
  createSnackReply,
  createSyzygyPost,
  createSyzygyReply,
  fetchSnackPosts,
  fetchSnackReplies,
  fetchSyzygyPosts,
  fetchSyzygyReplies,
  softDeleteSnackPost,
  softDeleteSyzygyPost,
} from '../storage/supabaseSync'
import { supabase } from '../supabase/client'
import { withTimePrefix } from '../utils/time'
import {
  DEFAULT_SYZYGY_POST_PROMPT,
  DEFAULT_SYZYGY_REPLY_PROMPT,
  resolveSyzygyPostPrompt,
  resolveSyzygyReplyPrompt,
} from '../constants/aiOverlays'
import './MomentsPage.css'

type AiConfig = {
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

type MomentsPageProps = {
  user: User | null
  snackAiConfig: AiConfig
  syzygyAiConfig: AiConfig
}

type FeedEntry =
  | { kind: 'user'; post: SnackPost }
  | { kind: 'ai'; post: SyzygyPost }

const MAX_CHARS = 1000

const formatTime = (iso: string) =>
  new Date(iso).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })

const createPendingId = () =>
  `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

const MomentsPage = ({ user, snackAiConfig, syzygyAiConfig }: MomentsPageProps) => {
  const navigate = useNavigate()

  const [userPosts, setUserPosts] = useState<SnackPost[]>([])
  const [aiPosts, setAiPosts] = useState<SyzygyPost[]>([])
  const [userReplies, setUserReplies] = useState<Record<string, SnackReply[]>>({})
  const [aiReplies, setAiReplies] = useState<Record<string, SyzygyReply[]>>({})
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({})
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({})

  const [draft, setDraft] = useState('')
  const [publishing, setPublishing] = useState(false)
  const [generatingPost, setGeneratingPost] = useState(false)
  const [submittingReplyFor, setSubmittingReplyFor] = useState<string | null>(null)
  const [generatingReplyFor, setGeneratingReplyFor] = useState<string | null>(null)

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const replyInputRefs = useRef<Record<string, HTMLTextAreaElement | null>>({})

  // ── Data loading ─────────────────────────────────────────────────

  const loadFeed = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [uPosts, aPosts] = await Promise.all([fetchSnackPosts(), fetchSyzygyPosts()])
      setUserPosts(uPosts)
      setAiPosts(aPosts)

      const uIds = uPosts.map((p) => p.id)
      const aIds = aPosts.map((p) => p.id)
      const [uRepliesFlat, aRepliesFlat] = await Promise.all([
        uIds.length ? fetchSnackReplies(uIds) : Promise.resolve([]),
        aIds.length ? fetchSyzygyReplies(aIds) : Promise.resolve([]),
      ])

      const uMap: Record<string, SnackReply[]> = {}
      for (const r of uRepliesFlat) {
        if (!uMap[r.postId]) uMap[r.postId] = []
        uMap[r.postId].push(r)
      }
      const aMap: Record<string, SyzygyReply[]> = {}
      for (const r of aRepliesFlat) {
        if (!aMap[r.postId]) aMap[r.postId] = []
        aMap[r.postId].push(r)
      }
      setUserReplies(uMap)
      setAiReplies(aMap)
    } catch (err) {
      console.warn('加载 Moments 失败', err)
      setError('加载失败，请稍后重试')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadFeed()
  }, [loadFeed])

  // ── Combined sorted feed ─────────────────────────────────────────

  const feed = useMemo<FeedEntry[]>(() => {
    const u: FeedEntry[] = userPosts.map((post) => ({ kind: 'user', post }))
    const a: FeedEntry[] = aiPosts.map((post) => ({ kind: 'ai', post }))
    return [...u, ...a].sort(
      (x, y) =>
        new Date(y.post.createdAt).getTime() - new Date(x.post.createdAt).getTime(),
    )
  }, [userPosts, aiPosts])

  // ── AI request helper ─────────────────────────────────────────────

  const callAI = useCallback(
    async (
      cfg: AiConfig,
      messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
      source: 'syzygy' | 'snacks',
    ) => {
      if (!supabase) throw new Error('Supabase 未配置')
      const body: Record<string, unknown> = {
        model: cfg.model,
        modelId: cfg.model,
        module: 'moments-feed',
        messages,
        temperature: cfg.temperature,
        top_p: cfg.topP,
        max_tokens: cfg.maxTokens,
        stream: false,
      }
      const resp = await fetchOpenRouter('/chat/completions', { body })
      if (!resp.ok) throw new Error(await resp.text())
      const payload = (await resp.json()) as Record<string, unknown>
      const choice = ((payload.choices as unknown[])?.[0] ?? {}) as Record<string, unknown>
      const msg = (choice.message ?? choice ?? {}) as Record<string, unknown>
      const raw =
        typeof msg.content === 'string'
          ? msg.content
          : typeof choice.text === 'string'
            ? choice.text
            : ''
      const content = raw
        .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
        .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
        .trim()
      const resolvedModel =
        typeof payload.model === 'string' ? payload.model : cfg.model
      const usage = payload.usage as
        | { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cache_read_input_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }
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
          source,
        })
      }
      return { content: content || '（空回复）', model: resolvedModel }
    },
    [user],
  )

  // ── Posting ───────────────────────────────────────────────────────

  const handleUserPost = async () => {
    const text = draft.trim()
    if (!text || !user || publishing) return
    setPublishing(true)
    setError(null)
    try {
      const created = await createSnackPost(text)
      setUserPosts((prev) => [created, ...prev])
      setDraft('')
    } catch (err) {
      console.warn('发布失败', err)
      setError('发布失败，请重试')
    } finally {
      setPublishing(false)
    }
  }

  const handleClaudePost = async () => {
    if (!user || generatingPost || publishing) return
    setGeneratingPost(true)
    setError(null)
    try {
      const cfg = syzygyAiConfig
      const now = new Date().toLocaleString('zh-CN', {
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      })
      const basePrompt = cfg.systemPrompt.trim()
      const postPrompt = resolveSyzygyPostPrompt(cfg.syzygyPostSystemPrompt)
      const msgs: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = []
      if (basePrompt) msgs.push({ role: 'system', content: basePrompt })
      msgs.push({ role: 'system', content: postPrompt || DEFAULT_SYZYGY_POST_PROMPT })
      msgs.push({ role: 'user', content: `本地时间：${now}\nWrite a short post.` })
      const result = await callAI(cfg, msgs, 'syzygy')
      const created = await createSyzygyPost(result.content, result.model)
      setAiPosts((prev) => [created, ...prev])
    } catch (err) {
      console.warn('Claude 发帖失败', err)
      setError('Claude 发帖失败，请重试')
    } finally {
      setGeneratingPost(false)
    }
  }

  // ── Replying ──────────────────────────────────────────────────────

  const handleUserReply = async (entry: FeedEntry) => {
    const postId = entry.post.id
    const text = (replyDrafts[postId] ?? '').trim()
    if (!text || !user || submittingReplyFor) return
    setSubmittingReplyFor(postId)
    const pendingId = createPendingId()
    setExpandedIds((prev) => ({ ...prev, [postId]: true }))
    try {
      if (entry.kind === 'user') {
        const pending: SnackReply = {
          id: pendingId, postId, role: 'user', content: text,
          createdAt: new Date().toISOString(), userId: user.id, isDeleted: false,
        }
        setUserReplies((prev) => ({ ...prev, [postId]: [...(prev[postId] ?? []), pending] }))
        const saved = await createSnackReply(postId, 'user', text, {})
        setUserReplies((prev) => ({
          ...prev,
          [postId]: (prev[postId] ?? []).map((r) => (r.id === pendingId ? saved : r)),
        }))
      } else {
        const pending: SyzygyReply = {
          id: pendingId, postId, authorRole: 'user', content: text,
          createdAt: new Date().toISOString(), userId: user.id, isDeleted: false,
        }
        setAiReplies((prev) => ({ ...prev, [postId]: [...(prev[postId] ?? []), pending] }))
        const saved = await createSyzygyReply(postId, 'user', text, null)
        setAiReplies((prev) => ({
          ...prev,
          [postId]: (prev[postId] ?? []).map((r) => (r.id === pendingId ? saved : r)),
        }))
      }
      setReplyDrafts((prev) => ({ ...prev, [postId]: '' }))
    } catch (err) {
      console.warn('回复失败', err)
      setError('回复失败，请重试')
      if (entry.kind === 'user') {
        setUserReplies((prev) => ({
          ...prev, [postId]: (prev[postId] ?? []).filter((r) => r.id !== pendingId),
        }))
      } else {
        setAiReplies((prev) => ({
          ...prev, [postId]: (prev[postId] ?? []).filter((r) => r.id !== pendingId),
        }))
      }
    } finally {
      setSubmittingReplyFor(null)
    }
  }

  const handleClaudeReply = async (entry: FeedEntry) => {
    const postId = entry.post.id
    if (!user || generatingReplyFor) return
    setGeneratingReplyFor(postId)
    setExpandedIds((prev) => ({ ...prev, [postId]: true }))
    const pendingId = createPendingId()
    const cfg = entry.kind === 'user' ? snackAiConfig : syzygyAiConfig

    if (entry.kind === 'user') {
      const pending: SnackReply = {
        id: pendingId, postId, role: 'assistant', content: '生成中…',
        createdAt: new Date().toISOString(), userId: user.id, isDeleted: false,
      }
      setUserReplies((prev) => ({ ...prev, [postId]: [...(prev[postId] ?? []), pending] }))
    } else {
      const pending: SyzygyReply = {
        id: pendingId, postId, authorRole: 'ai', content: '生成中…',
        createdAt: new Date().toISOString(), userId: user.id, isDeleted: false,
        modelId: cfg.model,
      }
      setAiReplies((prev) => ({ ...prev, [postId]: [...(prev[postId] ?? []), pending] }))
    }

    try {
      const basePrompt = cfg.systemPrompt.trim()
      const replyPrompt = resolveSyzygyReplyPrompt(cfg.syzygyReplySystemPrompt)
      const msgs: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = []
      if (basePrompt) msgs.push({ role: 'system', content: basePrompt })
      msgs.push({ role: 'system', content: replyPrompt || DEFAULT_SYZYGY_REPLY_PROMPT })
      msgs.push({ role: 'user', content: `原帖：${withTimePrefix(entry.post.content, entry.post.createdAt)}` })

      const existingReplies =
        entry.kind === 'user'
          ? (userReplies[postId] ?? []).filter((r) => r.content !== '生成中…')
          : (aiReplies[postId] ?? []).filter((r) => r.content !== '生成中…')

      if (existingReplies.length > 0) {
        const last6 = existingReplies.slice(-6)
        if (entry.kind === 'user') {
          msgs.push({
            role: 'user',
            content: `最近回复：\n${(last6 as SnackReply[])
              .map((r) => `${r.role === 'assistant' ? 'TA' : '我'}：${r.content}`)
              .join('\n')}`,
          })
        } else {
          msgs.push({
            role: 'user',
            content: `最近回复：\n${(last6 as SyzygyReply[])
              .map((r) => `${r.authorRole === 'ai' ? 'TA' : '我'}：${r.content}`)
              .join('\n')}`,
          })
        }
      }

      const result = await callAI(cfg, msgs, 'syzygy')

      if (entry.kind === 'user') {
        const saved = await createSnackReply(postId, 'assistant', result.content, { model: result.model })
        setUserReplies((prev) => ({
          ...prev,
          [postId]: (prev[postId] ?? []).map((r) => (r.id === pendingId ? saved : r)),
        }))
      } else {
        const saved = await createSyzygyReply(postId, 'ai', result.content, result.model)
        setAiReplies((prev) => ({
          ...prev,
          [postId]: (prev[postId] ?? []).map((r) => (r.id === pendingId ? saved : r)),
        }))
      }
    } catch (err) {
      console.warn('Claude 回复失败', err)
      setError('Claude 回复失败，请重试')
      if (entry.kind === 'user') {
        setUserReplies((prev) => ({
          ...prev, [postId]: (prev[postId] ?? []).filter((r) => r.id !== pendingId),
        }))
      } else {
        setAiReplies((prev) => ({
          ...prev, [postId]: (prev[postId] ?? []).filter((r) => r.id !== pendingId),
        }))
      }
    } finally {
      setGeneratingReplyFor(null)
    }
  }

  const handleDelete = async (entry: FeedEntry) => {
    const postId = entry.post.id
    try {
      if (entry.kind === 'user') {
        await softDeleteSnackPost(postId)
        setUserPosts((prev) => prev.filter((p) => p.id !== postId))
        setUserReplies((prev) => { const next = { ...prev }; delete next[postId]; return next })
      } else {
        await softDeleteSyzygyPost(postId)
        setAiPosts((prev) => prev.filter((p) => p.id !== postId))
        setAiReplies((prev) => { const next = { ...prev }; delete next[postId]; return next })
      }
    } catch (err) {
      console.warn('删除失败', err)
      setError('删除失败，请重试')
    }
  }

  // ── Render helpers ────────────────────────────────────────────────

  const getReplies = (entry: FeedEntry) =>
    entry.kind === 'user'
      ? (userReplies[entry.post.id] ?? [])
      : (aiReplies[entry.post.id] ?? [])

  const getReplyAuthorLabel = (entry: FeedEntry, reply: SnackReply | SyzygyReply) => {
    if (entry.kind === 'user') {
      return (reply as SnackReply).role === 'assistant' ? 'Claude' : 'kitten'
    }
    return (reply as SyzygyReply).authorRole === 'ai' ? 'Claude' : 'kitten'
  }

  const isReplyFromAI = (entry: FeedEntry, reply: SnackReply | SyzygyReply) => {
    if (entry.kind === 'user') return (reply as SnackReply).role === 'assistant'
    return (reply as SyzygyReply).authorRole === 'ai'
  }

  // ── JSX ──────────────────────────────────────────────────────────

  return (
    <div className="moments-page">
      <header className="moments-header">
        <button type="button" className="moments-back" onClick={() => navigate(-1)}>
          ‹
        </button>
        <h1 className="moments-title">Moments</h1>
        <LocalAvatar storageKey="my-homepage-avatar" alt="kitten's avatar" />
      </header>

      {/* Composer */}
      <div className="moments-composer glass-card">
        <textarea
          className="moments-draft"
          placeholder="Share something…"
          value={draft}
          maxLength={MAX_CHARS}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void handleUserPost()
          }}
        />
        <div className="moments-composer-actions">
          <span className="moments-char-count">
            {draft.length > 0 ? `${draft.length}/${MAX_CHARS}` : ''}
          </span>
          <button
            type="button"
            className="moments-btn-ai"
            onClick={() => void handleClaudePost()}
            disabled={generatingPost || publishing}
            title="Let Claude write a post"
          >
            {generatingPost ? '…' : '✦ Claude'}
          </button>
          <button
            type="button"
            className="moments-btn-post"
            onClick={() => void handleUserPost()}
            disabled={!draft.trim() || publishing || generatingPost}
          >
            {publishing ? '…' : 'Post'}
          </button>
        </div>
      </div>

      {error ? (
        <p className="moments-error">{error}</p>
      ) : null}

      {/* Feed */}
      {loading ? (
        <p className="moments-loading">Loading…</p>
      ) : feed.length === 0 ? (
        <p className="moments-empty">Nothing yet — post something or let Claude share first.</p>
      ) : (
        <ul className="moments-feed">
          {feed.map((entry) => {
            const postId = entry.post.id
            const replies = getReplies(entry)
            const expanded = expandedIds[postId] ?? false
            const replyCount = replies.length
            const replyDraft = replyDrafts[postId] ?? ''

            return (
              <li key={postId} className="moments-card glass-card">
                {/* Post header */}
                <div className="moments-card-header">
                  <span className={`moments-author-badge ${entry.kind === 'ai' ? 'moments-author-badge--ai' : 'moments-author-badge--user'}`}>
                    {entry.kind === 'ai' ? 'Claude' : 'kitten'}
                  </span>
                  <span className="moments-card-time">{formatTime(entry.post.createdAt)}</span>
                  <button
                    type="button"
                    className="moments-card-delete"
                    onClick={() => void handleDelete(entry)}
                    aria-label="删除"
                  >
                    ×
                  </button>
                </div>

                {/* Content */}
                <div className="moments-card-body">
                  {entry.kind === 'ai' ? (
                    <MarkdownRenderer content={entry.post.content} />
                  ) : (
                    <p className="moments-card-text">{entry.post.content}</p>
                  )}
                </div>

                {/* Replies toggle */}
                <div className="moments-card-footer">
                  <button
                    type="button"
                    className="moments-reply-toggle"
                    onClick={() => setExpandedIds((prev) => ({ ...prev, [postId]: !expanded }))}
                  >
                    {replyCount > 0
                      ? `${expanded ? '收起' : '展开'} ${replyCount} 条回复`
                      : expanded ? '收起' : '回复'}
                  </button>
                  <button
                    type="button"
                    className="moments-btn-ai moments-btn-ai--sm"
                    onClick={() => void handleClaudeReply(entry)}
                    disabled={!!generatingReplyFor}
                    title="Let Claude reply"
                  >
                    {generatingReplyFor === postId ? '…' : '✦ Claude'}
                  </button>
                </div>

                {/* Replies section */}
                {expanded ? (
                  <div className="moments-replies">
                    {replies.map((reply) => {
                      const isAI = isReplyFromAI(entry, reply)
                      return (
                        <div
                          key={reply.id}
                          className={`moments-reply ${isAI ? 'moments-reply--ai' : 'moments-reply--user'}`}
                        >
                          <span className="moments-reply-author">
                            {getReplyAuthorLabel(entry, reply)}
                          </span>
                          {isAI ? (
                            <MarkdownRenderer content={reply.content} />
                          ) : (
                            <p className="moments-reply-text">{reply.content}</p>
                          )}
                          <span className="moments-reply-time">{formatTime(reply.createdAt)}</span>
                        </div>
                      )
                    })}

                    {/* Reply composer */}
                    <div className="moments-reply-composer">
                      <textarea
                        ref={(el) => { replyInputRefs.current[postId] = el }}
                        className="moments-reply-input"
                        placeholder="Write a reply…"
                        value={replyDraft}
                        rows={2}
                        onChange={(e) =>
                          setReplyDrafts((prev) => ({ ...prev, [postId]: e.target.value }))
                        }
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey))
                            void handleUserReply(entry)
                        }}
                      />
                      <button
                        type="button"
                        className="moments-btn-post moments-btn-post--sm"
                        onClick={() => void handleUserReply(entry)}
                        disabled={!replyDraft.trim() || !!submittingReplyFor}
                      >
                        {submittingReplyFor === postId ? '…' : 'Reply'}
                      </button>
                    </div>
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

export default MomentsPage
