const express = require('express')
const cors = require('cors')
const jwt = require('jsonwebtoken')
const { execSync, exec } = require('child_process')
const os = require('os')
const fs = require('fs')
const path = require('path')
const cron = require('node-cron')
const { runWake } = require('./autonomousWake')

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
      case 'exec_write':
      case 'exec_write_async': {
        op.result = 'approved_for_execution'
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

// ══ Shell Exec ═══════════════════════════════════════════════════════

const WRITE_CMD_PATTERNS = [
  /\bsed\s+-i\b/, /\bsed\b.*\bi\b/,
  /\brm\s/, /\bunlink\s/,
  /\bmv\s/, /\bcp\s/,
  /\btee\s/, /\bdd\s/,
  /\bmkdir\s/, /\brmdir\s/,
  /\bchmod\s/, /\bchown\s/,
  /\bln\s/,
  /\bnpm\s+(install|uninstall|update|ci)\b/,
  /\bpip\s+install\b/,
  /\bapt\s+(install|remove|purge)\b/,
  /\bgit\s+(push|reset|checkout|merge|rebase|commit|add|rm)\b/,
  /\bpm2\s+(delete|stop|kill)\b/,
  /\bkill\b/, /\bkillall\b/, /\bpkill\b/,
  /\bsystemctl\s+(start|stop|restart|enable|disable)\b/,
  /\bcrontab\b/,
  /\bcurl\b.*(-X\s*(PUT|POST|DELETE|PATCH)|-d\s)/,
]
const REDIRECT_PATTERN = /[^2]?>(?!&)/
const PIPE_WRITE_PATTERN = /\|\s*(tee|dd|xargs\s+(rm|mv|cp))\b/

const isWriteCommand = (cmd) => {
  const normalized = cmd.trim()
  if (REDIRECT_PATTERN.test(normalized)) return true
  if (PIPE_WRITE_PATTERN.test(normalized)) return true
  return WRITE_CMD_PATTERNS.some((p) => p.test(normalized))
}

app.post('/api/exec', authenticate, (req, res) => {
  const { command, timeout_ms, approval_id } = req.body
  if (!command) return res.status(400).json({ ok: false, error: 'Missing command' })

  if (isWriteCommand(command) && !approval_id) {
    const pending = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      action: 'exec_write',
      level: 'yellow',
      detail: command.slice(0, 500),
      payload: { command, timeout_ms },
      status: 'pending',
      approvals: { user: false, wren: false },
      created: new Date().toISOString(),
    }
    pendingOps.push(pending)
    savePending()
    logOp({ action: 'exec_write', level: 'yellow', status: 'pending_approval', detail: command.slice(0, 120) })
    return res.json({ ok: false, needs_approval: true, id: pending.id, command: command.slice(0, 500), message: '写操作需要主人批准' })
  }

  if (approval_id) {
    const op = pendingOps.find((o) => o.id === approval_id)
    if (!op) return res.status(400).json({ ok: false, error: '审批记录不存在' })
    if (op.status !== 'approved') return res.status(403).json({ ok: false, error: `审批状态: ${op.status}，需要主人批准后才能执行` })
    if (op.payload?.command !== command) return res.status(403).json({ ok: false, error: '命令与审批记录不匹配' })
  }

  const timeout = Math.min(120000, Math.max(3000, timeout_ms || 30000))
  const start = Date.now()
  try {
    const stdout = execSync(command, {
      timeout,
      maxBuffer: 2 * 1024 * 1024,
      encoding: 'utf8',
      cwd: REPO_DIR,
      shell: '/bin/bash',
    })
    logOp({ action: 'exec', level: 'yellow', detail: command.slice(0, 120), result: 'ok' })
    res.json({ ok: true, stdout: stdout.slice(0, 50000), stderr: '', exit_code: 0, duration_ms: Date.now() - start })
  } catch (err) {
    const duration_ms = Date.now() - start
    logOp({ action: 'exec', level: 'yellow', detail: command.slice(0, 120), result: err.killed ? 'timeout' : 'error' })
    res.json({
      ok: true,
      stdout: (err.stdout || '').slice(0, 50000),
      stderr: (err.stderr || err.message || '').slice(0, 50000),
      exit_code: err.killed ? 124 : (err.status || 1),
      duration_ms,
    })
  }
})

