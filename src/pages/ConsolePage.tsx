import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { vfetch, isVpsConfigured } from '../storage/vpsConfig'
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

const fmtBytes = (b: number) => {
  if (b > 1e9) return (b / 1e9).toFixed(1) + ' GB'
  if (b > 1e6) return (b / 1e6).toFixed(0) + ' MB'
  return (b / 1e3).toFixed(0) + ' KB'
}

const fmtTime = (iso: string) => {
  try {
    return new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
  } catch { return iso }
}

type TabId = 'status' | 'logs' | 'approvals' | 'db' | 'git'

const NAV: { key: TabId; icon: string; label: string }[] = [
  { key: 'status', icon: '📊', label: 'Status' },
  { key: 'logs', icon: '📋', label: 'Logs' },
  { key: 'approvals', icon: '🔐', label: 'Approvals' },
  { key: 'db', icon: '🗄', label: 'Database' },
  { key: 'git', icon: '🔀', label: 'Git' },
]

export default function ConsolePage() {
  const navigate = useNavigate()
  const [status, setStatus] = useState<SystemStatus | null>(null)
  const [logs, setLogs] = useState<OpLogEntry[]>([])
  const [pending, setPending] = useState<PendingOp[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<TabId>('status')
  const [drawerOpen, setDrawerOpen] = useState(false)

  const [sqlInput, setSqlInput] = useState('')
  const [sqlResult, setSqlResult] = useState<any>(null)
  const [sqlError, setSqlError] = useState('')
  const [sqlRunning, setSqlRunning] = useState(false)

  const [gitStatus, setGitStatus] = useState('')
  const [gitLog, setGitLog] = useState<GitCommit[]>([])
  const [gitLoading, setGitLoading] = useState(false)

  const configured = isVpsConfigured()

  const activeNav = NAV.find((n) => n.key === tab) ?? NAV[0]

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
        <button type="button" className="page-back-btn" onClick={() => navigate(-1)}>‹</button>
        <h1 className="ui-title">{activeNav.label}</h1>
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

      {tab === 'status' && status && (
        <div className="console-section">
          <div className="console-tiles">
            <div className="console-tile">
              <span className="console-tile-label">CPU</span>
              <span className="console-tile-value">{status.cpu.cores} Cores</span>
              <span className="console-tile-sub">Load {status.cpu.loadAvg[0]?.toFixed(2)}</span>
            </div>
            <div className="console-tile">
              <span className="console-tile-label">Memory</span>
              <span className="console-tile-value">{status.memory.usedPercent}</span>
              <span className="console-tile-sub">{fmtBytes(status.memory.free)} free</span>
            </div>
            <div className="console-tile">
              <span className="console-tile-label">Disk</span>
              <span className="console-tile-value">{status.disk.usePercent || '—'}</span>
              <span className="console-tile-sub">{status.disk.available || '—'} avail</span>
            </div>
            <div className="console-tile">
              <span className="console-tile-label">Uptime</span>
              <span className="console-tile-value">{fmtUptime(status.os.uptime)}</span>
              <span className="console-tile-sub">{status.os.hostname}</span>
            </div>
          </div>

          {status.services.length > 0 && (
            <div className="console-card">
              <h3 className="console-card-title">Services</h3>
              {status.services.map((svc) => (
                <div key={svc.name} className="console-svc-row">
                  <span className={`console-dot ${svc.status === 'online' ? 'console-dot--on' : 'console-dot--off'}`} />
                  <span className="console-svc-name">{svc.name}</span>
                  <span className="console-svc-meta">CPU {svc.cpu}% · {fmtBytes(svc.memory || 0)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'logs' && (
        <div className="console-section">
          {logs.length === 0 && <p className="console-empty-sub">No logs yet</p>}
          {logs.map((log) => (
            <div key={log.id} className="console-log-row">
              <span className={levelClass(log.level)}>{levelTag(log.level)}</span>
              <span className="console-log-action">{log.action}</span>
              {log.detail && <span className="console-log-detail">{log.detail.slice(0, 80)}</span>}
              <span className="console-log-time">{fmtTime(log.time)}</span>
            </div>
          ))}
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
    </div>
  )
}
