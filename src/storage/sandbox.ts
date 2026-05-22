// Sandbox endpoint config. The user provides an HTTP(S) URL to their
// own server (Mac mini, VPS, whatever). We POST code + language and
// expect a structured response back.
//
// Contract:
//   POST {endpoint}/run
//   Headers:
//     Content-Type: application/json
//     X-Sandbox-Token: <token>   (if configured)
//   Body:
//     {
//       "language": "python" | "javascript",
//       "code": "...",
//       "timeout_seconds": 30
//     }
//   Response (success):
//     {
//       "ok": true,
//       "stdout": "...",
//       "stderr": "...",
//       "exit_code": 0,
//       "duration_ms": 123,
//       "files": [             // optional, generated artifacts
//         { "name": "out.png", "url": "https://.../out.png", "mime": "image/png" }
//       ]
//     }
//   Response (error):
//     { "ok": false, "error": "..." }

const STORAGE_ENDPOINT = 'nimbus_sandbox_endpoint'
const STORAGE_TOKEN = 'nimbus_sandbox_token'

export const getSandboxEndpoint = (): string => {
  if (typeof window === 'undefined') return ''
  return window.localStorage.getItem(STORAGE_ENDPOINT)?.trim() ?? ''
}

export const saveSandboxEndpoint = (url: string) => {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(STORAGE_ENDPOINT, url.trim())
}

export const getSandboxToken = (): string => {
  if (typeof window === 'undefined') return ''
  return window.localStorage.getItem(STORAGE_TOKEN)?.trim() ?? ''
}

export const saveSandboxToken = (token: string) => {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(STORAGE_TOKEN, token.trim())
}

export const clearSandboxConfig = () => {
  if (typeof window === 'undefined') return
  window.localStorage.removeItem(STORAGE_ENDPOINT)
  window.localStorage.removeItem(STORAGE_TOKEN)
}

export type SandboxRunResult = {
  ok: boolean
  stdout?: string
  stderr?: string
  exit_code?: number
  duration_ms?: number
  files?: Array<{ name: string; url: string; mime?: string }>
  error?: string
}

export const runSandboxCode = async (input: {
  language: 'python' | 'javascript'
  code: string
  timeout_seconds?: number
}): Promise<SandboxRunResult> => {
  const endpoint = getSandboxEndpoint()
  if (!endpoint) {
    return {
      ok: false,
      error:
        '未配置代码沙盒地址。请前往 设置 → 代码沙盒 填入你的 Mac mini / VPS 上的服务地址。',
    }
  }
  // Sanity-check the scheme before sending code anywhere. fetch() would
  // reject file:// / data:// on its own, but javascript: and weird custom
  // schemes can confuse it. Only http(s) is meaningful here.
  let parsedEndpoint: URL
  try {
    parsedEndpoint = new URL(endpoint)
  } catch {
    return { ok: false, error: '沙盒地址无效，请检查 设置 → 代码沙盒 里的 URL' }
  }
  if (parsedEndpoint.protocol !== 'https:' && parsedEndpoint.protocol !== 'http:') {
    return {
      ok: false,
      error: `沙盒地址协议不支持: ${parsedEndpoint.protocol}（只允许 http:// 或 https://）`,
    }
  }
  const token = getSandboxToken()
  const url = endpoint.replace(/\/+$/, '') + '/run'
  try {
    const controller = new AbortController()
    const t = window.setTimeout(
      () => controller.abort(),
      Math.min(150, Math.max(10, (input.timeout_seconds ?? 30) + 30)) * 1000,
    )
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'X-Sandbox-Token': token } : {}),
      },
      body: JSON.stringify({
        language: input.language,
        code: input.code,
        timeout_seconds: input.timeout_seconds ?? 30,
      }),
      signal: controller.signal,
    })
    window.clearTimeout(t)
    if (!r.ok) {
      const text = await r.text()
      return { ok: false, error: `sandbox ${r.status}: ${text.slice(0, 500)}` }
    }
    return (await r.json()) as SandboxRunResult
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { ok: false, error: 'sandbox 请求超时' }
    }
    return { ok: false, error: String(err) }
  }
}
