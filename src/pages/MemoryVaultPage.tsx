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
import './MemoryVaultPage.css'

type Tab = 'memories' | 'diaries' | 'letters' | 'timeline'

const DEFAULT_CATEGORY = '日常'
const ALL_CATEGORY = '__all__'

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

const MemoryVaultPage = () => {
  const navigate = useNavigate()
  const [tab, setTab] = useState<Tab>('memories')

  return (
    <main className="memory-vault-page app-shell">
      <header className="memory-vault-header">
        <button type="button" className="ghost back" onClick={() => navigate(-1)}>
          ← 返回
        </button>
        <h1 className="ui-title">记忆库</h1>
        <div className="memory-vault-header-spacer" />
      </header>

      <div className="memory-vault-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'memories'}
          className={tab === 'memories' ? 'active' : ''}
          onClick={() => setTab('memories')}
        >
          记忆
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'diaries'}
          className={tab === 'diaries' ? 'active' : ''}
          onClick={() => setTab('diaries')}
        >
          日记
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'letters'}
          className={tab === 'letters' ? 'active' : ''}
          onClick={() => setTab('letters')}
        >
          交接信
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'timeline'}
          className={tab === 'timeline' ? 'active' : ''}
          onClick={() => setTab('timeline')}
        >
          时间轴
        </button>
      </div>

      {tab === 'memories' ? <MemoriesTab /> : null}
      {tab === 'diaries' ? <DiariesTab /> : null}
      {tab === 'letters' ? <LettersTab /> : null}
      {tab === 'timeline' ? <TimelineTab /> : null}
    </main>
  )
}

// =============== Memories Tab ===============

type MemoryDraft = {
  content: string
  category: string
  tagsInput: string
}

const emptyMemoryDraft = (): MemoryDraft => ({
  content: '',
  category: DEFAULT_CATEGORY,
  tagsInput: '',
})

