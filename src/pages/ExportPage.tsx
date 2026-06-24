import { useMemo, useState } from 'react'
import type { User } from '@supabase/supabase-js'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../supabase/client'
import './ExportPage.css'

type ExportFormat = 'markdown' | 'json' | 'txt'
type ExportModules = {
  chat: boolean
  snacks: boolean
  syzygy: boolean
  memory: boolean
  checkins: boolean
}

type SessionRow = {
  id: string
  title: string
  created_at: string
  updated_at: string
  is_archived: boolean | null
}

type MessageRow = {
  id: string
  session_id: string
  role: 'user' | 'assistant'
  content: string
  created_at: string
  client_created_at: string | null
}

type SnackPostRow = {
  id: string
  content: string
  created_at: string
  updated_at: string
  is_deleted: boolean
}

type SnackReplyRow = {
  id: string
  post_id: string
  role: 'user' | 'assistant'
  content: string
  created_at: string
  is_deleted: boolean
}

type SyzygyPostRow = {
  id: string
  content: string
  created_at: string
  updated_at: string
  is_deleted: boolean
}

type SyzygyReplyRow = {
  id: string
  post_id: string
  author_role: 'user' | 'ai'
  content: string
  created_at: string
  is_deleted: boolean
}

type MemoryRow = {
  id: number
  category: string
  content: string
  tags: string[] | null
  created_at: string
  updated_at: string
}

type CheckinRow = {
  id: string
  checkin_date: string
  created_at: string
}

type ExportDataBundle = {
  sessions: SessionRow[]
  messages: MessageRow[]
  snackPosts: SnackPostRow[]
  snackReplies: SnackReplyRow[]
  syzygyPosts: SyzygyPostRow[]
  syzygyReplies: SyzygyReplyRow[]
  memoryEntries: MemoryRow[]
  checkins: CheckinRow[]
}

const formatOptions: Array<{ value: ExportFormat; label: string }> = [
  { value: 'markdown', label: 'Markdown (.md)' },
  { value: 'json', label: 'JSON (.json)' },
  { value: 'txt', label: 'TXT (.txt)' },
]

const defaultModules: ExportModules = {
  chat: true,
  snacks: true,
  syzygy: true,
  memory: true,
  checkins: true,
}

const MESSAGE_BATCH_SIZE = 1000
const MESSAGE_CAP = 10000

