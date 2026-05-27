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
  add_timeline_event: '📍',
  run_code: '🧪',
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
  add_timeline_event: '加时间轴',
  run_code: '运行代码',
}

function extractPreview(name: string, args: Record<string, unknown>): string {
  if (name === 'search_memory' || name === 'search_handoff' || name === 'web_search') {
    return typeof args?.query === 'string' ? args.query : ''
  }
  if (name === 'add_memory') {
    const c = typeof args?.content === 'string' ? args.content : ''
    return c.length > 30 ? c.slice(0, 30) + '…' : c
  }
  if (name === 'schedule_proactive_message') {
    return `${args?.delay_minutes ?? '?'}min`
  }
  if (name === 'write_diary') {
    return typeof args?.date === 'string' ? args.date : ''
  }
  return ''
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

const ToolCallCard = memo(function ToolCallCard({ name, args, result, duration_ms }: ToolCallRecord) {
  const [expanded, setExpanded] = useState(false)
  const preview = extractPreview(name, (args ?? {}) as Record<string, unknown>)

  return (
    <div className="tool-call-card">
      <button
        type="button"
        className="tool-call-header"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="tool-icon">{TOOL_ICONS[name] ?? '🔧'}</span>
        <span className="tool-label">{TOOL_LABELS[name] ?? name}</span>
        {preview ? <span className="tool-preview">{preview}</span> : null}
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

export default ToolCallCard
export type { ToolCallRecord }