// ══ Async Exec（后台长任务）═══════════════════════════════════════════
const asyncTasks = new Map()

app.post('/api/exec/async', authenticate, (req, res) => {
  const { command, timeout_ms, approval_id } = req.body
  if (!command) return res.status(400).json({ ok: false, error: 'Missing command' })

  if (isWriteCommand(command) && !approval_id) {
    const pending = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      action: 'exec_write_async',
      level: 'yellow',
      detail: command.slice(0, 500),
      payload: { command, timeout_ms },
      status: 'pending',
      approvals: { user: false, wren: false },
      created: new Date().toISOString(),
    }
    pendingOps.push(pending)
    savePending()
    logOp({ action: 'exec_write_async', level: 'yellow', status: 'pending_approval', detail: command.slice(0, 120) })
    return res.json({ ok: false, needs_approval: true, id: pending.id, command: command.slice(0, 500), message: '写操作需要主人批准' })
  }

  if (approval_id) {
    const op = pendingOps.find((o) => o.id === approval_id)
    if (!op) return res.status(400).json({ ok: false, error: '审批记录不存在' })
    if (op.status !== 'approved') return res.status(403).json({ ok: false, error: `审批状态: ${op.status}，需要主人批准后才能执行` })
    if (op.payload?.command !== command) return res.status(403).json({ ok: false, error: '命令与审批记录不匹配' })
  }

  const timeout = Math.min(600000, Math.max(5000, timeout_ms || 300000))

  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const task = {
    id,
    command,
    status: 'running',
    stdout: '',
    stderr: '',
    exit_code: null,
    started: new Date().toISOString(),
    finished: null,
  }
  asyncTasks.set(id, task)

  const child = exec(command, {
    maxBuffer: 4 * 1024 * 1024,
    cwd: REPO_DIR,
    shell: '/bin/bash',
    timeout,
  })
  task._child = child

  child.stdout?.on('data', (d) => { task.stdout += d; if (task.stdout.length > 200000) task.stdout = task.stdout.slice(-100000) })
  child.stderr?.on('data', (d) => { task.stderr += d; if (task.stderr.length > 200000) task.stderr = task.stderr.slice(-100000) })
  child.on('close', (code, signal) => {
    task.status = signal === 'SIGTERM' || signal === 'SIGKILL' ? 'killed' : code === 0 ? 'done' : 'error'
    task.exit_code = code
    task.finished = new Date().toISOString()
    delete task._child
    logOp({ action: 'exec_async', level: 'yellow', detail: `[${id}] ${command.slice(0, 80)} → ${task.status}` })
    setTimeout(() => asyncTasks.delete(id), 30 * 60 * 1000)
  })

  logOp({ action: 'exec_async', level: 'yellow', detail: `[${id}] started: ${command.slice(0, 80)}` })
  res.json({ ok: true, id, message: '后台任务已启动' })
})

app.get('/api/exec/status/:id', authenticate, (req, res) => {
  const task = asyncTasks.get(req.params.id)
  if (!task) return res.status(404).json({ error: 'Task not found or expired' })
  const { _child, ...safe } = task
  safe.stdout_tail = safe.stdout.slice(-8000)
  safe.stderr_tail = safe.stderr.slice(-4000)
  delete safe.stdout
  delete safe.stderr
  res.json(safe)
})

