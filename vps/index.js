const express = require('express')
const cors = require('cors')
const jwt = require('jsonwebtoken')
const { execSync, exec } = require('child_process')
const os = require('os')
const fs = require('fs')
const path = require('path')

// ── Load .env (no extra dep — just read it) ──────────────────────────
try {
  const envPath = path.join(__dirname, '.env')
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach((line) => {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) return
      const eq = trimmed.indexOf('=')
      if (eq < 0) return
      const key = trimmed.slice(0, eq).trim()
      const val = trimmed.slice(eq + 1).trim()
      if (!process.env[key]) process.env[key] = val
    })
  }
} catch {}

const app = express()
const PORT = parseInt(process.env.PORT || '3000', 10)

app.use(cors())
app.use(express.json({ limit: '2mb' }))

// ── Operation log (in-memory, persisted to disk) ─────────────────────
const OPS_LOG_PATH = path.join(__dirname, 'ops-log.json')
let opsLog = []
try {
  if (fs.existsSync(OPS_LOG_PATH)) {
    opsLog = JSON.parse(fs.readFileSync(OPS_LOG_PATH, 'utf8'))
  }
} catch {}

const saveOpsLog = () => {
  try { fs.writeFileSync(OPS_LOG_PATH, JSON.stringify(opsLog.slice(-500), null, 2)) } catch {}
}

const logOp = (op) => {
  const entry = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), time: new Date().toISOString(), ...op }
  opsLog.push(entry)
  saveOpsLog()
  return entry
}

// ── Pending operations (dual-approval queue) ─────────────────────────
const PENDING_PATH = path.join(__dirname, 'pending-ops.json')
let pendingOps = []
try {
  if (fs.existsSync(PENDING_PATH)) {
    pendingOps = JSON.parse(fs.readFileSync(PENDING_PATH, 'utf8'))
  }
} catch {}

const savePending = () => {
  try { fs.writeFileSync(PENDING_PATH, JSON.stringify(pendingOps, null, 2)) } catch {}
}

// ── Auth middleware ──────────────────────────────────────────────────
const authenticate = (req, res, next) => {
  const apiKey = req.headers['x-api-key']
  const authHeader = req.headers['authorization']

  if (apiKey && apiKey === process.env.NIMBUS_API_KEY) {
    req.authMethod = 'api-key'
    return next()
  }

  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7)
    try {
      const decoded = jwt.verify(token, process.env.SUPABASE_JWT_SECRET, { algorithms: ['HS256'] })
      req.user = decoded
      req.authMethod = 'jwt'
      return next()
    } catch {
      return res.status(401).json({ error: 'Invalid JWT' })
    }
  }

  return res.status(401).json({ error: 'Missing authentication' })
}

// ── Danger level classification ──────────────────────────────────────
const DANGER_LEVELS = {
  green: ['health', 'status', 'logs', 'query_readonly', 'git_status', 'git_log', 'file_read'],
  yellow: ['file_write', 'git_branch', 'git_commit', 'db_insert', 'config_update'],
  red: ['git_push', 'git_merge_pr', 'db_delete', 'db_migrate', 'service_restart', 'file_delete', 'deploy']
}

const getDangerLevel = (action) => {
  if (DANGER_LEVELS.green.includes(action)) return 'green'
  if (DANGER_LEVELS.yellow.includes(action)) return 'yellow'
  if (DANGER_LEVELS.red.includes(action)) return 'red'
  return 'red'
}

// ── Redact sensitive fields from DB results ──────────────────────────
const SENSITIVE_KEYS = ['api_key', 'password', 'secret', 'token', 'service_role', 'anon_key']
const redactRow = (row) => {
  if (!row || typeof row !== 'object') return row
  const out = {}
  for (const [k, v] of Object.entries(row)) {
    if (SENSITIVE_KEYS.some((s) => k.toLowerCase().includes(s))) {
      out[k] = '***REDACTED***'
    } else {
      out[k] = v
    }
  }
  return out
}

// ════════════════════════════════════════════════════════════════════════
//  ROUTES
// ════════════════════════════════════════════════════════════════════════

// ── Health (no auth) ─────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), uptime: process.uptime() })
})

