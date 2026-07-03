import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { User } from '@supabase/supabase-js'
import { useNavigate } from 'react-router-dom'
import MarkdownRenderer from '../components/MarkdownRenderer'
import ConfirmDialog from '../components/ConfirmDialog'
import { fetchOpenRouter } from '../api/openrouter'
import { recordUsage } from '../storage/usageStats'
import type { SnackPost, SnackReply, SyzygyPost, SyzygyReply } from '../types'
import {
  createSnackPost,
  createSnackReply,
  createSyzygyPost,
  createSyzygyReply,
  fetchDeletedSnackPosts,
  fetchDeletedSyzygyPosts,
  fetchSnackPosts,
  fetchSnackReplies,
  fetchSnackRepliesByPost,
  fetchSyzygyPosts,
  fetchSyzygyReplies,
  fetchSyzygyRepliesByPost,
  permanentlyDeleteSnackPost,
  permanentlyDeleteSyzygyPost,
  restoreSnackPost,
  restoreSyzygyPost,
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

  // 删除走两步：先弹确认（防误触），确认后软删除进回收站，可恢复。
  const [pendingDelete, setPendingDelete] = useState<FeedEntry | null>(null)
  const [pendingPurge, setPendingPurge] = useState<FeedEntry | null>(null)
  const [showTrash, setShowTrash] = useState(false)
  const [trashEntries, setTrashEntries] = useState<FeedEntry[]>([])
  const [trashLoading, setTrashLoading] = useState(false)
  const [busyTrashId, setBusyTrashId] = useState<string | null>(null)

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

  // ── Trash (回收站) ────────────────────────────────────────────────

  const loadTrash = useCallback(async () => {
    setTrashLoading(true)
    setError(null)
    try {
      const [uPosts, aPosts] = await Promise.all([
        fetchDeletedSnackPosts(),
        fetchDeletedSyzygyPosts(),
      ])
      const merged: FeedEntry[] = [
        ...uPosts.map((post): FeedEntry => ({ kind: 'user', post })),
        ...aPosts.map((post): FeedEntry => ({ kind: 'ai', post })),
      ].sort(
        (x, y) =>
          new Date(y.post.createdAt).getTime() - new Date(x.post.createdAt).getTime(),
      )
      setTrashEntries(merged)
    } catch (err) {
      console.warn('加载回收站失败', err)
      setError('回收站加载失败，请重试')
    } finally {
      setTrashLoading(false)
    }
  }, [])

  useEffect(() => {
    if (showTrash) void loadTrash()
  }, [showTrash, loadTrash])

  // Android 硬件返回键：先关掉确认弹窗/回收站视图，再交给路由后退。
  useEffect(() => {
    const handler = (e: Event) => {
      if (pendingDelete) { setPendingDelete(null); e.preventDefault(); return }
      if (pendingPurge) { setPendingPurge(null); e.preventDefault(); return }
      if (showTrash) { setShowTrash(false); e.preventDefault() }
    }
    window.addEventListener('nimbus:backbutton', handler)
    return () => window.removeEventListener('nimbus:backbutton', handler)
  }, [pendingDelete, pendingPurge, showTrash])

  const handleRestore = async (entry: FeedEntry) => {
    const postId = entry.post.id
    setBusyTrashId(postId)
    try {
      if (entry.kind === 'user') {
        await restoreSnackPost(postId)
        setUserPosts((prev) =>
          [entry.post as SnackPost, ...prev].sort(
            (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
          ),
        )
        // 帖子的回复没被软删，恢复后要拉回来，否则回复数显示为 0。
        const replies = await fetchSnackRepliesByPost(postId)
        setUserReplies((prev) => ({ ...prev, [postId]: replies }))
      } else {
        await restoreSyzygyPost(postId)
        setAiPosts((prev) =>
          [entry.post as SyzygyPost, ...prev].sort(
            (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
          ),
        )
        const replies = await fetchSyzygyRepliesByPost(postId)
        setAiReplies((prev) => ({ ...prev, [postId]: replies }))
      }
      setTrashEntries((prev) => prev.filter((e) => e.post.id !== postId))
    } catch (err) {
      console.warn('恢复失败', err)
      setError('恢复失败，请重试')
    } finally {
      setBusyTrashId(null)
    }
  }

  const handlePurge = async (entry: FeedEntry) => {
    const postId = entry.post.id
    setBusyTrashId(postId)
    try {
      if (entry.kind === 'user') {
        await permanentlyDeleteSnackPost(postId)
      } else {
        await permanentlyDeleteSyzygyPost(postId)
      }
      setTrashEntries((prev) => prev.filter((e) => e.post.id !== postId))
    } catch (err) {
      console.warn('彻底删除失败', err)
      setError('彻底删除失败，请重试')
    } finally {
      setBusyTrashId(null)
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
        <button type="button" className="page-back-btn" onClick={() => navigate(-1)}>
          ‹
        </button>
        <h1 className="moments-title">{showTrash ? '回收站' : 'Moments'}</h1>
        <button
          type="button"
          className="moments-trash-toggle"
          onClick={() => setShowTrash((v) => !v)}
        >
          {showTrash ? '返回列表' : '回收站'}
        </button>
      </header>

      {error ? (
        <p className="moments-error">{error}</p>
      ) : null}

      {showTrash ? (
        /* ── 回收站视图：软删除的帖子，可恢复 / 彻底删除 ── */
        trashLoading ? (
          <p className="moments-loading">Loading…</p>
        ) : trashEntries.length === 0 ? (
          <p className="moments-empty">回收站是空的。</p>
        ) : (
          <ul className="moments-feed">
            {trashEntries.map((entry) => (
              <li key={entry.post.id} className="moments-card glass-card">
                <div className="moments-card-header">
                  <span className={`moments-author-badge ${entry.kind === 'ai' ? 'moments-author-badge--ai' : 'moments-author-badge--user'}`}>
                    {entry.kind === 'ai' ? 'Claude' : 'kitten'}
                  </span>
                  <span className="moments-card-time">{formatTime(entry.post.createdAt)}</span>
                </div>
                <div className="moments-card-body">
                  {entry.kind === 'ai' ? (
                    <MarkdownRenderer content={entry.post.content} />
                  ) : (
                    <p className="moments-card-text">{entry.post.content}</p>
                  )}
                </div>
                <div className="moments-card-footer moments-trash-actions">
                  <button
                    type="button"
                    className="moments-btn-ai moments-btn-ai--sm"
                    onClick={() => void handleRestore(entry)}
                    disabled={busyTrashId === entry.post.id}
                  >
                    {busyTrashId === entry.post.id ? '…' : '恢复'}
                  </button>
                  <button
                    type="button"
                    className="moments-btn-danger moments-btn-ai--sm"
                    onClick={() => setPendingPurge(entry)}
                    disabled={busyTrashId === entry.post.id}
                  >
                    彻底删除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )
      ) : (
      <>
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
                    onClick={() => setPendingDelete(entry)}
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
                    onClick={() => {
                      const next = !expanded
                      setExpandedIds((prev) => ({ ...prev, [postId]: next }))
                      // 没有已有回复时点「回复」＝想写字，直接聚焦输入框；
                      // 有回复时只展开，不弹键盘打扰阅读。
                      if (next && replyCount === 0) {
                        window.setTimeout(() => replyInputRefs.current[postId]?.focus(), 60)
                      }
                    }}
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
      </>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="确定删除？"
        description="删除后可在回收站找回。"
        confirmLabel="删除"
        onConfirm={() => {
          if (pendingDelete) void handleDelete(pendingDelete)
          setPendingDelete(null)
        }}
        onCancel={() => setPendingDelete(null)}
      />

      <ConfirmDialog
        open={pendingPurge !== null}
        title="彻底删除？"
        description="将从回收站永久移除，无法再恢复。"
        confirmLabel="彻底删除"
        onConfirm={() => {
          if (pendingPurge) void handlePurge(pendingPurge)
          setPendingPurge(null)
        }}
        onCancel={() => setPendingPurge(null)}
      />
    </div>
  )
}

export default MomentsPage
