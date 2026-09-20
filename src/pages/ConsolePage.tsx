import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { vfetch, isVpsConfigured } from '../storage/vpsConfig'
import { getAssistantName } from '../storage/assistantPersona'
import './ConsolePage.css'

type SystemStatus = {
  cpu: { model: string; cores: number; loadAvg: number[] }
  memory: { total: number; free: number; usedPercent: string }
  disk: { total: string; used: string; available: string; usePercent: string }
  os: { hostname: string; uptime: number }
  services: { name: string; status: string; cpu: number; memory: number }[]
}

type OpLogEntry = {
  id: string
  time: string
  action: string
  level: string
  detail?: string
  status?: string
  error?: string
}

type PendingOp = {
  id: string
  action: string
  level: string
  detail: string
  status: string
  approvals: { user: boolean; wren: boolean }
  created: string
}

type GitCommit = { hash: string; message: string; date: string; author: string }

type McpServer = {
  id: string
  name: string
  type: 'stdio' | 'sse'
  command: string | null
  url: string | null
  args: string[]
  env: Record<string, string>
  description: string
  enabled: boolean
  running: boolean
  pid: number | null
  created: string
}

const levelTag = (level: string) => {
  if (level === 'green') return 'READ'
  if (level === 'yellow') return 'WRITE'
  return 'DANGER'
}

const levelClass = (level: string) => `console-tag console-tag--${level}`

const fmtUptime = (s: number) => {
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

const fmtTime = (iso: string) => {
  try {
    return new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
  } catch { return iso }
}

const fmtTimeShort = (iso: string) => {
  try {
    return new Date(iso).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, hour: '2-digit', minute: '2-digit' })
  } catch { return iso }
}

const ACTION_LABELS: Record<string, string> = {
  exec: '执行命令',
  exec_async: '后台任务',
  file_read: '读取文件',
  file_write: '写入文件',
  git_status: 'Git 状态查询',
  git_log: 'Git 日志',
  git_push: 'Git 推送',
  db_query: '数据库查询',
  browser_fetch: '浏览网页',
  llm_call: '子模型调用',
  schedule_create: '创建定时任务',
  schedule_fire: '定时触发',
  schedule_delete: '删除定时任务',
  journal_write: '写入日记',
  journal_read: '读取日记',
  notify_send: '发送通知',
  approve: '审批通过',
  reject: '审批拒绝',
  pending_write: '待审批操作',
  mcp_add: '添加 MCP 服务',
  mcp_remove: '移除 MCP 服务',
  mcp_start: '启动 MCP',
  mcp_stop: '停止 MCP',
  mcp_call: 'MCP 调用',
}
const actionLabel = (action: string) => ACTION_LABELS[action] || action

type CatId = 'all' | 'GIT' | 'DB' | 'WEB' | 'FILE' | 'MCP' | 'AUTH' | 'SYS'

type TabId = 'logs' | 'approvals' | 'db' | 'git' | 'browser' | 'mcp'

const NAV: { key: TabId; icon: string; label: string }[] = [
  { key: 'logs', icon: '📋', label: 'Logs' },
  { key: 'approvals', icon: '🔐', label: 'Approvals' },
  { key: 'db', icon: '🗄', label: 'Database' },
  { key: 'git', icon: '🔀', label: 'Git' },
  { key: 'browser', icon: '🌐', label: 'Browser' },
  { key: 'mcp', icon: '🔌', label: 'MCP' },
]

