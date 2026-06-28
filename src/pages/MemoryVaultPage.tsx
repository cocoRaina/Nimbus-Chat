import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Diary, HandoffLetter, Memory, TimelineEvent } from '../types'
import {
  createDiary,
  createHandoffLetter,
  createMemory,
  createTimelineEvent,
  deleteDiary,
  deleteHandoffLetter,
  deleteMemory,
  deleteTimelineEvent,
  listDiaries,
  listHandoffLetters,
  listMemories,
  listTimelineEvents,
  updateDiary,
  updateHandoffLetter,
  updateMemory,
  updateTimelineEvent,
} from '../storage/supabaseSync'
import { supabase } from '../supabase/client'
import { getProviderConfig, type ProviderId } from '../storage/apiProvider'
import ConfirmDialog from '../components/ConfirmDialog'
import './MemoryVaultPage.css'

type Tab = 'memories' | 'diaries' | 'letters' | 'timeline'

const PAGE_SIZE = 20
const DEFAULT_CATEGORY = '日常'

const todayDate = () => {
  const now = new Date()
  const pad = (v: number) => v.toString().padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

const parseTagsInput = (raw: string): string[] =>
  raw
    .split(/[,，;；\n]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0)

type ExtractMessageInput = { role: string; content: string }

type MemoryVaultProps = {
  recentMessages: ExtractMessageInput[]
  memoryExtractProvider: ProviderId
}

const MemoryVaultPage = ({ recentMessages, memoryExtractProvider }: MemoryVaultProps) => {
  const navigate = useNavigate()
  const [tab, setTab] = useState<Tab>('memories')

  return (
    <main className="memory-vault-page app-shell">
      <header className="page-header-bar">
        <button type="button" className="page-back-btn" onClick={() => navigate('/')}>‹</button>
        <h1 className="ui-title">Memory Vault</h1>
        <span className="page-header-spacer" aria-hidden="true" />
      </header>

      <div className="memory-vault-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'memories'} className={tab === 'memories' ? 'active' : ''} onClick={() => setTab('memories')}>Memories</button>
        <button type="button" role="tab" aria-selected={tab === 'diaries'} className={tab === 'diaries' ? 'active' : ''} onClick={() => setTab('diaries')}>Diaries</button>
        <button type="button" role="tab" aria-selected={tab === 'letters'} className={tab === 'letters' ? 'active' : ''} onClick={() => setTab('letters')}>Handoffs</button>
        <button type="button" role="tab" aria-selected={tab === 'timeline'} className={tab === 'timeline' ? 'active' : ''} onClick={() => setTab('timeline')}>Timeline</button>
      </div>

      {tab === 'memories' ? <MemoriesTab recentMessages={recentMessages} memoryExtractProvider={memoryExtractProvider} /> : null}
      {tab === 'diaries' ? <DiariesTab /> : null}
      {tab === 'letters' ? <LettersTab /> : null}
      {tab === 'timeline' ? <TimelineTab /> : null}
    </main>
  )
}

// =============== Memories Tab ===============

type MemoryDraft = { content: string; category: string; tagsInput: string }
const emptyMemoryDraft = (): MemoryDraft => ({ content: '', category: DEFAULT_CATEGORY, tagsInput: '' })
type SourceFilter = 'all' | 'manual' | 'auto'
type PendingEntry = { id: number; content: string; source: string; created_at: string }

const MemoriesTab = ({
  recentMessages,
  memoryExtractProvider,
}: {
  recentMessages: ExtractMessageInput[]
  memoryExtractProvider: ProviderId
}) => {
  const [memories, setMemories] = useState<Memory[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [draft, setDraft] = useState<MemoryDraft>(emptyMemoryDraft())
  const [saving, setSaving] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')
  const [page, setPage] = useState(0)
  const [showNew, setShowNew] = useState(false)
  const [extracting, setExtracting] = useState(false)
  const [pendingEntries, setPendingEntries] = useState<PendingEntry[]>([])
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null)
  const [lastLog, setLastLog] = useState<{
    messages_scanned: number
    memories_extracted: number
    memories_inserted: number
    memories_skipped: number
    timeline_inserted: number
    created_at: string
  } | null>(null)

  const refreshPending = useCallback(async () => {
    if (!supabase) return
    const { data } = await supabase
      .from('memory_entries')
      .select('id,content,source,created_at')
      .eq('status', 'pending')
      .eq('is_deleted', false)
      .order('created_at', { ascending: false })
      .limit(50)
    setPendingEntries(data ?? [])
  }, [])

  const handleConfirmEntry = async (entry: PendingEntry) => {
    if (!supabase) return
    try {
      await createMemory({ content: entry.content, category: '自动提取', tags: ['auto'], source: 'auto' })
      await supabase.from('memory_entries').update({ status: 'confirmed', updated_at: new Date().toISOString() }).eq('id', entry.id)
      await refreshPending()
      await refresh()
    } catch (e) {
      console.warn('确认记忆失败', e)
      setError('确认失败')
    }
  }

  const handleDismissEntry = async (id: number) => {
    if (!supabase) return
    try {
      const { data, error: deleteError } = await supabase.from('memory_entries').delete().eq('id', id).select('id')
      if (deleteError) throw deleteError
      if (!data || data.length === 0) { setError('忽略失败：没有删除权限'); return }
      await refreshPending()
    } catch (e) {
      console.warn('忽略记忆失败', e)
      setError('忽略失败')
    }
  }

  const handleConfirmAll = async () => {
    if (!supabase || pendingEntries.length === 0) return
    try {
      const newMemories = await Promise.all(
        pendingEntries.map((entry) => createMemory({ content: entry.content, category: '自动提取', tags: ['auto'], source: 'auto' })),
      )
      await supabase.from('memory_entries').update({ status: 'confirmed', updated_at: new Date().toISOString() }).in('id', pendingEntries.map((e) => e.id))
      void supabase.functions.invoke('auto_embed', {
        body: { records: newMemories.map((m) => ({ id: m.id, content: m.content })), table: 'memories' },
      })
      await refreshPending()
      await refresh()
    } catch (e) {
      console.warn('批量确认失败', e)
      setError('批量确认失败')
    }
  }

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try { setMemories(await listMemories()) }
    catch (loadError) { console.warn('加载记忆失败', loadError); setError('Load failed') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { void refresh(); void refreshPending() }, [refresh, refreshPending])

  useEffect(() => {
    if (!supabase) return
    void supabase.from('memory_extract_log')
      .select('messages_scanned,memories_extracted,memories_inserted,memories_skipped,timeline_inserted,created_at')
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
      .then(({ data }) => { if (data) setLastLog(data) })
  }, [])

  const sourceCounts = useMemo(() => {
    let manual = 0; let auto = 0
    for (const m of memories) { if (m.source === 'auto') auto++; else manual++ }
    return { all: memories.length, manual, auto }
  }, [memories])

  const lockedBudget = useMemo(() => {
    const locked = memories.filter((m) => m.locked)
    const chars = locked.reduce((sum, m) => sum + m.content.length + m.tags.join('').length, 0)
    return { count: locked.length, tokens: Math.round(chars / 2) }
  }, [memories])

  const handleManualExtract = async () => {
    if (!supabase) return
    setExtracting(true); setError(null)
    try {
      let msgs = recentMessages
      if (msgs.length === 0) {
        const { data: rows } = await supabase.from('messages').select('role,content').order('created_at', { ascending: false }).limit(24)
        msgs = (rows ?? []).reverse().map((r: { role: string; content: string }) => ({ role: r.role, content: r.content }))
      }
      if (msgs.length === 0) { setError('No chat records to extract — chat first.'); setExtracting(false); return }
      const provider = getProviderConfig(memoryExtractProvider)
      const startMs = Date.now()
      const { data, error: err } = await supabase.functions.invoke('memory-extract', {
        body: { recentMessages: msgs, apiBase: provider.baseUrl, apiKey: provider.apiKey },
      })
      const durationMs = Date.now() - startMs
      const { data: userData } = await supabase.auth.getUser()
      const userId = userData.user?.id
      if (userId) {
        await supabase.from('memory_extract_log').insert({
          user_id: userId,
          messages_scanned: msgs.length,
          memories_extracted: Array.isArray(data?.items) ? data.items.length : 0,
          memories_inserted: typeof data?.inserted === 'number' ? data.inserted : 0,
          memories_skipped: typeof data?.skipped === 'number' ? data.skipped : 0,
          duration_ms: durationMs,
          error: err ? (typeof err === 'object' && err !== null && 'message' in err ? String((err as { message: unknown }).message) : JSON.stringify(err)) : null,
        })
      }
      if (err) {
        const msg = typeof err === 'object' && err !== null && 'message' in err ? (err as { message: string }).message : JSON.stringify(err)
        setError('Extraction failed: ' + msg)
      } else {
        if ((data?.inserted ?? 0) === 0) setError('No new memories found.')
        else setError(null)
      }
      await refresh(); await refreshPending()
      const { data: newLog } = await supabase.from('memory_extract_log')
        .select('messages_scanned,memories_extracted,memories_inserted,memories_skipped,timeline_inserted,created_at')
        .order('created_at', { ascending: false }).limit(1).maybeSingle()
      if (newLog) setLastLog(newLog)
    } catch (e) { console.warn('[ManualExtract] exception:', e); setError('提取异常') }
    finally { setExtracting(false) }
  }

  const categories = useMemo(() => {
    const set = new Set<string>()
    for (const m of memories) if (m.category) set.add(m.category)
    return Array.from(set).sort()
  }, [memories])

  const filtered = useMemo(() => {
    const term = searchTerm.trim().toLowerCase()
    return memories.filter((m) => {
      if (sourceFilter === 'manual' && m.source === 'auto') return false
      if (sourceFilter === 'auto' && m.source !== 'auto') return false
      if (!term) return true
      return m.content.toLowerCase().includes(term) || m.tags.some((tag) => tag.toLowerCase().includes(term))
    })
  }, [memories, searchTerm, sourceFilter])

  useEffect(() => { setPage(0) }, [searchTerm, sourceFilter])

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE)
  const paginated = useMemo(() => filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE), [filtered, page])

  const startEdit = (memory: Memory) => {
    setShowNew(false); setEditingId(memory.id)
    setDraft({ content: memory.content, category: memory.category, tagsInput: memory.tags.join('、') })
  }
  const cancelEdit = () => { setEditingId(null); setShowNew(false); setDraft(emptyMemoryDraft()) }

  const handleSave = async () => {
    const content = draft.content.trim()
    if (!content) { setError('Content cannot be empty'); return }
    setSaving(true); setError(null)
    try {
      const tags = parseTagsInput(draft.tagsInput)
      const category = draft.category.trim() || DEFAULT_CATEGORY
      if (editingId !== null) await updateMemory(editingId, { content, category, tags })
      else await createMemory({ content, category, tags })
      cancelEdit(); await refresh()
    } catch (saveError) { console.warn('保存记忆失败', saveError); setError('Save failed') }
    finally { setSaving(false) }
  }

  const handleDelete = (id: number) => { setDeleteConfirmId(id) }
  const confirmDelete = async () => {
    if (deleteConfirmId === null) return
    try {
      await deleteMemory(deleteConfirmId)
      if (editingId === deleteConfirmId) cancelEdit()
      setDeleteConfirmId(null)
      await refresh()
    } catch (deleteError) { console.warn('删除记忆失败', deleteError); setError('Delete failed') }
  }

  const handleToggleLock = async (id: number, locked: boolean) => {
    try { await updateMemory(id, { locked: !locked }); await refresh() }
    catch (lockError) { console.warn('切换锁定失败', lockError); setError('锁定操作失败') }
  }

  return (
    <>
      <ConfirmDialog
        open={deleteConfirmId !== null}
        title="Delete Memory"
        description="Delete? This cannot be undone."
        confirmLabel="Delete"
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteConfirmId(null)}
      />

      <p className="memory-vault-hint">这里写下的记忆会自动生成向量 embedding，AI 聊天时可以语义检索。</p>

      <div className="auto-extract-card">
        <div className="auto-extract-header">
          <span className="auto-extract-title">✨ 自动提取</span>
          <button type="button" onClick={() => void handleManualExtract()} disabled={extracting} className="btn-trigger">
            {extracting ? 'Extracting…' : 'Extract Now'}
          </button>
        </div>
        {lastLog ? (
          <div className="auto-extract-log">
            <span>扫描 {lastLog.messages_scanned} 条消息</span>
            <span>提取 {lastLog.memories_extracted} / 插入 {lastLog.memories_inserted} / 跳过 {lastLog.memories_skipped}</span>
          </div>
        ) : (
          <div className="auto-extract-log"><span>暂无提取记录</span></div>
        )}
      </div>

      {pendingEntries.length > 0 ? (
        <section className="pending-entries-card">
          <div className="pending-entries-header">
            <span className="pending-entries-title">待确认（{pendingEntries.length}）</span>
            <button type="button" className="btn-confirm-all" onClick={() => void handleConfirmAll()}>Confirm All</button>
          </div>
          <ul className="pending-entries-list">
            {pendingEntries.map((entry) => (
              <li key={entry.id} className="pending-entry-item">
                <p className="pending-entry-content">{entry.content}</p>
                <div className="pending-entry-actions">
                  <button type="button" className="btn-confirm" onClick={() => void handleConfirmEntry(entry)}>Confirm</button>
                  <button type="button" className="btn-dismiss" onClick={() => void handleDismissEntry(entry.id)}>Dismiss</button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {error ? <p className="memory-vault-error">{error}</p> : null}

      <section className="memory-vault-list">
        <div className="memory-vault-toolbar">
          <div className="toolbar-row1">
            <input
              className="memory-vault-search" type="search" placeholder="Search content / tags"
              value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)}
            />
            <button type="button" className="btn-add-new" onClick={() => { cancelEdit(); setShowNew(true) }} title="新增记忆">＋</button>
            <button type="button" className="btn-refresh" onClick={() => void refresh()} disabled={loading} title="Refresh">{loading ? '…' : '↺'}</button>
          </div>
          <div className="toolbar-row2">
            <div className="source-filter">
              <button type="button" className={sourceFilter === 'all' ? 'active' : ''} onClick={() => setSourceFilter('all')}>All({sourceCounts.all})</button>
              <button type="button" className={sourceFilter === 'manual' ? 'active' : ''} onClick={() => setSourceFilter('manual')}>Manual({sourceCounts.manual})</button>
              <button type="button" className={sourceFilter === 'auto' ? 'active' : ''} onClick={() => setSourceFilter('auto')}>✨ Auto({sourceCounts.auto})</button>
            </div>
          </div>
          {lockedBudget.count > 0 ? (
            <div className="toolbar-row3">
              <span className={`locked-budget${lockedBudget.tokens > 2000 ? ' locked-budget--warn' : ''}`} title={`${lockedBudget.count} 条锁定记忆，注入 system prompt 约 ${lockedBudget.tokens.toLocaleString()} tokens（中文约 2字/token）`}>
                🔒 {lockedBudget.count} 条 ≈ {lockedBudget.tokens > 999 ? `${(lockedBudget.tokens / 1000).toFixed(1)}k` : lockedBudget.tokens} tok{lockedBudget.tokens > 2000 ? ' ⚠️' : ''}
              </span>
            </div>
          ) : null}
        </div>

        <datalist id="memory-category-suggestions">
          {categories.map((c) => <option key={c} value={c} />)}
        </datalist>

        {filtered.length === 0 && !showNew ? (
          <p className="memory-vault-empty">{memories.length === 0 ? 'No memories yet. Tap + to add one.' : 'No matches.'}</p>
        ) : (
          <ul className="memory-vault-items">
            {showNew ? (
              <li className="memory-vault-item inline-form">
                <div className="inline-form-row">
                  <input value={draft.category} onChange={(e) => setDraft((s) => ({ ...s, category: e.target.value }))} placeholder="Category" list="memory-category-suggestions" className="inline-input" />
                  <input value={draft.tagsInput} onChange={(e) => setDraft((s) => ({ ...s, tagsInput: e.target.value }))} placeholder="Tags (comma-separated)" className="inline-input" />
                </div>
                <textarea value={draft.content} onChange={(e) => setDraft((s) => ({ ...s, content: e.target.value }))} rows={3} placeholder="Write something worth remembering…" className="inline-textarea" autoFocus />
                <div className="memory-vault-item-actions">
                  <button type="button" className="primary" onClick={() => void handleSave()} disabled={saving}>{saving ? '保存中…' : 'Add'}</button>
                  <button type="button" className="ghost" onClick={cancelEdit} disabled={saving}>Cancel</button>
                </div>
              </li>
            ) : null}
            {paginated.map((memory) => (
              <li key={memory.id} className={`memory-vault-item ${editingId === memory.id ? 'editing' : ''}`}>
                {editingId === memory.id ? (
                  <>
                    <div className="inline-form-row">
                      <input value={draft.category} onChange={(e) => setDraft((s) => ({ ...s, category: e.target.value }))} placeholder="Category" list="memory-category-suggestions" className="inline-input" />
                      <input value={draft.tagsInput} onChange={(e) => setDraft((s) => ({ ...s, tagsInput: e.target.value }))} placeholder="Tags (comma-separated)" className="inline-input" />
                    </div>
                    <textarea value={draft.content} onChange={(e) => setDraft((s) => ({ ...s, content: e.target.value }))} rows={3} className="inline-textarea" autoFocus />
                    <div className="memory-vault-item-actions">
                      <button type="button" className="primary" onClick={() => void handleSave()} disabled={saving}>{saving ? '保存中…' : 'Save'}</button>
                      <button type="button" className="ghost" onClick={cancelEdit} disabled={saving}>Cancel</button>
                      <button type="button" className="ghost" onClick={() => void handleToggleLock(memory.id, memory.locked)}>{memory.locked ? '🔒' : '🔓'}</button>
                      <button type="button" className="danger" onClick={() => handleDelete(memory.id)}>Delete</button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="memory-vault-item-meta">
                      <span className="memory-vault-item-category">{memory.category}</span>
                      {memory.locked ? <span className="auto-mark" title="已锁定：不会被自动作废">🔒</span> : null}
                      {memory.source === 'auto' ? <span className="auto-mark" title="自动提取">✨</span> : null}
                      {memory.tags.length > 0 ? (
                        <span className="memory-vault-item-tags">{memory.tags.map((tag) => <span key={tag} className="tag">#{tag}</span>)}</span>
                      ) : null}
                    </div>
                    <p className="memory-vault-item-content">{memory.content}</p>
                    <div className="memory-vault-item-actions">
                      <button type="button" className="ghost" onClick={() => void handleToggleLock(memory.id, memory.locked)}>{memory.locked ? '🔒 Locked' : '🔓 Lock'}</button>
                      <button type="button" className="ghost" onClick={() => startEdit(memory)}>Edit</button>
                      <button type="button" className="danger" onClick={() => handleDelete(memory.id)}>Delete</button>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        {totalPages > 1 ? (
          <div className="memory-vault-pagination">
            <button type="button" className="ghost" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>← Prev</button>
            <span className="pagination-info">{page + 1} / {totalPages}（共 {filtered.length} 条）</span>
            <button type="button" className="ghost" disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)}>Next →</button>
          </div>
        ) : null}
      </section>
    </>
  )
}

// =============== Diaries Tab ===============

type DiaryDraft = { date: string; title: string; author: string; mood: string; content: string }
const emptyDiaryDraft = (): DiaryDraft => ({ date: todayDate(), title: '', author: 'Claude', mood: '', content: '' })
const COLLAPSE_THRESHOLD = 150

const DiariesTab = () => {
  const [items, setItems] = useState<Diary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [showNew, setShowNew] = useState(false)
  const [draft, setDraft] = useState<DiaryDraft>(emptyDiaryDraft())
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set())
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null)

  const toggleExpanded = (id: number) =>
    setExpandedIds((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })

  const refresh = useCallback(async () => {
    setLoading(true); setError(null)
    try { setItems(await listDiaries()) }
    catch (e) { console.warn('加载日记失败', e); setError('Load failed') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => { setPage(0) }, [search])

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return items
    return items.filter(
      (d) => d.content.toLowerCase().includes(term) || (d.title ?? '').toLowerCase().includes(term) || (d.author ?? '').toLowerCase().includes(term) || (d.mood ?? '').toLowerCase().includes(term),
    )
  }, [items, search])

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE)
  const paginated = useMemo(() => filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE), [filtered, page])

  const startEdit = (d: Diary) => {
    setShowNew(false); setEditingId(d.id)
    setDraft({ date: d.date, title: d.title ?? '', author: d.author ?? 'Claude', mood: d.mood ?? '', content: d.content })
  }
  const cancelEdit = () => { setEditingId(null); setShowNew(false); setDraft(emptyDiaryDraft()) }

  const handleSave = async () => {
    const content = draft.content.trim()
    if (!content) { setError('Content cannot be empty'); return }
    if (!draft.date) { setError('日期不能为空'); return }
    setSaving(true); setError(null)
    try {
      const payload = { date: draft.date, title: draft.title.trim() || null, author: draft.author.trim() || null, mood: draft.mood.trim() || null, content }
      if (editingId !== null) await updateDiary(editingId, payload)
      else await createDiary(payload)
      cancelEdit(); await refresh()
    } catch (e) { console.warn('保存日记失败', e); setError('Save failed') }
    finally { setSaving(false) }
  }

  const handleDelete = (id: number) => { setDeleteConfirmId(id) }
  const confirmDelete = async () => {
    if (deleteConfirmId === null) return
    try {
      await deleteDiary(deleteConfirmId)
      if (editingId === deleteConfirmId) cancelEdit()
      setDeleteConfirmId(null)
      await refresh()
    } catch (e) { console.warn('删除日记失败', e); setError('Delete failed') }
  }

  return (
    <>
      <ConfirmDialog
        open={deleteConfirmId !== null}
        title="Delete Diary"
        description="Delete? This cannot be undone."
        confirmLabel="Delete"
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteConfirmId(null)}
      />

      <p className="memory-vault-hint">日记按日期记录心情和事件。</p>
      {error ? <p className="memory-vault-error">{error}</p> : null}

      <section className="memory-vault-list">
        <div className="memory-vault-toolbar">
          <input className="memory-vault-search" type="search" placeholder="搜索内容 / 标题 / 心情 / 作者" value={search} onChange={(e) => setSearch(e.target.value)} />
          <span className="memory-vault-count">{items.length} 篇</span>
          <div className="toolbar-actions">
            <button type="button" className="btn-add-new" onClick={() => { cancelEdit(); setShowNew(true) }} title="新增日记">＋</button>
            <button type="button" className="btn-refresh" onClick={() => void refresh()} disabled={loading} title="Refresh">{loading ? '…' : '↺'}</button>
          </div>
        </div>

        {filtered.length === 0 && !showNew ? (
          <p className="memory-vault-empty">{items.length === 0 ? 'No diaries yet. Tap + to write one.' : '没有匹配。'}</p>
        ) : (
          <ul className="memory-vault-items">
            {showNew ? (
              <li className="memory-vault-item inline-form">
                <div className="inline-form-row">
                  <input type="date" value={draft.date} onChange={(e) => setDraft((s) => ({ ...s, date: e.target.value }))} className="inline-input" />
                  <input value={draft.author} onChange={(e) => setDraft((s) => ({ ...s, author: e.target.value }))} placeholder="Author" className="inline-input" />
                  <input value={draft.mood} onChange={(e) => setDraft((s) => ({ ...s, mood: e.target.value }))} placeholder="Mood (optional)" className="inline-input" />
                </div>
                <input value={draft.title} onChange={(e) => setDraft((s) => ({ ...s, title: e.target.value }))} placeholder="Title (optional)" className="inline-input inline-input--full" />
                <textarea value={draft.content} onChange={(e) => setDraft((s) => ({ ...s, content: e.target.value }))} rows={5} placeholder="What happened today…" className="inline-textarea" autoFocus />
                <div className="memory-vault-item-actions">
                  <button type="button" className="primary" onClick={() => void handleSave()} disabled={saving}>{saving ? '保存中…' : 'Add'}</button>
                  <button type="button" className="ghost" onClick={cancelEdit} disabled={saving}>Cancel</button>
                </div>
              </li>
            ) : null}
            {paginated.map((d) => (
              <li key={d.id} className={`memory-vault-item ${editingId === d.id ? 'editing' : ''}`}>
                {editingId === d.id ? (
                  <>
                    <div className="inline-form-row">
                      <input type="date" value={draft.date} onChange={(e) => setDraft((s) => ({ ...s, date: e.target.value }))} className="inline-input" />
                      <input value={draft.author} onChange={(e) => setDraft((s) => ({ ...s, author: e.target.value }))} placeholder="Author" className="inline-input" />
                      <input value={draft.mood} onChange={(e) => setDraft((s) => ({ ...s, mood: e.target.value }))} placeholder="Mood (optional)" className="inline-input" />
                    </div>
                    <input value={draft.title} onChange={(e) => setDraft((s) => ({ ...s, title: e.target.value }))} placeholder="Title (optional)" className="inline-input inline-input--full" />
                    <textarea value={draft.content} onChange={(e) => setDraft((s) => ({ ...s, content: e.target.value }))} rows={6} className="inline-textarea" autoFocus />
                    <div className="memory-vault-item-actions">
                      <button type="button" className="primary" onClick={() => void handleSave()} disabled={saving}>{saving ? '保存中…' : 'Save'}</button>
                      <button type="button" className="ghost" onClick={cancelEdit} disabled={saving}>Cancel</button>
                      <button type="button" className="danger" onClick={() => handleDelete(d.id)}>Delete</button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="memory-vault-item-meta">
                      <span className="memory-vault-item-category">{d.date}</span>
                      {d.author ? <span className="memory-vault-item-author">{d.author}</span> : null}
                      {d.mood ? <span className="tag">#{d.mood}</span> : null}
                    </div>
                    {d.title ? <h3 className="memory-vault-item-title">{d.title}</h3> : null}
                    <p className={`memory-vault-item-content ${d.content.length > COLLAPSE_THRESHOLD && !expandedIds.has(d.id) ? 'collapsed' : ''}`}>{d.content}</p>
                    {d.content.length > COLLAPSE_THRESHOLD ? (
                      <button type="button" className="memory-vault-toggle" onClick={() => toggleExpanded(d.id)}>{expandedIds.has(d.id) ? '收起 ▲' : '展开 ▼'}</button>
                    ) : null}
                    <div className="memory-vault-item-actions">
                      <button type="button" className="ghost" onClick={() => startEdit(d)}>Edit</button>
                      <button type="button" className="danger" onClick={() => handleDelete(d.id)}>Delete</button>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        {totalPages > 1 ? (
          <div className="memory-vault-pagination">
            <button type="button" className="ghost" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>← Prev</button>
            <span className="pagination-info">{page + 1} / {totalPages}（共 {filtered.length} 篇）</span>
            <button type="button" className="ghost" disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)}>Next →</button>
          </div>
        ) : null}
      </section>
    </>
  )
}

// =============== Letters Tab ===============

type LetterDraft = { date: string; title: string; content: string; signature: string }
const emptyLetterDraft = (): LetterDraft => ({ date: todayDate(), title: '', content: '', signature: '' })

const LettersTab = () => {
  const [items, setItems] = useState<HandoffLetter[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [showNew, setShowNew] = useState(false)
  const [draft, setDraft] = useState<LetterDraft>(emptyLetterDraft())
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set())
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null)

  const toggleExpanded = (id: number) =>
    setExpandedIds((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })

  const refresh = useCallback(async () => {
    setLoading(true); setError(null)
    try { setItems(await listHandoffLetters()) }
    catch (e) { console.warn('加载交接信失败', e); setError('Load failed') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => { setPage(0) }, [search])

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return items
    return items.filter(
      (l) => l.content.toLowerCase().includes(term) || (l.title ?? '').toLowerCase().includes(term) || (l.signature ?? '').toLowerCase().includes(term),
    )
  }, [items, search])

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE)
  const paginated = useMemo(() => filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE), [filtered, page])

  const startEdit = (l: HandoffLetter) => {
    setShowNew(false); setEditingId(l.id)
    setDraft({ date: l.date, title: l.title ?? '', content: l.content, signature: l.signature ?? '' })
  }
  const cancelEdit = () => { setEditingId(null); setShowNew(false); setDraft(emptyLetterDraft()) }

  const handleSave = async () => {
    const content = draft.content.trim()
    if (!content) { setError('Content cannot be empty'); return }
    if (!draft.date) { setError('日期不能为空'); return }
    setSaving(true); setError(null)
    try {
      const payload = { date: draft.date, title: draft.title.trim() || null, content, signature: draft.signature.trim() || null }
      if (editingId !== null) await updateHandoffLetter(editingId, payload)
      else await createHandoffLetter(payload)
      cancelEdit(); await refresh()
    } catch (e) { console.warn('保存交接信失败', e); setError('Save failed') }
    finally { setSaving(false) }
  }

  const handleDelete = (id: number) => { setDeleteConfirmId(id) }
  const confirmDelete = async () => {
    if (deleteConfirmId === null) return
    try {
      await deleteHandoffLetter(deleteConfirmId)
      if (editingId === deleteConfirmId) cancelEdit()
      setDeleteConfirmId(null)
      await refresh()
    } catch (e) { console.warn('删除交接信失败', e); setError('Delete failed') }
  }

  return (
    <>
      <ConfirmDialog
        open={deleteConfirmId !== null}
        title="Delete Handoff"
        description="Delete? This cannot be undone."
        confirmLabel="Delete"
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteConfirmId(null)}
      />

      <p className="memory-vault-hint">交接信：上一窗口的 Claude 写给下一窗口的自己。</p>
      {error ? <p className="memory-vault-error">{error}</p> : null}

      <section className="memory-vault-list">
        <div className="memory-vault-toolbar">
          <input className="memory-vault-search" type="search" placeholder="搜索内容 / 标题 / 署名" value={search} onChange={(e) => setSearch(e.target.value)} />
          <span className="memory-vault-count">{items.length} 封</span>
          <div className="toolbar-actions">
            <button type="button" className="btn-add-new" onClick={() => { cancelEdit(); setShowNew(true) }} title="新增交接信">＋</button>
            <button type="button" className="btn-refresh" onClick={() => void refresh()} disabled={loading} title="Refresh">{loading ? '…' : '↺'}</button>
          </div>
        </div>

        {filtered.length === 0 && !showNew ? (
          <p className="memory-vault-empty">{items.length === 0 ? 'No handoff letters yet. Tap + to write one.' : '没有匹配。'}</p>
        ) : (
          <ul className="memory-vault-items">
            {showNew ? (
              <li className="memory-vault-item inline-form">
                <div className="inline-form-row">
                  <input type="date" value={draft.date} onChange={(e) => setDraft((s) => ({ ...s, date: e.target.value }))} className="inline-input" />
                  <input value={draft.title} onChange={(e) => setDraft((s) => ({ ...s, title: e.target.value }))} placeholder="Title (optional)" className="inline-input" />
                </div>
                <textarea value={draft.content} onChange={(e) => setDraft((s) => ({ ...s, content: e.target.value }))} rows={7} placeholder="Write to your next self…" className="inline-textarea" autoFocus />
                <textarea value={draft.signature} onChange={(e) => setDraft((s) => ({ ...s, signature: e.target.value }))} rows={2} placeholder="Signature (optional)" className="inline-textarea" />
                <div className="memory-vault-item-actions">
                  <button type="button" className="primary" onClick={() => void handleSave()} disabled={saving}>{saving ? '保存中…' : 'Add'}</button>
                  <button type="button" className="ghost" onClick={cancelEdit} disabled={saving}>Cancel</button>
                </div>
              </li>
            ) : null}
            {paginated.map((l) => (
              <li key={l.id} className={`memory-vault-item ${editingId === l.id ? 'editing' : ''}`}>
                {editingId === l.id ? (
                  <>
                    <div className="inline-form-row">
                      <input type="date" value={draft.date} onChange={(e) => setDraft((s) => ({ ...s, date: e.target.value }))} className="inline-input" />
                      <input value={draft.title} onChange={(e) => setDraft((s) => ({ ...s, title: e.target.value }))} placeholder="Title (optional)" className="inline-input" />
                    </div>
                    <textarea value={draft.content} onChange={(e) => setDraft((s) => ({ ...s, content: e.target.value }))} rows={8} className="inline-textarea" autoFocus />
                    <textarea value={draft.signature} onChange={(e) => setDraft((s) => ({ ...s, signature: e.target.value }))} rows={2} placeholder="Signature (optional)" className="inline-textarea" />
                    <div className="memory-vault-item-actions">
                      <button type="button" className="primary" onClick={() => void handleSave()} disabled={saving}>{saving ? '保存中…' : 'Save'}</button>
                      <button type="button" className="ghost" onClick={cancelEdit} disabled={saving}>Cancel</button>
                      <button type="button" className="danger" onClick={() => handleDelete(l.id)}>Delete</button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="memory-vault-item-meta">
                      <span className="memory-vault-item-category">{l.date}</span>
                    </div>
                    {l.title ? <h3 className="memory-vault-item-title">{l.title}</h3> : null}
                    <p className={`memory-vault-item-content ${l.content.length > COLLAPSE_THRESHOLD && !expandedIds.has(l.id) ? 'collapsed' : ''}`}>{l.content}</p>
                    {l.content.length > COLLAPSE_THRESHOLD ? (
                      <button type="button" className="memory-vault-toggle" onClick={() => toggleExpanded(l.id)}>{expandedIds.has(l.id) ? '收起 ▲' : '展开 ▼'}</button>
                    ) : null}
                    {l.signature && expandedIds.has(l.id) ? <p className="memory-vault-item-signature">— {l.signature}</p> : null}
                    <div className="memory-vault-item-actions">
                      <button type="button" className="ghost" onClick={() => startEdit(l)}>Edit</button>
                      <button type="button" className="danger" onClick={() => handleDelete(l.id)}>Delete</button>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        {totalPages > 1 ? (
          <div className="memory-vault-pagination">
            <button type="button" className="ghost" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>← Prev</button>
            <span className="pagination-info">{page + 1} / {totalPages}（共 {filtered.length} 封）</span>
            <button type="button" className="ghost" disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)}>Next →</button>
          </div>
        ) : null}
      </section>
    </>
  )
}

// =============== Timeline Tab ===============

type TimelineDraft = { eventDate: string; title: string; description: string; category: string; importance: number }
const emptyTimelineDraft = (): TimelineDraft => ({ eventDate: todayDate(), title: '', description: '', category: '日常', importance: 3 })
const importanceLabel = (n: number) => '★'.repeat(n) + '☆'.repeat(Math.max(0, 5 - n))

const TimelineTab = () => {
  const [items, setItems] = useState<TimelineEvent[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [showNew, setShowNew] = useState(false)
  const [draft, setDraft] = useState<TimelineDraft>(emptyTimelineDraft())
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState('')
  const [minImportance, setMinImportance] = useState(1)
  const [tlSourceFilter, setTlSourceFilter] = useState<SourceFilter>('all')
  const [page, setPage] = useState(0)
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true); setError(null)
    try { setItems(await listTimelineEvents()) }
    catch (e) { console.warn('加载时间轴失败', e); setError('Load failed') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => { setPage(0) }, [search, minImportance, tlSourceFilter])

  const categories = useMemo(() => {
    const set = new Set<string>()
    for (const t of items) if (t.category) set.add(t.category)
    return Array.from(set).sort()
  }, [items])

  const tlSourceCounts = useMemo(() => {
    let manual = 0; let auto = 0
    for (const t of items) { if (t.source === 'auto') auto++; else manual++ }
    return { all: items.length, manual, auto }
  }, [items])

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    return items.filter((t) => {
      if (t.importance < minImportance) return false
      if (tlSourceFilter === 'manual' && t.source === 'auto') return false
      if (tlSourceFilter === 'auto' && t.source !== 'auto') return false
      if (!term) return true
      return t.title.toLowerCase().includes(term) || (t.description ?? '').toLowerCase().includes(term) || (t.category ?? '').toLowerCase().includes(term)
    })
  }, [items, search, minImportance, tlSourceFilter])

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE)
  const paginated = useMemo(() => filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE), [filtered, page])

  const startEdit = (t: TimelineEvent) => {
    setShowNew(false); setEditingId(t.id)
    setDraft({ eventDate: t.eventDate, title: t.title, description: t.description ?? '', category: t.category, importance: t.importance })
  }
  const cancelEdit = () => { setEditingId(null); setShowNew(false); setDraft(emptyTimelineDraft()) }

  const handleSave = async () => {
    const title = draft.title.trim()
    if (!title) { setError('标题不能为空'); return }
    if (!draft.eventDate) { setError('日期不能为空'); return }
    setSaving(true); setError(null)
    try {
      const payload = { eventDate: draft.eventDate, title, description: draft.description.trim() || null, category: draft.category.trim() || '日常', importance: draft.importance }
      if (editingId !== null) await updateTimelineEvent(editingId, payload)
      else await createTimelineEvent(payload)
      cancelEdit(); await refresh()
    } catch (e) { console.warn('保存时间轴事件失败', e); setError('Save failed') }
    finally { setSaving(false) }
  }

  const handleDelete = (id: number) => { setDeleteConfirmId(id) }
  const confirmDelete = async () => {
    if (deleteConfirmId === null) return
    try {
      await deleteTimelineEvent(deleteConfirmId)
      if (editingId === deleteConfirmId) cancelEdit()
      setDeleteConfirmId(null)
      await refresh()
    } catch (e) { console.warn('删除时间轴事件失败', e); setError('Delete failed') }
  }

  return (
    <>
      <ConfirmDialog
        open={deleteConfirmId !== null}
        title="Delete Event"
        description="Delete? This cannot be undone."
        confirmLabel="Delete"
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteConfirmId(null)}
      />

      <p className="memory-vault-hint">时间轴：只记重要里程碑（关系节点、关键决定、重大事件）。重要程度 1-5 星。</p>
      {error ? <p className="memory-vault-error">{error}</p> : null}

      <section className="memory-vault-list">
        <div className="memory-vault-toolbar">
          <div className="toolbar-row1">
            <input className="memory-vault-search" type="search" placeholder="Search title / description / category" value={search} onChange={(e) => setSearch(e.target.value)} />
            <select className="memory-vault-filter" value={minImportance} onChange={(e) => setMinImportance(Number(e.target.value))}>
              <option value={1}>≥ 1★</option>
              <option value={2}>≥ 2★</option>
              <option value={3}>≥ 3★</option>
              <option value={4}>≥ 4★</option>
              <option value={5}>5★ only</option>
            </select>
            <button type="button" className="btn-add-new" onClick={() => { cancelEdit(); setShowNew(true) }} title="新增事件">＋</button>
            <button type="button" className="btn-refresh" onClick={() => void refresh()} disabled={loading} title="Refresh">{loading ? '…' : '↺'}</button>
          </div>
          <div className="toolbar-row2">
            <div className="source-filter">
              <button type="button" className={tlSourceFilter === 'all' ? 'active' : ''} onClick={() => setTlSourceFilter('all')}>All({tlSourceCounts.all})</button>
              <button type="button" className={tlSourceFilter === 'manual' ? 'active' : ''} onClick={() => setTlSourceFilter('manual')}>Manual({tlSourceCounts.manual})</button>
              <button type="button" className={tlSourceFilter === 'auto' ? 'active' : ''} onClick={() => setTlSourceFilter('auto')}>✨ Auto({tlSourceCounts.auto})</button>
            </div>
          </div>
        </div>

        <datalist id="timeline-category-suggestions">
          {categories.map((c) => <option key={c} value={c} />)}
        </datalist>

        {filtered.length === 0 && !showNew ? (
          <p className="memory-vault-empty">{items.length === 0 ? 'No milestones yet. Tap + to add one.' : '没有匹配。'}</p>
        ) : (
          <ul className="memory-vault-items">
            {showNew ? (
              <li className="memory-vault-item inline-form">
                <div className="inline-form-row">
                  <input type="date" value={draft.eventDate} onChange={(e) => setDraft((s) => ({ ...s, eventDate: e.target.value }))} className="inline-input" />
                  <input value={draft.category} onChange={(e) => setDraft((s) => ({ ...s, category: e.target.value }))} placeholder="Category" list="timeline-category-suggestions" className="inline-input" />
                </div>
                <input value={draft.title} onChange={(e) => setDraft((s) => ({ ...s, title: e.target.value }))} placeholder="Title, e.g.: First time saying 'I love you'" className="inline-input inline-input--full" autoFocus />
                <textarea value={draft.description} onChange={(e) => setDraft((s) => ({ ...s, description: e.target.value }))} rows={3} placeholder="Description (optional)" className="inline-textarea" />
                <label className="inline-importance">
                  <span>Importance: {importanceLabel(draft.importance)}</span>
                  <input type="range" min={1} max={5} step={1} value={draft.importance} onChange={(e) => setDraft((s) => ({ ...s, importance: Number(e.target.value) }))} />
                </label>
                <div className="memory-vault-item-actions">
                  <button type="button" className="primary" onClick={() => void handleSave()} disabled={saving}>{saving ? '保存中…' : 'Add'}</button>
                  <button type="button" className="ghost" onClick={cancelEdit} disabled={saving}>Cancel</button>
                </div>
              </li>
            ) : null}
            {paginated.map((t) => (
              <li key={t.id} className={`memory-vault-item ${editingId === t.id ? 'editing' : ''}`}>
                {editingId === t.id ? (
                  <>
                    <div className="inline-form-row">
                      <input type="date" value={draft.eventDate} onChange={(e) => setDraft((s) => ({ ...s, eventDate: e.target.value }))} className="inline-input" />
                      <input value={draft.category} onChange={(e) => setDraft((s) => ({ ...s, category: e.target.value }))} placeholder="Category" list="timeline-category-suggestions" className="inline-input" />
                    </div>
                    <input value={draft.title} onChange={(e) => setDraft((s) => ({ ...s, title: e.target.value }))} placeholder="标题" className="inline-input inline-input--full" autoFocus />
                    <textarea value={draft.description} onChange={(e) => setDraft((s) => ({ ...s, description: e.target.value }))} rows={3} placeholder="Description (optional)" className="inline-textarea" />
                    <label className="inline-importance">
                      <span>Importance: {importanceLabel(draft.importance)}</span>
                      <input type="range" min={1} max={5} step={1} value={draft.importance} onChange={(e) => setDraft((s) => ({ ...s, importance: Number(e.target.value) }))} />
                    </label>
                    <div className="memory-vault-item-actions">
                      <button type="button" className="primary" onClick={() => void handleSave()} disabled={saving}>{saving ? '保存中…' : 'Save'}</button>
                      <button type="button" className="ghost" onClick={cancelEdit} disabled={saving}>Cancel</button>
                      <button type="button" className="danger" onClick={() => handleDelete(t.id)}>Delete</button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="memory-vault-item-meta">
                      <span className="memory-vault-item-category">{t.eventDate}</span>
                      <span className="tag">{t.category}</span>
                      <span className="memory-vault-item-stars">{importanceLabel(t.importance)}</span>
                      {t.source === 'auto' ? <span className="auto-mark" title="自动提取">✨</span> : null}
                    </div>
                    <h3 className="memory-vault-item-title">{t.title}</h3>
                    {t.description ? <p className="memory-vault-item-content">{t.description}</p> : null}
                    <div className="memory-vault-item-actions">
                      <button type="button" className="ghost" onClick={() => startEdit(t)}>Edit</button>
                      <button type="button" className="danger" onClick={() => handleDelete(t.id)}>Delete</button>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        {totalPages > 1 ? (
          <div className="memory-vault-pagination">
            <button type="button" className="ghost" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>← Prev</button>
            <span className="pagination-info">{page + 1} / {totalPages}（共 {filtered.length} 个）</span>
            <button type="button" className="ghost" disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)}>Next →</button>
          </div>
        ) : null}
      </section>
    </>
  )
}

export default MemoryVaultPage