app.post('/api/exec/kill/:id', authenticate, (req, res) => {
  const task = asyncTasks.get(req.params.id)
  if (!task) return res.status(404).json({ error: 'Task not found' })
  if (task.status !== 'running') return res.json({ ok: true, message: `Already ${task.status}` })
  task._child?.kill('SIGTERM')
  setTimeout(() => { if (task.status === 'running') task._child?.kill('SIGKILL') }, 5000)
  res.json({ ok: true, message: '终止信号已发送' })
})

app.get('/api/exec/list', authenticate, (_req, res) => {
  const list = []
  for (const [, task] of asyncTasks) {
    const { _child, stdout, stderr, ...safe } = task
    safe.stdout_len = stdout.length
    safe.stderr_len = stderr.length
    list.push(safe)
  }
  res.json(list)
})

// ══ Code Sandbox ══════════════════════════════════════════════════════
app.post('/api/sandbox/run', authenticate, (req, res) => {
  const { language, code, timeout_seconds } = req.body
  if (!language || !code) return res.status(400).json({ ok: false, error: 'language and code required' })
  if (!['python', 'javascript'].includes(language)) {
    return res.status(400).json({ ok: false, error: 'only python and javascript supported' })
  }
  const timeout = Math.min(120, Math.max(5, timeout_seconds || 30))
  const start = Date.now()
  try {
    let cmd
    if (language === 'python') {
      cmd = `python3 -c ${JSON.stringify(code)}`
    } else {
      cmd = `node -e ${JSON.stringify(code)}`
    }
    const stdout = execSync(cmd, {
      timeout: timeout * 1000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
      cwd: '/tmp',
      env: { ...process.env, HOME: '/tmp' },
    })
    logOp({ action: 'sandbox_run', level: 'yellow', detail: `${language}: ${code.slice(0, 80)}`, result: 'ok' })
    res.json({ ok: true, stdout: stdout.slice(0, 50000), stderr: '', exit_code: 0, duration_ms: Date.now() - start })
  } catch (err) {
    const duration_ms = Date.now() - start
    if (err.killed || err.signal === 'SIGTERM') {
      logOp({ action: 'sandbox_run', level: 'yellow', detail: `${language}: timeout`, result: 'timeout' })
      return res.json({ ok: true, stdout: err.stdout?.slice(0, 50000) || '', stderr: 'execution timed out', exit_code: 124, duration_ms })
    }
    logOp({ action: 'sandbox_run', level: 'yellow', detail: `${language}: ${code.slice(0, 80)}`, result: 'error' })
    res.json({
      ok: true,
      stdout: (err.stdout || '').slice(0, 50000),
      stderr: (err.stderr || err.message || '').slice(0, 50000),
      exit_code: err.status || 1,
      duration_ms,
    })
  }
})

// ══ Autonomous Wake ══════════════════════════════════════════════════
app.post('/api/autonomous-wake', authenticate, async (req, res) => {
  const force = req.body?.force === true
  try {
    const result = await runWake({ force })
    res.json(result)
  } catch (err) {
    console.error('[wake] 未捕获异常:', err)
    res.status(500).json({ ran: false, error: err.message })
  }
})

let wakeRunning = false
cron.schedule('*/10 * * * *', async () => {
  if (wakeRunning) { console.log('[wake-cron] 上一轮还没跑完，跳过'); return }
  wakeRunning = true
  try {
    const result = await runWake()
    if (result.ran) console.log(`[wake-cron] 跑完: ${result.note}`)
    else console.log(`[wake-cron] 跳过: ${result.skipped || result.error || '?'}`)
  } catch (err) {
    console.error('[wake-cron] 异常:', err)
  } finally {
    wakeRunning = false
  }
})

