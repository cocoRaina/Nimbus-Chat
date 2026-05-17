import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Memory } from '../types'
import {
  createMemory,
  deleteMemory,
  listMemories,
  updateMemory,
} from '../storage/supabaseSync'
import './MemoryVaultPage.css'

const DEFAULT_CATEGORY = '日常'
const ALL_CATEGORY = '__all__'

const parseTagsInput = (raw: string): string[] => {
  return raw
    .split(/[,，;；\n]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
}

const stringifyTags = (tags: string[]) => tags.join('、')

type DraftState = {
  content: string
  category: string
  tagsInput: string
}

const emptyDraft = (): DraftState => ({
  content: '',
  category: DEFAULT_CATEGORY,
  tagsInput: '',
})

const MemoryVaultPage = () => {
  const navigate = useNavigate()
  const [memories, setMemories] = useState<Memory[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [draft, setDraft] = useState<DraftState>(emptyDraft())
  const [saving, setSaving] = useState(false)
  const [filterCategory, setFilterCategory] = useState<string>(ALL_CATEGORY)
  const [searchTerm, setSearchTerm] = useState('')

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const rows = await listMemories()
      setMemories(rows)
    } catch (loadError) {
      console.warn('加载记忆失败', loadError)
      setError('加载失败，请检查网络或登录状态')
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
    return memories.filter((memory) => {
      if (filterCategory !== ALL_CATEGORY && memory.category !== filterCategory) return false
      if (!term) return true
      if (memory.content.toLowerCase().includes(term)) return true
      if (memory.tags.some((tag) => tag.toLowerCase().includes(term))) return true
      return false
    })
  }, [memories, filterCategory, searchTerm])

  const startNew = () => {
    setEditingId(null)
    setDraft(emptyDraft())
  }

  const startEdit = (memory: Memory) => {
    setEditingId(memory.id)
    setDraft({
      content: memory.content,
      category: memory.category,
      tagsInput: stringifyTags(memory.tags),
    })
  }

  const cancelEdit = () => {
    setEditingId(null)
    setDraft(emptyDraft())
  }

  const handleSave = async () => {
    const content = draft.content.trim()
    if (!content) {
      setError('记忆内容不能为空')
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
      setError('保存失败，请稍后重试')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: number) => {
    if (!window.confirm('确认删除这条记忆？')) return
    try {
      await deleteMemory(id)
      if (editingId === id) cancelEdit()
      await refresh()
    } catch (deleteError) {
      console.warn('删除记忆失败', deleteError)
      setError('删除失败，请稍后重试')
    }
  }

  return (
    <main className="memory-vault-page app-shell">
      <header className="memory-vault-header">
        <button type="button" className="ghost back" onClick={() => navigate(-1)}>
          ← 返回
        </button>
        <h1 className="ui-title">记忆库</h1>
        <button type="button" className="ghost" onClick={() => void refresh()} disabled={loading}>
          {loading ? '刷新中…' : '刷新'}
        </button>
      </header>

      <p className="memory-vault-hint">
        这里写下的记忆会自动生成向量 embedding，AI 在聊天时可以语义检索。
      </p>

      {error ? <p className="memory-vault-error">{error}</p> : null}

      <section className="memory-vault-editor">
        <h2 className="ui-title">{editingId !== null ? '编辑记忆' : '新增记忆'}</h2>
        <label className="memory-vault-field">
          <span>内容</span>
          <textarea
            value={draft.content}
            onChange={(event) => setDraft((s) => ({ ...s, content: event.target.value }))}
            placeholder="写一条值得 AI 记住的事..."
            rows={4}
          />
        </label>
        <div className="memory-vault-row">
          <label className="memory-vault-field">
            <span>分类</span>
            <input
              type="text"
              value={draft.category}
              onChange={(event) => setDraft((s) => ({ ...s, category: event.target.value }))}
              placeholder={DEFAULT_CATEGORY}
              list="memory-category-suggestions"
            />
            <datalist id="memory-category-suggestions">
              {categories.map((category) => (
                <option key={category} value={category} />
              ))}
            </datalist>
          </label>
          <label className="memory-vault-field">
            <span>标签（逗号/分号分隔）</span>
            <input
              type="text"
              value={draft.tagsInput}
              onChange={(event) => setDraft((s) => ({ ...s, tagsInput: event.target.value }))}
              placeholder="例如：偏好, 食物, 健康"
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
          ) : (
            <button type="button" className="ghost" onClick={startNew} disabled={saving}>
              清空
            </button>
          )}
        </div>
      </section>

      <section className="memory-vault-list">
        <div className="memory-vault-toolbar">
          <input
            className="memory-vault-search"
            type="search"
            placeholder="搜索内容 / 标签"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
          />
          <select
            className="memory-vault-filter"
            value={filterCategory}
            onChange={(event) => setFilterCategory(event.target.value)}
          >
            <option value={ALL_CATEGORY}>全部分类（{memories.length}）</option>
            {categories.map((category) => (
              <option key={category} value={category}>
                {category}（{memories.filter((m) => m.category === category).length}）
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
              <li key={memory.id} className={`memory-vault-item ${editingId === memory.id ? 'editing' : ''}`}>
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
    </main>
  )
}

export default MemoryVaultPage