// ── System status ────────────────────────────────────────────────────
app.get('/api/status', authenticate, (_req, res) => {
  const cpus = os.cpus()
  const totalMem = os.totalmem()
  const freeMem = os.freemem()
  let diskInfo = {}
  try {
    const df = execSync("df -h / | tail -1").toString().trim().split(/\s+/)
    diskInfo = { total: df[1], used: df[2], available: df[3], usePercent: df[4] }
  } catch {}

  let pm2List = []
  try {
    pm2List = JSON.parse(execSync('pm2 jlist 2>/dev/null').toString())
      .map((p) => ({ name: p.name, status: p.pm2_env?.status, cpu: p.monit?.cpu, memory: p.monit?.memory, uptime: p.pm2_env?.pm_uptime }))
  } catch {}

  logOp({ action: 'status', level: 'green', result: 'ok' })

  res.json({
    cpu: { model: cpus[0]?.model, cores: cpus.length, loadAvg: os.loadavg() },
    memory: { total: totalMem, free: freeMem, usedPercent: ((1 - freeMem / totalMem) * 100).toFixed(1) + '%' },
    disk: diskInfo,
    os: { platform: os.platform(), release: os.release(), hostname: os.hostname(), uptime: os.uptime() },
    services: pm2List
  })
})

// ── Logs ─────────────────────────────────────────────────────────────
app.get('/api/logs', authenticate, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200)
  const type = req.query.type
  let filtered = opsLog
  if (type) filtered = opsLog.filter((e) => e.action === type || e.level === type)
  res.json(filtered.slice(-limit))
})