// ══ Sub-model Dispatch ════════════════════════════════════════════════
app.post('/api/llm/call', authenticate, async (req, res) => {
  const { prompt, model, system, max_tokens = 2000, temperature = 0.7 } = req.body
  if (!prompt) return res.status(400).json({ error: 'Missing prompt' })

  const apiKey = process.env.OPENROUTER_API_KEY
  const baseUrl = process.env.LLM_BASE_URL || 'https://openrouter.ai/api/v1'
  if (!apiKey) return res.status(500).json({ error: 'No API key configured' })

  const messages = []
  if (system) messages.push({ role: 'system', content: system })
  messages.push({ role: 'user', content: prompt })

  try {
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model || 'google/gemini-2.0-flash-001',
        messages,
        max_tokens,
        temperature,
      }),
    })
    const data = await resp.json()
    if (data.error) {
      logOp({ action: 'llm_call', level: 'yellow', error: data.error.message })
      return res.status(502).json({ error: data.error.message })
    }
    const reply = data.choices?.[0]?.message?.content || ''
    const usage = data.usage || {}
    logOp({ action: 'llm_call', level: 'yellow', detail: `${model || 'default'}: ${prompt.slice(0, 60)}`, tokens: usage.total_tokens })
    res.json({ ok: true, reply, model: data.model, usage })
  } catch (err) {
    logOp({ action: 'llm_call', level: 'yellow', error: err.message })
    res.status(500).json({ error: err.message })
  }
})

// ══ Dynamic Scheduling ═══════════════════════════════════════════════
const SCHEDULES_PATH = path.join(__dirname, 'schedules.json')
let schedules = []
try {
  if (fs.existsSync(SCHEDULES_PATH)) {
    schedules = JSON.parse(fs.readFileSync(SCHEDULES_PATH, 'utf8'))
  }
} catch {}

const saveSchedules = () => {
  try { fs.writeFileSync(SCHEDULES_PATH, JSON.stringify(schedules, null, 2)) } catch {}
}

const scheduledJobs = new Map()

const startSchedule = (sched) => {
  if (scheduledJobs.has(sched.id)) return
  if (!sched.enabled) return
  try {
    const job = cron.schedule(sched.cron, () => {
      logOp({ action: 'schedule_fire', level: 'green', detail: `[${sched.id}] ${sched.name}: ${sched.task}` })
      sched.lastFired = new Date().toISOString()
      sched.fireCount = (sched.fireCount || 0) + 1
      saveSchedules()
    })
    scheduledJobs.set(sched.id, job)
  } catch {}
}

schedules.filter((s) => s.enabled).forEach(startSchedule)

app.post('/api/schedule/create', authenticate, (req, res) => {
  const { name, cron: cronExpr, task, enabled = true } = req.body
  if (!name || !cronExpr) return res.status(400).json({ error: 'Missing name or cron' })
  if (!cron.validate(cronExpr)) return res.status(400).json({ error: 'Invalid cron expression' })

  const sched = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name,
    cron: cronExpr,
    task: task || '',
    enabled,
    created: new Date().toISOString(),
    lastFired: null,
    fireCount: 0,
  }
  schedules.push(sched)
  saveSchedules()
  if (enabled) startSchedule(sched)
  logOp({ action: 'schedule_create', level: 'yellow', detail: `${name} (${cronExpr})` })
  res.json(sched)
})

app.get('/api/schedule/list', authenticate, (_req, res) => {
  res.json(schedules.map((s) => ({ ...s, active: scheduledJobs.has(s.id) })))
})

app.post('/api/schedule/delete', authenticate, (req, res) => {
  const { id } = req.body
  const job = scheduledJobs.get(id)
  if (job) { job.stop(); scheduledJobs.delete(id) }
  const idx = schedules.findIndex((s) => s.id === id)
  if (idx < 0) return res.status(404).json({ error: 'Schedule not found' })
  const removed = schedules.splice(idx, 1)[0]
  saveSchedules()
  logOp({ action: 'schedule_delete', level: 'yellow', detail: removed.name })
  res.json({ removed: removed.name })
})

app.post('/api/schedule/toggle', authenticate, (req, res) => {
  const { id, enabled } = req.body
  const sched = schedules.find((s) => s.id === id)
  if (!sched) return res.status(404).json({ error: 'Schedule not found' })
  sched.enabled = !!enabled
  if (enabled) {
    startSchedule(sched)
  } else {
    const job = scheduledJobs.get(id)
    if (job) { job.stop(); scheduledJobs.delete(id) }
  }
  saveSchedules()
  res.json(sched)
})

