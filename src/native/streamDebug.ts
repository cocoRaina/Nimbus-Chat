// In-app stream diagnostic log. Writes to localStorage so it survives
// page refreshes and can be read from the Settings debug panel without ADB.

const KEY = 'nimbus_stream_log'
const MAX = 60

export type LogEntry = { t: string; msg: string }

const getLog = (): LogEntry[] => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]') as LogEntry[]
  } catch {
    return []
  }
}

export const streamLog = (msg: string): void => {
  const now = new Date()
  const t = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}.${now.getMilliseconds().toString().padStart(3, '0')}`
  console.log('[StreamHttp]', msg)
  try {
    const log = getLog()
    log.push({ t, msg })
    if (log.length > MAX) log.splice(0, log.length - MAX)
    localStorage.setItem(KEY, JSON.stringify(log))
  } catch { /* ignore quota */ }
}

export const readStreamLog = (): LogEntry[] => getLog()

export const clearStreamLog = (): void => {
  try { localStorage.removeItem(KEY) } catch { /* ignore */ }
}