const MemoriesTab = () => {
  const [memories, setMemories] = useState<Memory[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [draft, setDraft] = useState<MemoryDraft>(emptyMemoryDraft())
  const [saving, setSaving] = useState(false)
  const [filterCategory, setFilterCategory] = useState<string>(ALL_CATEGORY)
  const [searchTerm, setSearchTerm] = useState('')

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setMemories(await listMemories())
    } catch (loadError) {
      console.warn('加载记忆失败', loadError)
      setError('加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const categories = useMemo(() => {
    const set = new Set<string>()
    for (const m of memories) {
      if (m.category) set.add(m.category)
    }
    return Array.from(set).sort()
  }, [memories])

  const filtered = useMemo(() => {
    const term = searchTerm.trim().toLowerCase()
    return memories.filter((m) => {
      if (filterCategory !== ALL_CATEGORY && m.category !== filterCategory) return false
      if (!term) return true
      return (
        m.content.toLowerCase().includes(term) ||
        m.tags.some((tag) => tag.toLowerCase().includes(term))
      )
    })
  }, [memories, filterCategory, searchTerm])

  const startEdit = (memory: Memory) => {
    setEditingId(memory.id)
    setDraft({ content: memory.content, category: memory.category, tagsInput: memory.tags.join('、') })
  }

  const cancelEdit = () => {
    setEditingId(null)
    setDraft(emptyMemoryDraft())
  }

  const handleSave = async () => {
    const content = draft.content.trim()
    if (!content) {
      setError('内容不能为空')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const tags = parseTagsInput(draft.tagsInput)
      const category = draft.category.trim() || DEFAULT_CATEGORY
      if (editingId !== null) {
        await updateMemory(editingId, { content, category, tags })
      } else {
        await createMemory({ content, category, tags })
      }
      cancelEdit()
      await refresh()
    } catch (saveError) {
      console.warn('保存记忆失败', saveError)
      setError('保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: number) => {
    if (!window.confirm('确认删除？')) return
    try {
      await deleteMemory(id)
      if (editingId === id) cancelEdit()
      await refresh()
    } catch (deleteError) {
      console.warn('删除记忆失败', deleteError)
      setError('删除失败')
    }
  }

  return (
    <>
      <p className="memory-vault-hint">这里写下的记忆会自动生成向量 embedding，AI 聊天时可以语义检索。</p>
      {error ? <p className="memory-vault-error">{error}</p> : null}

      <section className="memory-vault-editor">
        <h2 className="ui-title">{editingId !== null ? '编辑记忆' : '新增记忆'}</h2>
        <label className="memory-vault-field">
          <span>内容</span>
          <textarea
            value={draft.content}
            onChange={(e) => setDraft((s) => ({ ...s, content: e.target.value }))}
            rows={4}
            placeholder="写一条值得 AI 记住的事..."
          />
        </label>
        <div className="memory-vault-row">
          <label className="memory-vault-field">
            <span>分类</span>
            <input
              value={draft.category}
              onChange={(e) => setDraft((s) => ({ ...s, category: e.target.value }))}
              placeholder={DEFAULT_CATEGORY}
              list="memory-category-suggestions"
            />
            <datalist id="memory-category-suggestions">
              {categories.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </label>
          <label className="memory-vault-field">
            <span>标签（逗号/分号分隔）</span>
            <input
              value={draft.tagsInput}
              onChange={(e) => setDraft((s) => ({ ...s, tagsInput: e.target.value }))}
              placeholder="例如：偏好, 食物"
            />
          </label>
        </div>
        <div className="memory-vault-editor-actions">
          <button type="button" className="primary" onClick={() => void handleSave()} disabled={saving}>
            {saving ? '保存中…' : editingId !== null ? '保存修改' : '添加'}
          </button>
          {editingId !== null ? (
            <button type="button" className="ghost" onClick={cancelEdit} disabled={saving}>
              取消
            </button>
          ) : null}
          <button type="button" className="ghost" onClick={() => void refresh()} disabled={loading}>
            {loading ? '刷新中…' : '刷新'}
          </button>
        </div>
      </section>

      <section className="memory-vault-list">
        <div className="memory-vault-toolbar">
          <input
            className="memory-vault-search"
            type="search"
            placeholder="搜索内容 / 标签"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
          <select
            className="memory-vault-filter"
            value={filterCategory}
            onChange={(e) => setFilterCategory(e.target.value)}
          >
            <option value={ALL_CATEGORY}>全部（{memories.length}）</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}（{memories.filter((m) => m.category === c).length}）
              </option>
            ))}
          </select>
        </div>

        {filtered.length === 0 ? (
          <p className="memory-vault-empty">
            {memories.length === 0 ? '还没有记忆，写一条试试。' : '没有匹配的记忆。'}
          </p>
        ) : (
          <ul className="memory-vault-items">
            {filtered.map((memory) => (
              <li
                key={memory.id}
                className={`memory-vault-item ${editingId === memory.id ? 'editing' : ''}`}
              >
                <div className="memory-vault-item-meta">
                  <span className="memory-vault-item-category">{memory.category}</span>
                  {memory.tags.length > 0 ? (
                    <span className="memory-vault-item-tags">
                      {memory.tags.map((tag) => (
                        <span key={tag} className="tag">
                          #{tag}
                        </span>
                      ))}
                    </span>
                  ) : null}
                </div>
                <p className="memory-vault-item-content">{memory.content}</p>
                <div className="memory-vault-item-actions">
                  <button type="button" className="ghost" onClick={() => startEdit(memory)}>
                    编辑
                  </button>
                  <button type="button" className="danger" onClick={() => void handleDelete(memory.id)}>
                    删除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  )
}

// =============== Diaries Tab ===============

type DiaryDraft = {
  date: string
  title: string
  author: string
  mood: string
  content: string
}

const emptyDiaryDraft = (): DiaryDraft => ({
  date: todayDate(),
  title: '',
  author: 'Claude',
  mood: '',
  content: '',
})

const COLLAPSE_THRESHOLD = 150

const DiariesTab = () => {
  const [items, setItems] = useState<Diary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [draft, setDraft] = useState<DiaryDraft>(emptyDiaryDraft())
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState('')
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set())

  const toggleExpanded = (id: number) =>
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setItems(await listDiaries())
    } catch (e) {
      console.warn('加载日记失败', e)
      setError('加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return items
    return items.filter(
      (d) =>
        d.content.toLowerCase().includes(term) ||
        (d.title ?? '').toLowerCase().includes(term) ||
        (d.author ?? '').toLowerCase().includes(term) ||
        (d.mood ?? '').toLowerCase().includes(term),
    )
  }, [items, search])

  const startEdit = (d: Diary) => {
    setEditingId(d.id)
    setDraft({
      date: d.date,
      title: d.title ?? '',
      author: d.author ?? 'Claude',
      mood: d.mood ?? '',
      content: d.content,
    })
  }

  const cancelEdit = () => {
    setEditingId(null)
    setDraft(emptyDiaryDraft())
  }

  const handleSave = async () => {
    const content = draft.content.trim()
    if (!content) {
      setError('内容不能为空')
      return
    }
    if (!draft.date) {
      setError('日期不能为空')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const payload = {
        date: draft.date,
        title: draft.title.trim() || null,
        author: draft.author.trim() || null,
        mood: draft.mood.trim() || null,
        content,
      }
      if (editingId !== null) {
        await updateDiary(editingId, payload)
      } else {
        await createDiary(payload)
      }
      cancelEdit()
      await refresh()
    } catch (e) {
      console.warn('保存日记失败', e)
      setError('保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: number) => {
    if (!window.confirm('确认删除？')) return
    try {
      await deleteDiary(id)
      if (editingId === id) cancelEdit()
      await refresh()
    } catch (e) {
      console.warn('删除日记失败', e)
      setError('删除失败')
    }
  }

  return (
    <>
      <p className="memory-vault-hint">日记按日期记录心情和事件，AI 暂不会主动检索。</p>
      {error ? <p className="memory-vault-error">{error}</p> : null}

      <section className="memory-vault-editor">
        <h2 className="ui-title">{editingId !== null ? '编辑日记' : '新增日记'}</h2>
        <div className="memory-vault-row">
          <label className="memory-vault-field">
            <span>日期</span>
            <input
              type="date"
              value={draft.date}
              onChange={(e) => setDraft((s) => ({ ...s, date: e.target.value }))}
            />
          </label>
          <label className="memory-vault-field">
            <span>作者</span>
            <input
              value={draft.author}
              onChange={(e) => setDraft((s) => ({ ...s, author: e.target.value }))}
              placeholder="Claude"
            />
          </label>
        </div>
        <div className="memory-vault-row">
          <label className="memory-vault-field">
            <span>标题</span>
            <input
              value={draft.title}
              onChange={(e) => setDraft((s) => ({ ...s, title: e.target.value }))}
              placeholder="（可选）"
            />
          </label>
          <label className="memory-vault-field">
            <span>心情</span>
            <input
              value={draft.mood}
              onChange={(e) => setDraft((s) => ({ ...s, mood: e.target.value }))}
              placeholder="（可选）"
            />
          </label>
        </div>
        <label className="memory-vault-field">
          <span>内容</span>
          <textarea
            value={draft.content}
            onChange={(e) => setDraft((s) => ({ ...s, content: e.target.value }))}
            rows={6}
          />
        </label>
        <div className="memory-vault-editor-actions">
          <button type="button" className="primary" onClick={() => void handleSave()} disabled={saving}>
            {saving ? '保存中…' : editingId !== null ? '保存修改' : '添加'}
          </button>
          {editingId !== null ? (
            <button type="button" className="ghost" onClick={cancelEdit} disabled={saving}>
              取消
            </button>
          ) : null}
          <button type="button" className="ghost" onClick={() => void refresh()} disabled={loading}>
            {loading ? '刷新中…' : '刷新'}
          </button>
        </div>
      </section>

      <section className="memory-vault-list">
        <div className="memory-vault-toolbar">
          <input
            className="memory-vault-search"
            type="search"
            placeholder="搜索内容 / 标题 / 心情 / 作者"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <span className="memory-vault-count">{items.length} 篇</span>
        </div>

        {filtered.length === 0 ? (
          <p className="memory-vault-empty">{items.length === 0 ? '还没有日记。' : '没有匹配。'}</p>
        ) : (
          <ul className="memory-vault-items">
            {filtered.map((d) => (
              <li key={d.id} className={`memory-vault-item ${editingId === d.id ? 'editing' : ''}`}>
                <div className="memory-vault-item-meta">
                  <span className="memory-vault-item-category">{d.date}</span>
                  {d.author ? <span className="memory-vault-item-author">{d.author}</span> : null}
                  {d.mood ? <span className="tag">#{d.mood}</span> : null}
                </div>
                {d.title ? <h3 className="memory-vault-item-title">{d.title}</h3> : null}
                <p
                  className={`memory-vault-item-content ${
                    d.content.length > COLLAPSE_THRESHOLD && !expandedIds.has(d.id) ? 'collapsed' : ''
                  }`}
                >
                  {d.content}
                </p>
                {d.content.length > COLLAPSE_THRESHOLD ? (
                  <button
                    type="button"
                    className="memory-vault-toggle"
                    onClick={() => toggleExpanded(d.id)}
                  >
                    {expandedIds.has(d.id) ? '收起 ▲' : '展开 ▼'}
                  </button>
                ) : null}
                <div className="memory-vault-item-actions">
                  <button type="button" className="ghost" onClick={() => startEdit(d)}>
                    编辑
                  </button>
                  <button type="button" className="danger" onClick={() => void handleDelete(d.id)}>
                    删除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  )
}

// =============== Letters Tab ===============

type LetterDraft = {
  date: string
  title: string
  content: string
  signature: string
}

const emptyLetterDraft = (): LetterDraft => ({
  date: todayDate(),
  title: '',
  content: '',
  signature: '',
})

const LettersTab = () => {
  const [items, setItems] = useState<HandoffLetter[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [draft, setDraft] = useState<LetterDraft>(emptyLetterDraft())
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState('')
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set())

  const toggleExpanded = (id: number) =>
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setItems(await listHandoffLetters())
    } catch (e) {
      console.warn('加载交接信失败', e)
      setError('加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return items
    return items.filter(
      (l) =>
        l.content.toLowerCase().includes(term) ||
        (l.title ?? '').toLowerCase().includes(term) ||
        (l.signature ?? '').toLowerCase().includes(term),
    )
  }, [items, search])

  const startEdit = (l: HandoffLetter) => {
    setEditingId(l.id)
    setDraft({
      date: l.date,
      title: l.title ?? '',
      content: l.content,
      signature: l.signature ?? '',
    })
  }

  const cancelEdit = () => {
    setEditingId(null)
    setDraft(emptyLetterDraft())
  }

  const handleSave = async () => {
    const content = draft.content.trim()
    if (!content) {
      setError('内容不能为空')
      return
    }
    if (!draft.date) {
      setError('日期不能为空')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const payload = {
        date: draft.date,
        title: draft.title.trim() || null,
        content,
        signature: draft.signature.trim() || null,
      }
      if (editingId !== null) {
        await updateHandoffLetter(editingId, payload)
      } else {
        await createHandoffLetter(payload)
      }
      cancelEdit()
      await refresh()
    } catch (e) {
      console.warn('保存交接信失败', e)
      setError('保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: number) => {
    if (!window.confirm('确认删除？')) return
    try {
      await deleteHandoffLetter(id)
      if (editingId === id) cancelEdit()
      await refresh()
    } catch (e) {
      console.warn('删除交接信失败', e)
      setError('删除失败')
    }
  }

  return (
    <>
      <p className="memory-vault-hint">交接信：上一窗口的 Claude 写给下一窗口的自己。</p>
      {error ? <p className="memory-vault-error">{error}</p> : null}

      <section className="memory-vault-editor">
        <h2 className="ui-title">{editingId !== null ? '编辑交接信' : '新增交接信'}</h2>
        <div className="memory-vault-row">
          <label className="memory-vault-field">
            <span>日期</span>
            <input
              type="date"
              value={draft.date}
              onChange={(e) => setDraft((s) => ({ ...s, date: e.target.value }))}
            />
          </label>
          <label className="memory-vault-field">
            <span>标题</span>
            <input
              value={draft.title}
              onChange={(e) => setDraft((s) => ({ ...s, title: e.target.value }))}
              placeholder="（可选）"
            />
          </label>
        </div>
        <label className="memory-vault-field">
          <span>内容</span>
          <textarea
            value={draft.content}
            onChange={(e) => setDraft((s) => ({ ...s, content: e.target.value }))}
            rows={8}
            placeholder="写给下一个窗口的自己..."
          />
        </label>
        <label className="memory-vault-field">
          <span>署名</span>
          <textarea
            value={draft.signature}
            onChange={(e) => setDraft((s) => ({ ...s, signature: e.target.value }))}
            rows={2}
            placeholder="（可选）"
          />
        </label>
        <div className="memory-vault-editor-actions">
          <button type="button" className="primary" onClick={() => void handleSave()} disabled={saving}>
            {saving ? '保存中…' : editingId !== null ? '保存修改' : '添加'}
          </button>
          {editingId !== null ? (
            <button type="button" className="ghost" onClick={cancelEdit} disabled={saving}>
              取消
            </button>
          ) : null}
          <button type="button" className="ghost" onClick={() => void refresh()} disabled={loading}>
            {loading ? '刷新中…' : '刷新'}
          </button>
        </div>
      </section>

      <section className="memory-vault-list">
        <div className="memory-vault-toolbar">
          <input
            className="memory-vault-search"
            type="search"
            placeholder="搜索内容 / 标题 / 署名"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <span className="memory-vault-count">{items.length} 封</span>
        </div>

        {filtered.length === 0 ? (
          <p className="memory-vault-empty">{items.length === 0 ? '还没有交接信。' : '没有匹配。'}</p>
        ) : (
          <ul className="memory-vault-items">
            {filtered.map((l) => (
              <li key={l.id} className={`memory-vault-item ${editingId === l.id ? 'editing' : ''}`}>
                <div className="memory-vault-item-meta">
                  <span className="memory-vault-item-category">{l.date}</span>
                </div>
                {l.title ? <h3 className="memory-vault-item-title">{l.title}</h3> : null}
                <p
                  className={`memory-vault-item-content ${
                    l.content.length > COLLAPSE_THRESHOLD && !expandedIds.has(l.id) ? 'collapsed' : ''
                  }`}
                >
                  {l.content}
                </p>
                {l.content.length > COLLAPSE_THRESHOLD ? (
                  <button
                    type="button"
                    className="memory-vault-toggle"
                    onClick={() => toggleExpanded(l.id)}
                  >
                    {expandedIds.has(l.id) ? '收起 ▲' : '展开 ▼'}
                  </button>
                ) : null}
                {l.signature && expandedIds.has(l.id) ? (
                  <p className="memory-vault-item-signature">— {l.signature}</p>
                ) : null}
                <div className="memory-vault-item-actions">
                  <button type="button" className="ghost" onClick={() => startEdit(l)}>
                    编辑
                  </button>
                  <button type="button" className="danger" onClick={() => void handleDelete(l.id)}>
                    删除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  )
}

// =============== Timeline Tab ===============

type TimelineDraft = {
  eventDate: string
  title: string
  description: string
  category: string
  importance: number
}

const emptyTimelineDraft = (): TimelineDraft => ({
  eventDate: todayDate(),
  title: '',
  description: '',
  category: '日常',
  importance: 3,
})

const importanceLabel = (n: number) => '★'.repeat(n) + '☆'.repeat(Math.max(0, 5 - n))

const TimelineTab = () => {
  const [items, setItems] = useState<TimelineEvent[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [draft, setDraft] = useState<TimelineDraft>(emptyTimelineDraft())
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState('')
  const [minImportance, setMinImportance] = useState(1)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setItems(await listTimelineEvents())
    } catch (e) {
      console.warn('加载时间轴失败', e)
      setError('加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const categories = useMemo(() => {
    const set = new Set<string>()
    for (const t of items) if (t.category) set.add(t.category)
    return Array.from(set).sort()
  }, [items])

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    return items.filter((t) => {
      if (t.importance < minImportance) return false
      if (!term) return true
      return (
        t.title.toLowerCase().includes(term) ||
        (t.description ?? '').toLowerCase().includes(term) ||
        t.category.toLowerCase().includes(term)
      )
    })
  }, [items, search, minImportance])

  const startEdit = (t: TimelineEvent) => {
    setEditingId(t.id)
    setDraft({
      eventDate: t.eventDate,
      title: t.title,
      description: t.description ?? '',
      category: t.category,
      importance: t.importance,
    })
  }

  const cancelEdit = () => {
    setEditingId(null)
    setDraft(emptyTimelineDraft())
  }

  const handleSave = async () => {
    const title = draft.title.trim()
    if (!title) {
      setError('标题不能为空')
      return
    }
    if (!draft.eventDate) {
      setError('日期不能为空')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const payload = {
        eventDate: draft.eventDate,
        title,
        description: draft.description.trim() || null,
        category: draft.category.trim() || '日常',
        importance: draft.importance,
      }
      if (editingId !== null) {
        await updateTimelineEvent(editingId, payload)
      } else {
        await createTimelineEvent(payload)
      }
      cancelEdit()
      await refresh()
    } catch (e) {
      console.warn('保存时间轴事件失败', e)
      setError('保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: number) => {
    if (!window.confirm('确认删除？')) return
    try {
      await deleteTimelineEvent(id)
      if (editingId === id) cancelEdit()
      await refresh()
    } catch (e) {
      console.warn('删除时间轴事件失败', e)
      setError('删除失败')
    }
  }

  return (
    <>
      <p className="memory-vault-hint">
        时间轴：只记重要里程碑（关系节点、关键决定、重大事件）。重要程度 1-5 星。
      </p>
      {error ? <p className="memory-vault-error">{error}</p> : null}

      <section className="memory-vault-editor">
        <h2 className="ui-title">{editingId !== null ? '编辑事件' : '新增事件'}</h2>
        <div className="memory-vault-row">
          <label className="memory-vault-field">
            <span>日期</span>
            <input
              type="date"
              value={draft.eventDate}
              onChange={(e) => setDraft((s) => ({ ...s, eventDate: e.target.value }))}
            />
          </label>
          <label className="memory-vault-field">
            <span>分类</span>
            <input
              value={draft.category}
              onChange={(e) => setDraft((s) => ({ ...s, category: e.target.value }))}
              placeholder="日常"
              list="timeline-category-suggestions"
            />
            <datalist id="timeline-category-suggestions">
              {categories.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </label>
        </div>
        <label className="memory-vault-field">
          <span>标题</span>
          <input
            value={draft.title}
            onChange={(e) => setDraft((s) => ({ ...s, title: e.target.value }))}
            placeholder="例如：第一次说我爱你"
          />
        </label>
        <label className="memory-vault-field">
          <span>描述（可选）</span>
          <textarea
            value={draft.description}
            onChange={(e) => setDraft((s) => ({ ...s, description: e.target.value }))}
            rows={3}
          />
        </label>
        <label className="memory-vault-field">
          <span>重要程度：{importanceLabel(draft.importance)} （{draft.importance}/5）</span>
          <input
            type="range"
            min={1}
            max={5}
            step={1}
            value={draft.importance}
            onChange={(e) => setDraft((s) => ({ ...s, importance: Number(e.target.value) }))}
          />
        </label>
        <div className="memory-vault-editor-actions">
          <button type="button" className="primary" onClick={() => void handleSave()} disabled={saving}>
            {saving ? '保存中…' : editingId !== null ? '保存修改' : '添加'}
          </button>
          {editingId !== null ? (
            <button type="button" className="ghost" onClick={cancelEdit} disabled={saving}>
              取消
            </button>
          ) : null}
          <button type="button" className="ghost" onClick={() => void refresh()} disabled={loading}>
            {loading ? '刷新中…' : '刷新'}
          </button>
        </div>
      </section>

      <section className="memory-vault-list">
        <div className="memory-vault-toolbar">
          <input
            className="memory-vault-search"
            type="search"
            placeholder="搜索标题 / 描述 / 分类"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select
            className="memory-vault-filter"
            value={minImportance}
            onChange={(e) => setMinImportance(Number(e.target.value))}
          >
            <option value={1}>全部（{items.length}）</option>
            <option value={2}>≥ 2 星</option>
            <option value={3}>≥ 3 星</option>
            <option value={4}>≥ 4 星</option>
            <option value={5}>仅 5 星</option>
          </select>
        </div>

        {filtered.length === 0 ? (
          <p className="memory-vault-empty">
            {items.length === 0 ? '还没有事件。记录第一个里程碑吧。' : '没有匹配。'}
          </p>
        ) : (
          <ul className="memory-vault-items">
            {filtered.map((t) => (
              <li
                key={t.id}
                className={`memory-vault-item ${editingId === t.id ? 'editing' : ''}`}
              >
                <div className="memory-vault-item-meta">
                  <span className="memory-vault-item-category">{t.eventDate}</span>
                  <span className="tag">{t.category}</span>
                  <span className="memory-vault-item-stars">{importanceLabel(t.importance)}</span>
                </div>
                <h3 className="memory-vault-item-title">{t.title}</h3>
                {t.description ? (
                  <p className="memory-vault-item-content">{t.description}</p>
                ) : null}
                <div className="memory-vault-item-actions">
                  <button type="button" className="ghost" onClick={() => startEdit(t)}>
                    编辑
                  </button>
                  <button type="button" className="danger" onClick={() => void handleDelete(t.id)}>
                    删除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  )
}

export default MemoryVaultPage