// ══ Notification Queue ═══════════════════════════════════════════════
const NOTIF_PATH = path.join(__dirname, 'notifications.json')
let notifications = []
try {
  if (fs.existsSync(NOTIF_PATH)) {
    notifications = JSON.parse(fs.readFileSync(NOTIF_PATH, 'utf8'))
  }
} catch {}

const saveNotifications = () => {
  try { fs.writeFileSync(NOTIF_PATH, JSON.stringify(notifications.slice(-200), null, 2)) } catch {}
}

app.post('/api/notify/send', authenticate, (req, res) => {
  const { title, body, priority = 'normal', data } = req.body
  if (!title || !body) return res.status(400).json({ error: 'Missing title or body' })
  const notif = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title,
    body,
    priority,
    data: data || null,
    read: false,
    created: new Date().toISOString(),
  }
  notifications.push(notif)
  saveNotifications()
  logOp({ action: 'notify_send', level: 'green', detail: title })
  // Auto-push to subscribed devices
  if (webpush && pushSubscriptions.length > 0) {
    const payload = JSON.stringify({ title, body, tag: 'nimbus-notify' })
    const expired = []
    pushSubscriptions.forEach((sub) => {
      webpush.sendNotification(sub, payload).catch((err) => {
        if (err.statusCode === 404 || err.statusCode === 410) expired.push(sub.endpoint)
      })
    })
    if (expired.length) {
      setTimeout(() => {
        pushSubscriptions = pushSubscriptions.filter((s) => !expired.includes(s.endpoint))
        savePushSubs()
      }, 1000)
    }
  }
  res.json(notif)
})

app.get('/api/notify/list', authenticate, (req, res) => {
  const unreadOnly = req.query.unread === 'true'
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200)
  let filtered = unreadOnly ? notifications.filter((n) => !n.read) : notifications
  res.json(filtered.slice(-limit))
})

app.post('/api/notify/ack', authenticate, (req, res) => {
  const { id, all } = req.body
  if (all) {
    notifications.forEach((n) => { n.read = true })
  } else if (id) {
    const notif = notifications.find((n) => n.id === id)
    if (notif) notif.read = true
  }
  saveNotifications()
  res.json({ ok: true })
})

// ══ Work Journal ═══════════════════════════════════════════════════════
const JOURNAL_PATH = path.join(__dirname, 'journal.json')
let journal = []
try {
  if (fs.existsSync(JOURNAL_PATH)) {
    journal = JSON.parse(fs.readFileSync(JOURNAL_PATH, 'utf8'))
  }
} catch {}

const saveJournal = () => {
  try { fs.writeFileSync(JOURNAL_PATH, JSON.stringify(journal.slice(-500), null, 2)) } catch {}
}

app.post('/api/journal/write', authenticate, (req, res) => {
  const { type, content, tags } = req.body
  if (!content) return res.status(400).json({ error: 'Missing content' })
  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    type: type || 'note',
    content,
    tags: tags || [],
    created: new Date().toISOString(),
  }
  journal.push(entry)
  saveJournal()
  logOp({ action: 'journal_write', level: 'green', detail: `[${entry.type}] ${content.slice(0, 60)}` })
  res.json(entry)
})

app.get('/api/journal/read', authenticate, (req, res) => {
  const { type, tag, limit: lim, search } = req.query
  const limit = Math.min(parseInt(lim || '50', 10), 200)
  let filtered = journal
  if (type) filtered = filtered.filter((e) => e.type === type)
  if (tag) filtered = filtered.filter((e) => e.tags.includes(tag))
  if (search) {
    const q = search.toLowerCase()
    filtered = filtered.filter((e) => e.content.toLowerCase().includes(q))
  }
  res.json(filtered.slice(-limit))
})