export default function ConsolePage() {
  const navigate = useNavigate()
  const [status, setStatus] = useState<SystemStatus | null>(null)
  const [logs, setLogs] = useState<OpLogEntry[]>([])
  const [pending, setPending] = useState<PendingOp[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<TabId>('logs')
  const [drawerOpen, setDrawerOpen] = useState(false)

  const [sqlInput, setSqlInput] = useState('')
  const [sqlResult, setSqlResult] = useState<any>(null)
  const [sqlError, setSqlError] = useState('')
  const [sqlRunning, setSqlRunning] = useState(false)

  const [gitStatus, setGitStatus] = useState('')
  const [gitLog, setGitLog] = useState<GitCommit[]>([])
  const [gitLoading, setGitLoading] = useState(false)

  const [browserUrl, setBrowserUrl] = useState('')
  const [browserResult, setBrowserResult] = useState<{ url: string; title: string; text?: string } | null>(null)
  const [browserLoading, setBrowserLoading] = useState(false)
  const [browserError, setBrowserError] = useState('')

  const [mcpServers, setMcpServers] = useState<McpServer[]>([])
  const [mcpLoading, setMcpLoading] = useState(false)
  const [mcpShowAdd, setMcpShowAdd] = useState(false)
  const [mcpForm, setMcpForm] = useState({ name: '', type: 'stdio' as 'stdio' | 'sse', command: '', url: '', description: '' })

  const [catFilter, setCatFilter] = useState<CatId>('all')
  const configured = isVpsConfigured()
  const assistantName = getAssistantName()


  const pick = (key: TabId) => {
    setTab(key)
    setDrawerOpen(false)
  }

  const fetchAll = useCallback(async () => {
    if (!configured) return
    setLoading(true)
    setError('')
    try {
      const [sRes, lRes, pRes] = await Promise.all([
        vfetch('/api/status'),
        vfetch('/api/logs?limit=100'),
        vfetch('/api/ops/pending'),
      ])
      if (!sRes.ok) {
        const txt = await sRes.text().catch(() => '')
        setError(`API ${sRes.status}: ${txt.slice(0, 120) || sRes.statusText}`)
        return
      }
      setStatus(await sRes.json())
      if (lRes.ok) setLogs((await lRes.json()).reverse())
      if (pRes.ok) setPending(await pRes.json())
    } catch (e: any) {
      setError(e.message || 'Connection failed')
    } finally {
      setLoading(false)
    }
  }, [configured])

  useEffect(() => { fetchAll() }, [fetchAll])

  useEffect(() => {
    if (!configured) return
    const iv = setInterval(fetchAll, 30_000)
    return () => clearInterval(iv)
  }, [configured, fetchAll])

  useEffect(() => {
    const handler = (e: Event) => {
      if (drawerOpen) { setDrawerOpen(false); e.preventDefault() }
    }
    window.addEventListener('nimbus:backbutton', handler)
    return () => window.removeEventListener('nimbus:backbutton', handler)
  }, [drawerOpen])

  const handleApprove = async (id: string) => {
    try {
      await vfetch('/api/ops/approve', {
        method: 'POST',
        body: JSON.stringify({ id, approver: 'user' }),
      })
      fetchAll()
    } catch {}
  }

  const handleReject = async (id: string) => {
    try {
      await vfetch('/api/ops/reject', {
        method: 'POST',
        body: JSON.stringify({ id, reason: 'user rejected' }),
      })
      fetchAll()
    } catch {}
  }

  const runSql = async () => {
    if (!sqlInput.trim()) return
    setSqlRunning(true)
    setSqlError('')
    setSqlResult(null)
    try {
      const res = await vfetch('/api/db/query', {
        method: 'POST',
        body: JSON.stringify({ sql: sqlInput.trim() }),
      })
      const data = await res.json()
      if (!res.ok) {
        setSqlError(data.error || `Error ${res.status}`)
      } else if (data.pending) {
        setSqlError('Sent to approval queue (red-level operation)')
      } else {
        setSqlResult(data)
      }
    } catch (e: any) {
      setSqlError(e.message || 'Query failed')
    } finally {
      setSqlRunning(false)
    }
  }

  const fetchGit = async () => {
    setGitLoading(true)
    try {
      const [sRes, lRes] = await Promise.all([
        vfetch('/api/git/status'),
        vfetch('/api/git/log'),
      ])
      if (sRes.ok) {
        const d = await sRes.json()
        setGitStatus(d.output || d.status || JSON.stringify(d))
      }
      if (lRes.ok) {
        const d = await lRes.json()
        setGitLog(Array.isArray(d) ? d : d.commits || [])
      }
    } catch {}
    setGitLoading(false)
  }

  useEffect(() => {
    if (tab === 'git' && configured) fetchGit()
  }, [tab, configured])

  const fetchBrowser = async () => {
    if (!browserUrl.trim()) return
    setBrowserLoading(true)
    setBrowserError('')
    setBrowserResult(null)
    try {
      const res = await vfetch('/api/browser/fetch', {
        method: 'POST',
        body: JSON.stringify({ url: browserUrl.trim(), extractText: true }),
      })
      const data = await res.json()
      if (!res.ok) {
        setBrowserError(data.error || `Error ${res.status}`)
      } else {
        setBrowserResult(data)
      }
    } catch (e: any) {
      setBrowserError(e.message || 'Fetch failed')
    } finally {
      setBrowserLoading(false)
    }
  }

  const fetchMcpList = async () => {
    setMcpLoading(true)
    try {
      const res = await vfetch('/api/mcp/list')
      if (res.ok) setMcpServers(await res.json())
    } catch {}
    setMcpLoading(false)
  }

  useEffect(() => {
    if (tab === 'mcp' && configured) fetchMcpList()
  }, [tab, configured])

  const addMcpServer = async () => {
    if (!mcpForm.name.trim()) return
    try {
      const res = await vfetch('/api/mcp/add', {
        method: 'POST',
        body: JSON.stringify({
          name: mcpForm.name,
          type: mcpForm.type,
          command: mcpForm.type === 'stdio' ? mcpForm.command : undefined,
          url: mcpForm.type === 'sse' ? mcpForm.url : undefined,
          description: mcpForm.description,
        }),
      })
      if (res.ok) {
        setMcpShowAdd(false)
        setMcpForm({ name: '', type: 'stdio', command: '', url: '', description: '' })
        fetchMcpList()
      }
    } catch {}
  }

  const removeMcpServer = async (id: string) => {
    try {
      await vfetch('/api/mcp/remove', { method: 'POST', body: JSON.stringify({ id }) })
      fetchMcpList()
    } catch {}
  }

  const toggleMcpServer = async (id: string, start: boolean) => {
    try {
      await vfetch(`/api/mcp/${start ? 'start' : 'stop'}`, { method: 'POST', body: JSON.stringify({ id }) })
      fetchMcpList()
    } catch {}
  }

  const actionCat = (action: string) => {
    if (/git/i.test(action)) return 'GIT'
    if (/db|sql|query/i.test(action)) return 'DB'
    if (/browser|fetch/i.test(action)) return 'WEB'
    if (/file/i.test(action)) return 'FILE'
    if (/mcp/i.test(action)) return 'MCP'
    if (/approv|reject/i.test(action)) return 'AUTH'
    return 'SYS'
  }


  if (!configured) {
    return (
      <div className="console-page">
        <header className="page-header-bar">
          <button type="button" className="page-back-btn" onClick={() => navigate(-1)}>‹</button>
          <h1 className="ui-title">Console</h1>
          <span className="page-header-spacer" aria-hidden="true" />
        </header>
        <div className="console-empty">
          <p>VPS Not Configured</p>
          <p className="console-empty-sub">Go to Settings &rarr; VPS to set URL and API Key</p>
          <button type="button" className="console-btn" onClick={() => navigate('/settings')}>Settings</button>
        </div>
      </div>
    )
  }

  return (
    <div className="console-page">
      <header className="page-header-bar">
        <button type="button" className="page-back-btn" onClick={() => navigate(-1)}>✕</button>
        <h1 className="ui-title">{assistantName}操作台</h1>
        <div className="console-header-actions">
          <button type="button" className="console-refresh" onClick={fetchAll} disabled={loading}>
            {loading ? '…' : '↻'}
          </button>
          <button
            type="button"
            className="console-menu-btn"
            aria-label="Switch section"
            onClick={() => setDrawerOpen((v) => !v)}
          >
            ☰
          </button>
        </div>
      </header>

      {/* Drawer sidebar */}
      <div
        className={`console-scrim ${drawerOpen ? 'open' : ''}`}
        onClick={() => setDrawerOpen(false)}
        aria-hidden="true"
      />
      <nav className={`console-drawer ${drawerOpen ? 'open' : ''}`} aria-label="Console sections">
        <div className="console-drawer-head">CONSOLE</div>
        {NAV.map((n) => (
          <button
            key={n.key}
            type="button"
            className={`console-drawer-item ${tab === n.key ? 'active' : ''}`}
            onClick={() => pick(n.key)}
          >
            <span className="console-drawer-ic" aria-hidden="true">{n.icon}</span>
            {n.label}
            {n.key === 'approvals' && pending.length > 0 && (
              <span className="console-badge">{pending.length}</span>
            )}
          </button>
        ))}
      </nav>

      {error && <div className="console-error">{error}</div>}

      {tab === 'logs' && (
        <div className="console-section">
          {/* Compact system status bar */}
          {status && (
            <div className="console-status-bar">
              <span className="console-dot console-dot--on" />
              <span className="console-status-label">Online</span>
              <span className="console-status-host">{status.os.hostname}</span>
              <span className="console-status-metrics">
                CPU {status.cpu.loadAvg[0]?.toFixed(1)} · Mem {status.memory.usedPercent} · Disk {status.disk.usePercent} · Up {fmtUptime(status.os.uptime)}
              </span>
            </div>
          )}

          {/* Section header + filter */}
          <div className="console-section-header">
            <h2 className="console-section-title">操作日志</h2>
            <button
              type="button"
              className="console-filter-btn"
              onClick={() => setCatFilter(catFilter === 'all' ? 'all' : 'all')}
            >
              筛选
            </button>
          </div>

          {/* Category filter chips */}
          <div className="console-filter-chips">
            {(['all', 'GIT', 'DB', 'FILE', 'WEB', 'SYS'] as CatId[]).map((c) => (
              <button
                key={c}
                type="button"
                className={`console-chip ${catFilter === c ? 'console-chip--active' : ''}`}
                onClick={() => setCatFilter(c)}
              >
                {c === 'all' ? '全部' : c}
              </button>
            ))}
          </div>

          {/* Log cards */}
          {logs.length === 0 && <p className="console-empty-sub">暂无日志</p>}
          {logs
            .filter((l) => catFilter === 'all' || actionCat(l.action) === catFilter)
            .map((log) => {
            const cat = actionCat(log.action)
            return (
              <div key={log.id} className={`clog-card clog-card--${cat.toLowerCase()}`}>
                <div className="clog-head">
                  <span className={`clog-cat clog-cat--${cat.toLowerCase()}`}>{cat}</span>
                  <span className={`clog-status ${log.error ? 'clog-status--fail' : 'clog-status--ok'}`}>
                    {log.error ? '失败' : '成功'}
                  </span>
                  <span className="clog-time">{fmtTimeShort(log.time)}</span>
                </div>
                <p className="clog-title">{actionLabel(log.action)}</p>
                {log.detail && <pre className="clog-code">{log.detail}</pre>}
                {log.error && <p className="clog-err">{log.error}</p>}
              </div>
            )
          })}
        </div>
      )}

      {tab === 'approvals' && (
        <div className="console-section">
          {pending.length === 0 && <p className="console-empty-sub">No pending approvals</p>}
          {pending.map((op) => (
            <div key={op.id} className="console-approval-card">
              <div className="console-approval-header">
                <span className={levelClass(op.level)}>{levelTag(op.level)}</span>
                <span className="console-approval-action">{op.action}</span>
                <span className="console-log-time">{fmtTime(op.created)}</span>
              </div>
              <p className="console-approval-detail">{op.detail}</p>
              <div className="console-approval-status">
                <span>Wren {op.approvals.wren ? '✅' : '⏳'}</span>
                <span>You {op.approvals.user ? '✅' : '⏳'}</span>
              </div>
              {!op.approvals.user && (
                <div className="console-approval-actions">
                  <button type="button" className="console-btn console-btn--approve" onClick={() => handleApprove(op.id)}>Approve</button>
                  <button type="button" className="console-btn console-btn--reject" onClick={() => handleReject(op.id)}>Reject</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === 'db' && (
        <div className="console-section">
          <div className="console-card">
            <h3 className="console-card-title">SQL Query</h3>
            <textarea
              className="console-sql-input"
              rows={4}
              placeholder="SELECT * FROM messages LIMIT 10;"
              value={sqlInput}
              onChange={(e) => setSqlInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) runSql() }}
            />
            <div className="console-sql-actions">
              <button type="button" className="console-btn" onClick={runSql} disabled={sqlRunning}>
                {sqlRunning ? 'Running…' : 'Execute'}
              </button>
              <span className="console-sql-hint">Ctrl+Enter to run</span>
            </div>
          </div>

          {sqlError && <div className="console-error">{sqlError}</div>}

          {sqlResult && (
            <div className="console-card">
              <h3 className="console-card-title">
                Result ({Array.isArray(sqlResult.rows) ? sqlResult.rows.length : '?'} rows)
              </h3>
              <div className="console-table-wrap">
                {Array.isArray(sqlResult.rows) && sqlResult.rows.length > 0 ? (
                  <table className="console-table">
                    <thead>
                      <tr>
                        {Object.keys(sqlResult.rows[0]).map((k) => (
                          <th key={k}>{k}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sqlResult.rows.map((row: any, i: number) => (
                        <tr key={i}>
                          {Object.values(row).map((v: any, j: number) => (
                            <td key={j}>{v === null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v)}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="console-empty-sub">No rows returned</p>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {tab === 'git' && (
        <div className="console-section">
          <div className="console-card">
            <div className="console-card-header-row">
              <h3 className="console-card-title">Git Status</h3>
              <button type="button" className="console-refresh-sm" onClick={fetchGit} disabled={gitLoading}>
                {gitLoading ? '…' : '↻'}
              </button>
            </div>
            <pre className="console-pre">{gitStatus || 'Loading…'}</pre>
          </div>

          {gitLog.length > 0 && (
            <div className="console-card">
              <h3 className="console-card-title">Recent Commits</h3>
              {gitLog.slice(0, 20).map((c) => (
                <div key={c.hash} className="console-commit-row">
                  <code className="console-commit-hash">{c.hash?.slice(0, 7)}</code>
                  <span className="console-commit-msg">{c.message}</span>
                  <span className="console-log-time">{c.date}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'browser' && (
        <div className="console-section">
          <div className="console-card">
            <h3 className="console-card-title">Headless Browser</h3>
            <p className="console-card-desc">Fetch any web page via the VPS headless browser. Also available as a tool for the AI companion.</p>
            <div className="console-browser-row">
              <input
                className="console-browser-input"
                type="url"
                placeholder="https://example.com"
                value={browserUrl}
                onChange={(e) => setBrowserUrl(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') fetchBrowser() }}
              />
              <button type="button" className="console-btn" onClick={fetchBrowser} disabled={browserLoading}>
                {browserLoading ? 'Fetching…' : 'Fetch'}
              </button>
            </div>
          </div>

          {browserError && <div className="console-error">{browserError}</div>}

          {browserResult && (
            <div className="console-card">
              <h3 className="console-card-title">{browserResult.title || 'Result'}</h3>
              <p className="console-browser-url">{browserResult.url}</p>
              {browserResult.text && (
                <pre className="console-pre console-browser-text">{browserResult.text}</pre>
              )}
            </div>
          )}
        </div>
      )}

      {tab === 'mcp' && (
        <div className="console-section">
          <div className="console-card">
            <div className="console-card-header-row">
              <h3 className="console-card-title">MCP Servers</h3>
              <div className="console-header-actions">
                <button type="button" className="console-refresh-sm" onClick={fetchMcpList} disabled={mcpLoading}>
                  {mcpLoading ? '…' : '↻'}
                </button>
                <button type="button" className="console-btn console-btn--sm" onClick={() => setMcpShowAdd((v) => !v)}>
                  {mcpShowAdd ? 'Cancel' : '+ Add'}
                </button>
              </div>
            </div>

            {mcpShowAdd && (
              <div className="console-mcp-form">
                <input
                  className="console-mcp-input"
                  placeholder="Server name"
                  value={mcpForm.name}
                  onChange={(e) => setMcpForm((f) => ({ ...f, name: e.target.value }))}
                />
                <div className="console-mcp-type-row">
                  <label className={`console-mcp-type ${mcpForm.type === 'stdio' ? 'active' : ''}`}>
                    <input type="radio" name="mcp-type" value="stdio" checked={mcpForm.type === 'stdio'} onChange={() => setMcpForm((f) => ({ ...f, type: 'stdio' }))} />
                    Stdio
                  </label>
                  <label className={`console-mcp-type ${mcpForm.type === 'sse' ? 'active' : ''}`}>
                    <input type="radio" name="mcp-type" value="sse" checked={mcpForm.type === 'sse'} onChange={() => setMcpForm((f) => ({ ...f, type: 'sse' }))} />
                    SSE
                  </label>
                </div>
                {mcpForm.type === 'stdio' ? (
                  <input
                    className="console-mcp-input"
                    placeholder="Command (e.g. npx -y @mcp/server-fs /home)"
                    value={mcpForm.command}
                    onChange={(e) => setMcpForm((f) => ({ ...f, command: e.target.value }))}
                  />
                ) : (
                  <input
                    className="console-mcp-input"
                    placeholder="Server URL (e.g. http://localhost:8080/sse)"
                    value={mcpForm.url}
                    onChange={(e) => setMcpForm((f) => ({ ...f, url: e.target.value }))}
                  />
                )}
                <input
                  className="console-mcp-input"
                  placeholder="Description (optional)"
                  value={mcpForm.description}
                  onChange={(e) => setMcpForm((f) => ({ ...f, description: e.target.value }))}
                />
                <button type="button" className="console-btn" onClick={addMcpServer}>Add Server</button>
              </div>
            )}
          </div>

          {mcpServers.length === 0 && !mcpShowAdd && (
            <p className="console-empty-sub">No MCP servers configured</p>
          )}

          {mcpServers.map((srv) => (
            <div key={srv.id} className="console-card console-mcp-card">
              <div className="console-mcp-header">
                <span className={`console-dot ${srv.running ? 'console-dot--on' : 'console-dot--off'}`} />
                <span className="console-mcp-name">{srv.name}</span>
                <span className="console-mcp-type-badge">{srv.type.toUpperCase()}</span>
              </div>
              {srv.description && <p className="console-mcp-desc">{srv.description}</p>}
              <p className="console-mcp-detail">
                {srv.type === 'stdio' ? srv.command : srv.url}
              </p>
              <div className="console-mcp-actions">
                {srv.type === 'stdio' && (
                  <button
                    type="button"
                    className={`console-btn console-btn--sm ${srv.running ? 'console-btn--reject' : 'console-btn--approve'}`}
                    onClick={() => toggleMcpServer(srv.id, !srv.running)}
                  >
                    {srv.running ? 'Stop' : 'Start'}
                  </button>
                )}
                <button
                  type="button"
                  className="console-btn console-btn--sm console-btn--reject"
                  onClick={() => removeMcpServer(srv.id)}
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
