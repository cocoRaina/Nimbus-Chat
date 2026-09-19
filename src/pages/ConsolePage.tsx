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

export default function ConsolePage() {
  const navigate = useNavigate()
  const [status, setStatus] = useState<SystemStatus | null>(null)
  const [logs, setLogs] = useState<OpLogEntry[]>([])
  const [pending, setPending] = useState<PendingOp[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<'status' | 'logs' | 'approvals'>('status')

  const configured = isVpsConfigured()

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
        setError(`状态接口 ${sRes.status}: ${txt.slice(0, 120) || sRes.statusText}`)
        return
      }
      setStatus(await sRes.json())
      if (lRes.ok) setLogs((await lRes.json()).reverse())
      if (pRes.ok) setPending(await pRes.json())
    } catch (e: any) {
      setError(e.message || '连接失败')
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
        body: JSON.stringify({ id, reason: '用户拒绝' }),
      })
      fetchAll()
    } catch {}
  }

  if (!configured) {
    return (
      <div className="console-page">
        <header className="console-header">
          <button type="button" className="console-back" onClick={() => navigate(-1)}>←</button>
          <h1 className="console-title">Console</h1>
        </header>
        <div className="console-empty">
          <p>VPS Not Configured</p>
          <p className="console-empty-sub">Go to Settings → VPS to set URL and API Key</p>
          <button type="button" className="console-btn" onClick={() => navigate('/settings')}>Settings</button>
        </div>
      </div>
    )
  }

  return (
    <div className="console-page">
      <header className="console-header">
        <button type="button" className="console-back" onClick={() => navigate(-1)}>←</button>
        <h1 className="console-title">Console</h1>
        <button type="button" className="console-refresh" onClick={fetchAll} disabled={loading}>
          {loading ? '…' : '↻'}
        </button>
      </header>

      {error && <div className="console-error">{error}</div>}

      <nav className="console-tabs">
        <button type="button" className={`console-tab ${tab === 'status' ? 'is-active' : ''}`} onClick={() => setTab('status')}>Status</button>
        <button type="button" className={`console-tab ${tab === 'logs' ? 'is-active' : ''}`} onClick={() => setTab('logs')}>
          Logs
        </button>
        <button type="button" className={`console-tab ${tab === 'approvals' ? 'is-active' : ''}`} onClick={() => setTab('approvals')}>
          Approvals{pending.length > 0 && <span className="console-badge">{pending.length}</span>}
        </button>
      </nav>

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
                <span>小机 {op.approvals.wren ? '✅' : '⏳'}</span>
                <span>你 {op.approvals.user ? '✅' : '⏳'}</span>
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
    </div>
  )
}