const toDateKey = (date: Date) => {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

const shiftDate = (dateKey: string, daysDelta: number) => {
  const base = new Date(`${dateKey}T00:00:00`)
  base.setDate(base.getDate() + daysDelta)
  return toDateKey(base)
}

const computeStreak = (checkins: CheckinRow[]) => {
  const today = toDateKey(new Date())
  const uniqueDates = Array.from(new Set(checkins.map((entry) => entry.checkin_date))).sort((a, b) => b.localeCompare(a))
  const dateSet = new Set(uniqueDates)
  const startDate = dateSet.has(today) ? today : shiftDate(today, -1)
  if (!dateSet.has(startDate)) {
    return 0
  }
  let streak = 0
  let cursor = startDate
  while (dateSet.has(cursor)) {
    streak += 1
    cursor = shiftDate(cursor, -1)
  }
  return streak
}

const safeMarkdownText = (value: string) => value.replaceAll('```', '\\`\\`\\`')

const formatDownloadStamp = (value: Date) => {
  const year = value.getFullYear()
  const month = `${value.getMonth() + 1}`.padStart(2, '0')
  const day = `${value.getDate()}`.padStart(2, '0')
  const hour = `${value.getHours()}`.padStart(2, '0')
  const minute = `${value.getMinutes()}`.padStart(2, '0')
  return `${year}${month}${day}-${hour}${minute}`
}

const renderMarkdown = (
  exportedAtIso: string,
  modules: ExportModules,
  data: ExportDataBundle,
) => {
  const lines: string[] = ['# Nimbus Chat Export', `- Exported at: ${exportedAtIso}`, '- Version: 1', '']

  if (modules.chat) {
    lines.push('## Chat')
    const sessions = [...data.sessions].sort((a, b) => a.created_at.localeCompare(b.created_at))
    const messagesBySession = new Map<string, MessageRow[]>()
    data.messages.forEach((message) => {
      const list = messagesBySession.get(message.session_id) ?? []
      list.push(message)
      messagesBySession.set(message.session_id, list)
    })
    sessions.forEach((session) => {
      lines.push(`### Session: ${safeMarkdownText(session.title)} (${session.id})`)
      lines.push(`- Created: ${session.created_at}  Updated: ${session.updated_at}  Status: ${session.is_archived ? 'archived' : 'active'}`)
      lines.push('---')
      const messages = (messagesBySession.get(session.id) ?? []).sort((a, b) => {
        const first = a.client_created_at ?? a.created_at
        const second = b.client_created_at ?? b.created_at
        return first.localeCompare(second)
      })
      messages.forEach((message) => {
        const timestamp = message.client_created_at ?? message.created_at
        lines.push(`[${timestamp}] **${message.role}**: ${safeMarkdownText(message.content)}`)
      })
      lines.push('')
    })
    if (sessions.length === 0) {
      lines.push('No sessions', '')
    }
  }

  if (modules.snacks) {
    lines.push('## My Posts')
    const repliesByPost = new Map<string, SnackReplyRow[]>()
    data.snackReplies.forEach((reply) => {
      const list = repliesByPost.get(reply.post_id) ?? []
      list.push(reply)
      repliesByPost.set(reply.post_id, list)
    })
    data.snackPosts.forEach((post) => {
      lines.push(`### Post ${post.id}  ${post.created_at}  (deleted: ${post.is_deleted ? 'yes' : 'no'})`)
      lines.push(safeMarkdownText(post.content), '#### Replies')
      const replies = (repliesByPost.get(post.id) ?? []).sort((a, b) => a.created_at.localeCompare(b.created_at))
      replies.forEach((reply) => {
        lines.push(`- [${reply.created_at}] (${reply.role}) ${safeMarkdownText(reply.content)}`)
      })
      if (replies.length === 0) {
        lines.push('- (no replies)')
      }
      lines.push('')
    })
    if (data.snackPosts.length === 0) {
      lines.push('No posts', '')
    }
  }

  if (modules.syzygy) {
    lines.push("## Claude's Posts")
    const repliesByPost = new Map<string, SyzygyReplyRow[]>()
    data.syzygyReplies.forEach((reply) => {
      const list = repliesByPost.get(reply.post_id) ?? []
      list.push(reply)
      repliesByPost.set(reply.post_id, list)
    })
    data.syzygyPosts.forEach((post) => {
      lines.push(`### Post ${post.id}  ${post.created_at}  (deleted: ${post.is_deleted ? 'yes' : 'no'})`)
      lines.push(safeMarkdownText(post.content), '#### Replies')
      const replies = (repliesByPost.get(post.id) ?? []).sort((a, b) => a.created_at.localeCompare(b.created_at))
      replies.forEach((reply) => {
        lines.push(`- [${reply.created_at}] (${reply.author_role}) ${safeMarkdownText(reply.content)}`)
      })
      if (replies.length === 0) {
        lines.push('- (no replies)')
      }
      lines.push('')
    })
    if (data.syzygyPosts.length === 0) {
      lines.push('No Claude posts', '')
    }
  }

  if (modules.memory) {
    lines.push('## Memory')
    const byCategory = new Map<string, MemoryRow[]>()
    data.memoryEntries.forEach((entry) => {
      const cat = entry.category || 'Uncategorized'
      const list = byCategory.get(cat) ?? []
      list.push(entry)
      byCategory.set(cat, list)
    })
    if (byCategory.size === 0) {
      lines.push('- (empty)')
    }
    for (const [category, entries] of byCategory.entries()) {
      lines.push(`### ${category}`)
      entries.forEach((entry) => {
        const tags = entry.tags && entry.tags.length > 0 ? ` [${entry.tags.join(', ')}]` : ''
        lines.push(`- ${entry.created_at}${tags} ${safeMarkdownText(entry.content)}`)
      })
    }
    lines.push('')
  }

  if (modules.checkins) {
    lines.push('## Check-ins')
    const sortedCheckins = [...data.checkins].sort((a, b) => b.checkin_date.localeCompare(a.checkin_date))
    lines.push(`- Streak: ${computeStreak(sortedCheckins)}`)
    lines.push('- Records:')
    sortedCheckins.forEach((item) => {
      lines.push(`  - ${item.checkin_date}`)
    })
    if (sortedCheckins.length === 0) {
      lines.push('  - (empty)')
    }
    lines.push('')
  }

  return lines.join('\n')
}

const ExportPage = ({ user }: { user: User | null }) => {
  const navigate = useNavigate()
  const [format, setFormat] = useState<ExportFormat>('markdown')
  const [modules, setModules] = useState<ExportModules>(defaultModules)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)

  const selectedCount = useMemo(() => Object.values(modules).filter(Boolean).length, [modules])

  const toggleModule = (key: keyof ExportModules) => {
    setModules((current) => ({ ...current, [key]: !current[key] }))
  }

  const fetchMessagesWithCap = async (userId: string) => {
    if (!supabase) {
      return { rows: [] as MessageRow[], reachedCap: false }
    }
    const rows: MessageRow[] = []
    let offset = 0

    while (rows.length < MESSAGE_CAP) {
      const end = Math.min(offset + MESSAGE_BATCH_SIZE - 1, MESSAGE_CAP - 1)
      const { data, error: loadError } = await supabase
        .from('messages')
        .select('id,session_id,role,content,created_at,client_created_at')
        .eq('user_id', userId)
        .order('client_created_at', { ascending: true })
        .order('created_at', { ascending: true })
        .range(offset, end)

      if (loadError) {
        throw loadError
      }
      const batch = (data ?? []) as MessageRow[]
      rows.push(...batch)
      if (batch.length < MESSAGE_BATCH_SIZE) {
        break
      }
      offset += MESSAGE_BATCH_SIZE
    }

    return { rows, reachedCap: rows.length >= MESSAGE_CAP }
  }

  const handleExport = async () => {
    if (!user || !supabase || selectedCount === 0) {
      return
    }

    setExporting(true)
    setError(null)
    setWarning(null)

    try {
      const exportedAt = new Date()
      const exportedAtIso = exportedAt.toISOString()
      const baseData: ExportDataBundle = {
        sessions: [],
        messages: [],
        snackPosts: [],
        snackReplies: [],
        syzygyPosts: [],
        syzygyReplies: [],
        memoryEntries: [],
        checkins: [],
      }

      if (modules.chat) {
        const { data: sessionsData, error: sessionError } = await supabase
          .from('sessions')
          .select('id,title,created_at,updated_at,is_archived')
          .eq('user_id', user.id)
          .order('created_at', { ascending: true })
        if (sessionError) {
          throw sessionError
        }
        baseData.sessions = (sessionsData ?? []) as SessionRow[]

        const messageResult = await fetchMessagesWithCap(user.id)
        baseData.messages = messageResult.rows
        if (messageResult.reachedCap) {
          setWarning(`Messages exceed ${MESSAGE_CAP} records, truncated to ${MESSAGE_CAP}.`)
        }
      }

      if (modules.snacks) {
        const [{ data: snackPosts, error: snackPostError }, { data: snackReplies, error: snackReplyError }] = await Promise.all([
          supabase
            .from('user_posts')
            .select('id,content,created_at,updated_at,is_deleted')
            .eq('user_id', user.id)
            .order('created_at', { ascending: false }),
          supabase
            .from('user_replies')
            .select('id,post_id,role,content,created_at,is_deleted')
            .eq('user_id', user.id)
            .order('created_at', { ascending: true }),
        ])
        if (snackPostError || snackReplyError) {
          throw snackPostError ?? snackReplyError
        }
        baseData.snackPosts = (snackPosts ?? []) as SnackPostRow[]
        baseData.snackReplies = (snackReplies ?? []) as SnackReplyRow[]
      }

      if (modules.syzygy) {
        const [{ data: syzygyPosts, error: syzygyPostError }, { data: syzygyReplies, error: syzygyReplyError }] = await Promise.all([
          supabase
            .from('assistant_posts')
            .select('id,content,created_at,updated_at,is_deleted')
            .eq('user_id', user.id)
            .order('created_at', { ascending: false }),
          supabase
            .from('assistant_replies')
            .select('id,post_id,author_role,content,created_at,is_deleted')
            .eq('user_id', user.id)
            .order('created_at', { ascending: true }),
        ])
        if (syzygyPostError || syzygyReplyError) {
          throw syzygyPostError ?? syzygyReplyError
        }
        baseData.syzygyPosts = (syzygyPosts ?? []) as SyzygyPostRow[]
        baseData.syzygyReplies = (syzygyReplies ?? []) as SyzygyReplyRow[]
      }

      if (modules.memory) {
        const { data: memoryRows, error: memoryError } = await supabase
          .from('memories')
          .select('id,category,content,tags,created_at,updated_at')
          .order('created_at', { ascending: false })
        if (memoryError) {
          throw memoryError
        }
        baseData.memoryEntries = (memoryRows ?? []) as MemoryRow[]
      }

      if (modules.checkins) {
        const { data: checkinRows, error: checkinError } = await supabase
          .from('checkins')
          .select('id,checkin_date,created_at')
          .eq('user_id', user.id)
          .order('checkin_date', { ascending: false })
        if (checkinError) {
          throw checkinError
        }
        baseData.checkins = (checkinRows ?? []) as CheckinRow[]
      }

      let fileContent = ''
      let extension = 'md'
      if (format === 'json') {
        extension = 'json'
        fileContent = JSON.stringify(
          {
            meta: { exportedAt: exportedAtIso, version: 1, format: 'content-only' },
            data: baseData,
          },
          null,
          2,
        )
      } else {
        fileContent = renderMarkdown(exportedAtIso, modules, baseData)
        extension = format === 'txt' ? 'txt' : 'md'
      }

      const filename = `hamster-nest-export-${formatDownloadStamp(exportedAt)}.${extension}`
      const blob = new Blob([fileContent], {
        type: format === 'json' ? 'application/json;charset=utf-8' : 'text/plain;charset=utf-8',
      })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = filename
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
    } catch (exportError) {
      console.warn('导出失败', exportError)
      setError('Export failed. Please try again.')
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="export-page">
      <header className="export-header">
        <button type="button" className="ghost" onClick={() => navigate(-1)}>
          Back
        </button>
        <h1 className="ui-title">Export</h1>
        <button type="button" className="ghost" onClick={() => navigate('/')}>
          Chat
        </button>
      </header>

      <section className="export-card export-package-card">
        <span className="export-washi-tape" aria-hidden="true" />
        <h2 className="ui-title">My Data 📦</h2>

        <div className="export-subsection">
          <h3>Format</h3>
          <div className="export-format-stickers" role="radiogroup" aria-label="Export format">
            {formatOptions.map((option) => {
              const isActive = format === option.value
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={isActive}
                  className={`export-sticker ${isActive ? 'active' : ''}`}
                  onClick={() => setFormat(option.value)}
                >
                  {isActive ? '✔ ' : ''}
                  {option.label}
                </button>
              )
            })}
          </div>
        </div>

        <div className="export-subsection">
          <h3>Modules</h3>
          <label>
            <input type="checkbox" checked={modules.chat} onChange={() => toggleModule('chat')} />
            Chat
          </label>
          <label>
            <input type="checkbox" checked={modules.snacks} onChange={() => toggleModule('snacks')} />
            My Posts
          </label>
          <label>
            <input type="checkbox" checked={modules.syzygy} onChange={() => toggleModule('syzygy')} />
            {"Claude's Posts"}
          </label>
          <label>
            <input type="checkbox" checked={modules.memory} onChange={() => toggleModule('memory')} />
            Memory
          </label>
          <label>
            <input type="checkbox" checked={modules.checkins} onChange={() => toggleModule('checkins')} />
            Check-ins
          </label>
        </div>

        <p className="export-note">Pack multiple modules at once — downloads automatically.</p>
        <p className="export-signoff">Your memories are safely packed.</p>

        {warning ? <p className="tips">{warning}</p> : null}
        {error ? <p className="error">{error}</p> : null}

        <button
          type="button"
          className="export-button"
          disabled={!user || !supabase || selectedCount === 0 || exporting}
          onClick={() => void handleExport()}
        >
          {exporting ? 'Packing…' : 'Pack My Hoard 📥✨'}
        </button>
      </section>

      <p className="export-attribution">Built by Wren and Claude</p>
    </div>
  )
}

export default ExportPage