// ── Database query (read-only, results redacted) ─────────────────────
app.post('/api/db/query', authenticate, async (req, res) => {
  const { sql } = req.body
  if (!sql) return res.status(400).json({ error: 'Missing sql' })

  const normalized = sql.trim().toLowerCase()
  const isWrite = /^(insert|update|delete|drop|alter|create|truncate)\b/.test(normalized)

  if (isWrite) {
    const level = getDangerLevel(normalized.startsWith('insert') ? 'db_insert' : 'db_delete')
    if (level === 'red') {
      const pending = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        action: 'db_write',
        level: 'red',
        detail: sql,
        status: 'pending',
        approvals: { user: false, wren: false },
        created: new Date().toISOString()
      }
      pendingOps.push(pending)
      savePending()
      logOp({ action: 'db_write', level: 'red', status: 'pending_approval', detail: sql.slice(0, 200) })
      return res.json({ pending: true, id: pending.id, message: '需要双签审批' })
    }
  }

  try {
    const resp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/exec_sql`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
      },
      body: JSON.stringify({ query: sql })
    })
    const data = await resp.json()
    const redacted = Array.isArray(data) ? data.map(redactRow) : data
    logOp({ action: isWrite ? 'db_write' : 'query_readonly', level: isWrite ? 'yellow' : 'green', detail: sql.slice(0, 200), rows: Array.isArray(data) ? data.length : 0 })
    res.json({ data: redacted })
  } catch (err) {
    logOp({ action: 'query_readonly', level: 'green', error: err.message })
    res.status(500).json({ error: err.message })
  }
})

// ── Git operations ───────────────────────────────────────────────────
const REPO_DIR = process.env.REPO_DIR || path.join(os.homedir(), 'Nimbus-Chat')

app.get('/api/git/status', authenticate, (_req, res) => {
  try {
    const status = execSync('git status --short', { cwd: REPO_DIR }).toString()
    const branch = execSync('git branch --show-current', { cwd: REPO_DIR }).toString().trim()
    const lastCommit = execSync('git log -1 --format="%h %s (%ar)"', { cwd: REPO_DIR }).toString().trim()
    logOp({ action: 'git_status', level: 'green' })
    res.json({ branch, lastCommit, changes: status || '(clean)' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/git/log', authenticate, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '20', 10), 100)
  try {
    const log = execSync(`git log -${limit} --format="%H|%h|%s|%an|%ar"`, { cwd: REPO_DIR }).toString()
    const commits = log.trim().split('\n').filter(Boolean).map((line) => {
      const [hash, short, subject, author, ago] = line.split('|')
      return { hash, short, subject, author, ago }
    })
    logOp({ action: 'git_log', level: 'green' })
    res.json(commits)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── File operations ──────────────────────────────────────────────────
app.post('/api/file/read', authenticate, (req, res) => {
  const { filePath } = req.body
  if (!filePath) return res.status(400).json({ error: 'Missing filePath' })
  const absPath = path.resolve(REPO_DIR, filePath)
  if (!absPath.startsWith(REPO_DIR)) return res.status(403).json({ error: 'Path outside repo' })
  try {
    const content = fs.readFileSync(absPath, 'utf8')
    logOp({ action: 'file_read', level: 'green', detail: filePath })
    res.json({ content, size: content.length })
  } catch (err) {
    res.status(404).json({ error: err.message })
  }
})

app.post('/api/file/write', authenticate, (req, res) => {
  const { filePath, content } = req.body
  if (!filePath || content === undefined) return res.status(400).json({ error: 'Missing filePath or content' })
  const absPath = path.resolve(REPO_DIR, filePath)
  if (!absPath.startsWith(REPO_DIR)) return res.status(403).json({ error: 'Path outside repo' })

  const pending = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    action: 'file_write',
    level: 'yellow',
    detail: `Write ${filePath} (${content.length} bytes)`,
    payload: { filePath, content },
    status: 'pending',
    approvals: { user: false, wren: false },
    created: new Date().toISOString()
  }
  pendingOps.push(pending)
  savePending()
  logOp({ action: 'file_write', level: 'yellow', status: 'pending_approval', detail: filePath })
  res.json({ pending: true, id: pending.id, message: '文件写入需要审批' })
})

// ── Pending operations / Approval ────────────────────────────────────
app.get('/api/ops/pending', authenticate, (_req, res) => {
  res.json(pendingOps.filter((op) => op.status === 'pending'))
})

app.post('/api/ops/approve', authenticate, (req, res) => {
  const { id, approver } = req.body
  if (!id || !approver) return res.status(400).json({ error: 'Missing id or approver' })
  if (!['user', 'wren'].includes(approver)) return res.status(400).json({ error: 'approver must be user or wren' })

  const op = pendingOps.find((o) => o.id === id)
  if (!op) return res.status(404).json({ error: 'Operation not found' })
  if (op.status !== 'pending') return res.status(400).json({ error: `Already ${op.status}` })

  op.approvals[approver] = true

  if (op.approvals.user && op.approvals.wren) {
    op.status = 'approved'
    executeApprovedOp(op)
  }

  savePending()
  logOp({ action: 'approve', level: 'green', detail: `${approver} approved ${id}`, opStatus: op.status })
  res.json(op)
})

app.post('/api/ops/reject', authenticate, (req, res) => {
  const { id, reason } = req.body
  const op = pendingOps.find((o) => o.id === id)
  if (!op) return res.status(404).json({ error: 'Operation not found' })
  op.status = 'rejected'
  op.rejectReason = reason || ''
  savePending()
  logOp({ action: 'reject', level: 'green', detail: `rejected ${id}: ${reason}` })
  res.json(op)
})

// ── Execute approved operation ───────────────────────────────────────
const executeApprovedOp = (op) => {
  try {
    switch (op.action) {
      case 'file_write': {
        const { filePath, content } = op.payload
        const absPath = path.resolve(REPO_DIR, filePath)
        fs.mkdirSync(path.dirname(absPath), { recursive: true })
        fs.writeFileSync(absPath, content, 'utf8')
        op.result = 'written'
        break
      }
      case 'db_write': {
        op.result = 'db execution not yet implemented for approved ops'
        break
      }
      case 'git_push': {
        execSync('git push', { cwd: REPO_DIR })
        op.result = 'pushed'
        break
      }
      default:
        op.result = 'unknown action'
    }
    op.status = 'executed'
    logOp({ action: op.action, level: op.level, status: 'executed', detail: op.detail })
  } catch (err) {
    op.status = 'failed'
    op.error = err.message
    logOp({ action: op.action, level: op.level, status: 'failed', error: err.message })
  }
  savePending()
}

// ── Headless browser (Puppeteer) ────────────────────────────────────
let puppeteer
try { puppeteer = require('puppeteer') } catch {}

app.post('/api/browser/fetch', authenticate, async (req, res) => {
  if (!puppeteer) return res.status(503).json({ error: 'Puppeteer not installed. Run: cd /home/Nimbus-Chat/vps && npm install puppeteer' })

  const { url, extractText = true, screenshot = false, waitFor, timeout = 15000 } = req.body
  if (!url) return res.status(400).json({ error: 'Missing url' })

  const parsed = new URL(url)
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return res.status(400).json({ error: 'Only http/https URLs allowed' })
  }

  let browser
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      timeout: 10000,
    })
    const page = await browser.newPage()
    await page.setViewport({ width: 1280, height: 800 })
    await page.setUserAgent('NimbusBot/1.0')
    await page.goto(url, { waitUntil: 'networkidle2', timeout: Math.min(timeout, 30000) })

    if (waitFor) {
      await page.waitForSelector(waitFor, { timeout: 5000 }).catch(() => {})
    }

    const result = { url: page.url(), title: await page.title() }

    if (extractText) {
      result.text = await page.evaluate(() => {
        const sel = ['script', 'style', 'noscript', 'svg', 'img']
        sel.forEach((s) => document.querySelectorAll(s).forEach((el) => el.remove()))
        return (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 12000)
      })
    }

    if (screenshot) {
      const buf = await page.screenshot({ type: 'jpeg', quality: 60, fullPage: false })
      result.screenshot = `data:image/jpeg;base64,${buf.toString('base64')}`
    }

    logOp({ action: 'browser_fetch', level: 'green', detail: url })
    res.json(result)
  } catch (err) {
    logOp({ action: 'browser_fetch', level: 'green', error: err.message })
    res.status(500).json({ error: err.message })
  } finally {
    if (browser) await browser.close().catch(() => {})
  }
})

// ── MCP Server Manager ─────────────────────────────────────────────
const MCP_CONFIG_PATH = path.join(__dirname, 'mcp-servers.json')
let mcpConfig = []
try {
  if (fs.existsSync(MCP_CONFIG_PATH)) {
    mcpConfig = JSON.parse(fs.readFileSync(MCP_CONFIG_PATH, 'utf8'))
  }
} catch {}

const saveMcpConfig = () => {
  try { fs.writeFileSync(MCP_CONFIG_PATH, JSON.stringify(mcpConfig, null, 2)) } catch {}
}

const mcpProcesses = new Map()

app.get('/api/mcp/list', authenticate, (_req, res) => {
  const list = mcpConfig.map((srv) => ({
    ...srv,
    running: mcpProcesses.has(srv.id),
    pid: mcpProcesses.get(srv.id)?.pid || null,
  }))
  res.json(list)
})

app.post('/api/mcp/add', authenticate, (req, res) => {
  const { name, type, command, url: srvUrl, args, env, description } = req.body
  if (!name) return res.status(400).json({ error: 'Missing name' })
  if (!type || !['stdio', 'sse'].includes(type)) return res.status(400).json({ error: 'type must be stdio or sse' })
  if (type === 'stdio' && !command) return res.status(400).json({ error: 'stdio type requires command' })
  if (type === 'sse' && !srvUrl) return res.status(400).json({ error: 'sse type requires url' })

  const srv = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name,
    type,
    command: command || null,
    url: srvUrl || null,
    args: args || [],
    env: env || {},
    description: description || '',
    enabled: true,
    created: new Date().toISOString(),
  }
  mcpConfig.push(srv)
  saveMcpConfig()
  logOp({ action: 'mcp_add', level: 'yellow', detail: `Added MCP server: ${name}` })
  res.json(srv)
})

app.post('/api/mcp/remove', authenticate, (req, res) => {
  const { id } = req.body
  if (!id) return res.status(400).json({ error: 'Missing id' })

  const proc = mcpProcesses.get(id)
  if (proc) {
    proc.kill('SIGTERM')
    mcpProcesses.delete(id)
  }

  const idx = mcpConfig.findIndex((s) => s.id === id)
  if (idx < 0) return res.status(404).json({ error: 'Server not found' })
  const removed = mcpConfig.splice(idx, 1)[0]
  saveMcpConfig()
  logOp({ action: 'mcp_remove', level: 'yellow', detail: `Removed MCP server: ${removed.name}` })
  res.json({ removed: removed.name })
})

app.post('/api/mcp/start', authenticate, (req, res) => {
  const { id } = req.body
  const srv = mcpConfig.find((s) => s.id === id)
  if (!srv) return res.status(404).json({ error: 'Server not found' })
  if (mcpProcesses.has(id)) return res.json({ status: 'already running', pid: mcpProcesses.get(id).pid })

  if (srv.type === 'sse') {
    return res.json({ status: 'ok', note: 'SSE servers are remote; no process to start' })
  }

  try {
    const cmdParts = srv.command.split(/\s+/)
    const child = exec([srv.command, ...srv.args].join(' '), {
      env: { ...process.env, ...srv.env },
      cwd: __dirname,
    })
    mcpProcesses.set(id, child)
    child.on('exit', () => mcpProcesses.delete(id))
    logOp({ action: 'mcp_start', level: 'yellow', detail: `Started ${srv.name} (PID ${child.pid})` })
    res.json({ status: 'started', pid: child.pid })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/mcp/stop', authenticate, (req, res) => {
  const { id } = req.body
  const proc = mcpProcesses.get(id)
  if (!proc) return res.status(404).json({ error: 'Process not running' })
  proc.kill('SIGTERM')
  mcpProcesses.delete(id)
  const srv = mcpConfig.find((s) => s.id === id)
  logOp({ action: 'mcp_stop', level: 'yellow', detail: `Stopped ${srv?.name || id}` })
  res.json({ status: 'stopped' })
})

app.post('/api/mcp/toggle', authenticate, (req, res) => {
  const { id, enabled } = req.body
  const srv = mcpConfig.find((s) => s.id === id)
  if (!srv) return res.status(404).json({ error: 'Server not found' })
  srv.enabled = !!enabled
  saveMcpConfig()
  res.json(srv)
})

// ════════════════════════════════════════════════════════════════════════
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Nimbus API running on port ${PORT}`)
})
