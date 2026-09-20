import { memo, useState } from 'react'
import './ToolCallCard.css'

type ToolCallRecord = {
  name: string
  args: unknown
  result: unknown
  duration_ms?: number
}

const TOOL_ICONS: Record<string, string> = {
  search_memory: '🔍',
  search_handoff: '📜',
  web_search: '🌐',
  add_memory: '📝',
  write_diary: '📔',
  write_handoff_letter: '✉️',
  schedule_proactive_message: '⏰',
  log_health: '💗',
  log_period: '🩸',
  delete_period: '🗑️',
  write_essay: '✍️',
  read_essays: '📖',
  set_essay_lock: '🔒',
  search_4o_archive: '📼',
  add_timeline_event: '📍',
  run_code: '🧪',
  post_moment: '🫧',
  browse_moments: '👀',
  reply_moment: '💬',
  search_chat_history: '🗂',
  // ── Agent / VPS tools (小机 的"手") ──
  vps_status: '🖥',
  vps_exec: '⚡',
  vps_exec_async: '🚀',
  vps_service_restart: '♻️',
  vps_file_read: '📄',
  vps_file_write: '💾',
  vps_code_search: '🔎',
  vps_code_find: '🗂',
  vps_code_edit: '✏️',
  vps_git_status: '🔀',
  vps_exec_sql: '🗄',
  vps_browse: '🌐',
  vps_llm_call: '🤖',
  vps_task_status: '📋',
  vps_task_kill: '🛑',
}

const TOOL_LABELS: Record<string, string> = {
  search_memory: '搜索记忆',
  search_handoff: '搜交接信',
  web_search: '联网搜索',
  add_memory: '记下来',
  write_diary: '写日记',
  write_handoff_letter: '写交接信',
  schedule_proactive_message: '预约主动消息',
  log_health: '记录健康',
  log_period: '记录经期',
  delete_period: '删经期记录',
  write_essay: '写随笔',
  read_essays: '翻随笔',
  set_essay_lock: '设随笔锁',
  search_4o_archive: '翻和4o的旧对话',
  add_timeline_event: '加时间轴',
  run_code: '运行代码',
  post_moment: '发 Moment',
  browse_moments: '翻 Moments',
  reply_moment: '回 Moment',
  search_chat_history: '搜聊天原文',
  // ── Agent / VPS tools ──
  vps_status: '服务器状态',
  vps_exec: '执行命令',
  vps_exec_async: '后台任务',
  vps_service_restart: '重启服务',
  vps_file_read: '读文件',
  vps_file_write: '写文件',
  vps_code_search: '搜代码',
  vps_code_find: '找文件',
  vps_code_edit: '改代码',
  vps_git_status: 'Git 状态',
  vps_exec_sql: '数据库查询',
  vps_browse: '浏览网页',
  vps_llm_call: '子模型调用',
  vps_task_status: '任务状态',
  vps_task_kill: '停止任务',
}

function extractPreview(name: string, args: Record<string, unknown>): string {
  if (name === 'search_memory' || name === 'search_handoff' || name === 'web_search' || name === 'search_4o_archive') {
    return typeof args?.query === 'string' ? args.query : ''
  }
  if (name === 'search_chat_history') {
    return Array.isArray(args?.keywords) ? (args.keywords as string[]).join(' ') : ''
  }
  if (name === 'add_memory' || name === 'post_moment' || name === 'reply_moment') {
    const c = typeof args?.content === 'string' ? args.content : ''
    return c.length > 30 ? c.slice(0, 30) + '…' : c
  }
  if (name === 'schedule_proactive_message') {
    return `${args?.delay_minutes ?? '?'}min`
  }
  if (name === 'write_diary') {
    return typeof args?.date === 'string' ? args.date : ''
  }
  if (name === 'log_period' || name === 'delete_period') {
    return typeof args?.start_date === 'string' ? args.start_date : ''
  }
  if (name === 'write_essay') {
    return typeof args?.title === 'string' ? args.title : ''
  }
  if (name === 'read_essays') {
    return (typeof args?.topic === 'string' ? args.topic : '') || (typeof args?.query === 'string' ? args.query : '')
  }
  // Agent / VPS tools: show the command / file / pattern being acted on.
  if (name === 'vps_exec' || name === 'vps_exec_async') {
    const c = typeof args?.command === 'string' ? args.command : ''
    return c.length > 48 ? c.slice(0, 48) + '…' : c
  }
  if (name === 'vps_file_read' || name === 'vps_file_write' || name === 'vps_code_edit') {
    return typeof args?.filePath === 'string' ? args.filePath : ''
  }
  if (name === 'vps_code_search' || name === 'vps_code_find') {
    return typeof args?.pattern === 'string' ? args.pattern : ''
  }
  if (name === 'vps_exec_sql') {
    const s = typeof args?.sql === 'string' ? args.sql : ''
    return s.length > 48 ? s.slice(0, 48) + '…' : s
  }
  if (name === 'vps_browse') {
    return typeof args?.url === 'string' ? args.url : ''
  }
  if (name === 'vps_service_restart') {
    return typeof args?.name === 'string' ? args.name : 'nimbus-api'
  }
  return ''
}