// ══ Code Tools (search / find / edit) ═════════════════════════════════
const REPO_DIR = process.env.REPO_DIR || path.join(__dirname, '..')

app.post('/api/code/search', authenticate, (req, res) => {
  const { pattern, path: searchPath, glob, context = 2, maxResults = 60 } = req.body
  if (!pattern) return res.status(400).json({ error: 'Missing pattern' })
  const dir = searchPath ? path.resolve(REPO_DIR, searchPath) : REPO_DIR
  if (!dir.startsWith(REPO_DIR)) return res.status(403).json({ error: 'Path outside repo' })
  const args = ['-rn', `--include=${glob || '*'}`, `-C${context}`, '--color=never', '-m', String(maxResults)]
  try {
    const out = execSync(`grep ${args.map(a => `'${a}'`).join(' ')} '${pattern.replace(/'/g, "'\\''")}' '${dir}'`, {
      timeout: 15000, maxBuffer: 512 * 1024, encoding: 'utf8', cwd: REPO_DIR,
    })
    const lines = out.split('\n').slice(0, 500)
    logOp({ action: 'code_search', level: 'green', detail: `"${pattern}" → ${lines.length} lines` })
    res.json({ pattern, matches: lines.join('\n') })
  } catch (err) {
    if (err.status === 1) return res.json({ pattern, matches: '' })
    res.status(500).json({ error: err.message?.slice(0, 200) })
  }
})

app.post('/api/code/find', authenticate, (req, res) => {
  const { pattern, searchPath, type } = req.body
  if (!pattern) return res.status(400).json({ error: 'Missing pattern' })
  const dir = searchPath ? path.resolve(REPO_DIR, searchPath) : REPO_DIR
  if (!dir.startsWith(REPO_DIR)) return res.status(403).json({ error: 'Path outside repo' })
  const typeArg = type === 'dir' ? '-type d' : type === 'file' ? '-type f' : ''
  try {
    const out = execSync(
      `find '${dir}' -name '${pattern.replace(/'/g, "'\\''")}' ${typeArg} -not -path '*/node_modules/*' -not -path '*/.git/*' | head -100`,
      { timeout: 10000, maxBuffer: 256 * 1024, encoding: 'utf8' },
    )
    const files = out.trim().split('\n').filter(Boolean).map(f => f.replace(REPO_DIR + '/', ''))
    logOp({ action: 'code_find', level: 'green', detail: `"${pattern}" → ${files.length} files` })
    res.json({ files })
  } catch (err) {
    res.status(500).json({ error: err.message?.slice(0, 200) })
  }
})

app.post('/api/code/edit', authenticate, (req, res) => {
  const { filePath, oldString, newString, replaceAll = false } = req.body
  if (!filePath || typeof oldString !== 'string' || typeof newString !== 'string') {
    return res.status(400).json({ error: 'Missing filePath, oldString, or newString' })
  }
  const full = path.resolve(REPO_DIR, filePath)
  if (!full.startsWith(REPO_DIR)) return res.status(403).json({ error: 'Path outside repo' })
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'File not found' })

  let content = fs.readFileSync(full, 'utf8')
  if (!content.includes(oldString)) {
    return res.status(400).json({ error: 'oldString not found in file', hint: 'Check whitespace and exact match' })
  }
  if (!replaceAll) {
    const count = content.split(oldString).length - 1
    if (count > 1) {
      return res.status(400).json({ error: `oldString found ${count} times — use replaceAll or provide more context to make it unique` })
    }
  }
  if (replaceAll) {
    content = content.split(oldString).join(newString)
  } else {
    const idx = content.indexOf(oldString)
    content = content.slice(0, idx) + newString + content.slice(idx + oldString.length)
  }
  fs.writeFileSync(full, content, 'utf8')
  logOp({ action: 'code_edit', level: 'yellow', detail: `${filePath}: replaced ${oldString.length}→${newString.length} chars` })
  res.json({ ok: true, filePath, bytesWritten: Buffer.byteLength(content) })
})

