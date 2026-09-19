import { vfetch, isVpsConfigured } from './vpsConfig'

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
  if (!isVpsConfigured()) {
    return {
      ok: false,
      error: 'VPS not configured. Go to Settings → VPS to set URL and API Key.',
    }
  }
  try {
    const controller = new AbortController()
    const t = window.setTimeout(
      () => controller.abort(),
      Math.min(150, Math.max(10, (input.timeout_seconds ?? 30) + 30)) * 1000,
    )
    const r = await vfetch('/api/sandbox/run', {
      method: 'POST',
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
      return { ok: false, error: 'sandbox request timeout' }
    }
    return { ok: false, error: String(err) }
  }
}