// Compact one-glance outcome badge for agent tools (like Claude Code's ✓/exit).
function resultBadge(result: unknown): { text: string; kind: 'ok' | 'fail' | 'info' } | null {
  let r: any = result
  if (typeof r === 'string') { try { r = JSON.parse(r) } catch { return null } }
  if (!r || typeof r !== 'object') return null
  if (r.needs_approval || r.pending) return { text: '待审批', kind: 'info' }
  if (typeof r.exit_code === 'number') {
    return r.exit_code === 0 ? { text: '✓ 0', kind: 'ok' } : { text: `✗ ${r.exit_code}`, kind: 'fail' }
  }
  if (r.error) return { text: '✗ 出错', kind: 'fail' }
  if (r.ok === true) return { text: '✓', kind: 'ok' }
  if (r.ok === false) return { text: '✗', kind: 'fail' }
  return null
}

function formatResult(result: unknown): string {
  if (typeof result === 'string') {
    try {
      return JSON.stringify(JSON.parse(result), null, 2)
    } catch {
      return result
    }
  }
  return JSON.stringify(result, null, 2)
}

const ToolCallCard = memo(function ToolCallCard({
  name, args, result, duration_ms, nested,
}: ToolCallRecord & { nested?: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const preview = extractPreview(name, (args ?? {}) as Record<string, unknown>)
  const badge = resultBadge(result)

  return (
    <div className={nested ? 'tool-call-card tool-call-card--nested' : 'tool-call-card'}>
      <button
        type="button"
        className="tool-call-header"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="tool-icon">{TOOL_ICONS[name] ?? '🔧'}</span>
        <span className="tool-label">{TOOL_LABELS[name] ?? name}</span>
        {preview ? <span className="tool-preview">{preview}</span> : null}
        {badge ? <span className={`tool-badge tool-badge--${badge.kind}`}>{badge.text}</span> : null}
        {duration_ms ? <span className="tool-duration">{duration_ms}ms</span> : null}
        <span className="tool-chevron">{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded ? (
        <div className="tool-call-body">
          <div className="tool-section">
            <div className="tool-section-label">参数</div>
            <pre>{JSON.stringify(args, null, 2)}</pre>
          </div>
          <div className="tool-section">
            <div className="tool-section-label">结果</div>
            <pre>{formatResult(result)}</pre>
          </div>
        </div>
      ) : null}
    </div>
  )
})

// Groups consecutive same-name tool calls into one collapsible card.
const ToolCallGroup = memo(function ToolCallGroup({ calls }: { calls: ToolCallRecord[] }) {
  const [expanded, setExpanded] = useState(false)

  if (calls.length === 1) {
    return <ToolCallCard {...calls[0]} />
  }

  const { name } = calls[0]
  const icon = TOOL_ICONS[name] ?? '🔧'
  const label = TOOL_LABELS[name] ?? name
  const totalMs = calls.reduce((s, c) => s + (c.duration_ms ?? 0), 0)

  return (
    <div className="tool-call-card">
      <button
        type="button"
        className="tool-call-header"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="tool-icon">{icon}</span>
        <span className="tool-label">{label}</span>
        <span className="tool-preview tool-count">×{calls.length}</span>
        {totalMs ? <span className="tool-duration">{totalMs}ms</span> : null}
        <span className="tool-chevron">{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded ? (
        <div className="tool-call-body tool-group-body">
          {calls.map((tc, i) => (
            <ToolCallCard key={i} {...tc} nested />
          ))}
        </div>
      ) : null}
    </div>
  )
})

// Groups consecutive same-name calls from a flat array.
function groupToolCalls(calls: ToolCallRecord[]): ToolCallRecord[][] {
  const groups: ToolCallRecord[][] = []
  for (const call of calls) {
    const last = groups[groups.length - 1]
    if (last && last[0].name === call.name) {
      last.push(call)
    } else {
      groups.push([call])
    }
  }
  return groups
}

export default ToolCallCard
export { ToolCallGroup, groupToolCalls }
export type { ToolCallRecord }