// ══ Web Push ══════════════════════════════════════════════════════════
const VAPID_PATH = path.join(__dirname, 'vapid.json')
const PUSH_SUBS_PATH = path.join(__dirname, 'push_subscriptions.json')
let vapidKeys = null
let pushSubscriptions = []

try {
  if (fs.existsSync(PUSH_SUBS_PATH)) {
    pushSubscriptions = JSON.parse(fs.readFileSync(PUSH_SUBS_PATH, 'utf8'))
  }
} catch {}

const savePushSubs = () => {
  try { fs.writeFileSync(PUSH_SUBS_PATH, JSON.stringify(pushSubscriptions, null, 2)) } catch {}
}

const initWebPush = () => {
  try {
    const webpush = require('web-push')
    if (fs.existsSync(VAPID_PATH)) {
      vapidKeys = JSON.parse(fs.readFileSync(VAPID_PATH, 'utf8'))
    } else {
      vapidKeys = webpush.generateVAPIDKeys()
      fs.writeFileSync(VAPID_PATH, JSON.stringify(vapidKeys, null, 2))
    }
    const contact = process.env.VAPID_CONTACT || 'mailto:nimbus@localhost'
    webpush.setVapidDetails(contact, vapidKeys.publicKey, vapidKeys.privateKey)
    return webpush
  } catch (err) {
    console.log('[web-push] web-push not installed, push disabled:', err.message)
    return null
  }
}

const webpush = initWebPush()

app.get('/api/push/vapid-public-key', authenticate, (_req, res) => {
  if (!vapidKeys) return res.status(503).json({ error: 'Web Push not configured' })
  res.json({ publicKey: vapidKeys.publicKey })
})

app.post('/api/push/subscribe', authenticate, (req, res) => {
  const { subscription } = req.body
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'Missing subscription' })
  }
  const exists = pushSubscriptions.some((s) => s.endpoint === subscription.endpoint)
  if (!exists) {
    pushSubscriptions.push(subscription)
    savePushSubs()
  }
  logOp({ action: 'push_subscribe', level: 'green', detail: subscription.endpoint.slice(0, 60) })
  res.json({ ok: true })
})

app.post('/api/push/unsubscribe', authenticate, (req, res) => {
  const { endpoint } = req.body
  pushSubscriptions = pushSubscriptions.filter((s) => s.endpoint !== endpoint)
  savePushSubs()
  res.json({ ok: true })
})

app.post('/api/push/send', authenticate, (req, res) => {
  if (!webpush) return res.status(503).json({ error: 'web-push not installed' })
  const { title, body, tag, data } = req.body
  if (!title) return res.status(400).json({ error: 'Missing title' })
  const payload = JSON.stringify({ title, body: body || '', tag, data })
  const results = []
  const expired = []
  Promise.all(
    pushSubscriptions.map((sub) =>
      webpush.sendNotification(sub, payload).then(
        () => results.push({ endpoint: sub.endpoint, ok: true }),
        (err) => {
          results.push({ endpoint: sub.endpoint, ok: false, status: err.statusCode })
          if (err.statusCode === 404 || err.statusCode === 410) {
            expired.push(sub.endpoint)
          }
        },
      ),
    ),
  ).then(() => {
    if (expired.length) {
      pushSubscriptions = pushSubscriptions.filter((s) => !expired.includes(s.endpoint))
      savePushSubs()
    }
    logOp({ action: 'push_send', level: 'green', detail: title })
    res.json({ sent: results.length, results })
  })
})

// ════════════════════════════════════════════════════════════════════════
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Nimbus API running on port ${PORT}`)
  console.log('[wake-cron] 定时唤醒已启动 (每 10 分钟)')
  if (webpush) console.log('[web-push] Push notifications enabled')
})
