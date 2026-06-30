import { registerPlugin, Capacitor, type PluginListenerHandle } from '@capacitor/core'
import { streamLog } from './streamDebug'

// Bridge to the native StreamHttpPlugin (Android). It does native HTTP with
// chunked reads so the chat request BOTH bypasses the WebView CORS wall (most
// 中转 reject the https://localhost origin) AND streams the body — the one
// thing CapacitorHttp's patched fetch can't do (it buffers the whole response,
// which is why replies used to arrive as "一大坨" after a long blank
// "正在输入…"). See android/.../StreamHttpPlugin.java and docs/caching.md.
//
// We re-wrap the plugin's chunk/end/error events into a standard streaming
// Response, so every downstream consumer (the SSE parser in App.tsx, the
// Anthropic stream translator) works byte-for-byte unchanged.

type StartStreamResult = { status: number; headers: Record<string, string> }

interface StreamHttpPlugin {
  startStream(opts: {
    streamId: string
    url: string
    method: string
    headers: Record<string, string>
    body?: string
  }): Promise<StartStreamResult>
  cancelStream(opts: { streamId: string }): Promise<void>
  addListener(
    eventName: 'streamChunk',
    cb: (data: { streamId: string; chunk: string }) => void,
  ): Promise<PluginListenerHandle>
  addListener(
    eventName: 'streamEnd',
    cb: (data: { streamId: string }) => void,
  ): Promise<PluginListenerHandle>
  addListener(
    eventName: 'streamError',
    cb: (data: { streamId: string; error: string }) => void,
  ): Promise<PluginListenerHandle>
}

const StreamHttp = registerPlugin<StreamHttpPlugin>('StreamHttp')

// Headers that describe the ORIGINAL byte framing of the upstream response.
// HttpURLConnection has already transparently decoded gzip and given us the
// plain body, so re-advertising these on our synthetic Response would lie about
// the bytes and can confuse consumers. content-type is the one that matters
// (drives the text/event-stream vs json branch) and is preserved.
const FRAMING_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding'])

const base64ToBytes = (b64: string): Uint8Array => {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i)
  return out
}

const newStreamId = (): string => {
  const c = globalThis.crypto as Crypto | undefined
  if (c?.randomUUID) return c.randomUUID()
  return `s_${Date.now()}_${Math.random().toString(36).slice(2)}`
}

export const isNativeStreamAvailable = (): boolean => Capacitor.isNativePlatform()

// fetch()-shaped streaming over the native plugin. Returns a Response whose
// body is a ReadableStream fed by the plugin's chunk events. Only the subset of
// RequestInit we actually use (method/headers/body/signal) is honored.
export const nativeStreamFetch = async (
  url: string,
  init: {
    method?: string
    headers?: Record<string, string>
    body?: string
    signal?: AbortSignal | null
  } = {},
): Promise<Response> => {
  const streamId = newStreamId()
  const listeners: PluginListenerHandle[] = []
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null
  let settled = false

  const cleanup = () => {
    for (const h of listeners) void h.remove()
    listeners.length = 0
  }

  // Build the stream first so its controller exists synchronously, then attach
  // listeners that feed it. Chunks arriving before startStream resolves are
  // buffered by the ReadableStream's internal queue — no data loss.
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller
    },
    cancel() {
      // Consumer (or our abort handler) tore down the stream — stop the upload.
      void StreamHttp.cancelStream({ streamId })
      cleanup()
    },
  })

  const closeOnce = (fn: () => void) => {
    if (settled) return
    settled = true
    fn()
    cleanup()
  }

  let chunkCount = 0
  listeners.push(
    await StreamHttp.addListener('streamChunk', (data) => {
      if (data.streamId !== streamId || !controllerRef) return
      chunkCount++
      if (chunkCount === 1) streamLog(`first chunk received [${streamId.slice(0, 8)}]`)
      try {
        controllerRef.enqueue(base64ToBytes(data.chunk))
      } catch {
        /* stream already closed/errored */
      }
    }),
  )
  listeners.push(
    await StreamHttp.addListener('streamEnd', (data) => {
      if (data.streamId !== streamId) return
      streamLog(`streamEnd (chunks=${chunkCount}) [${streamId.slice(0, 8)}]`)
      closeOnce(() => controllerRef?.close())
    }),
  )
  listeners.push(
    await StreamHttp.addListener('streamError', (data) => {
      if (data.streamId !== streamId) return
      streamLog(`streamError: ${data.error} [${streamId.slice(0, 8)}]`)
      closeOnce(() => controllerRef?.error(new Error(data.error || 'native stream error')))
    }),
  )

  const signal = init.signal
  if (signal) {
    if (signal.aborted) {
      void StreamHttp.cancelStream({ streamId })
      cleanup()
      throw new DOMException('Aborted', 'AbortError')
    }
    signal.addEventListener(
      'abort',
      () => {
        void StreamHttp.cancelStream({ streamId })
        closeOnce(() => controllerRef?.error(new DOMException('Aborted', 'AbortError')))
      },
      { once: true },
    )
  }

  streamLog(`startStream → ${url.replace(/^https?:\/\/[^/]+/, '')} [${streamId.slice(0, 8)}]`)
  let result: StartStreamResult
  try {
    result = await StreamHttp.startStream({
      streamId,
      url,
      method: init.method ?? 'POST',
      headers: init.headers ?? {},
      body: init.body,
    })
    streamLog(`startStream resolved: status=${result.status} [${streamId.slice(0, 8)}]`)
  } catch (err) {
    streamLog(`startStream rejected: ${String(err)} [${streamId.slice(0, 8)}]`)
    cleanup()
    throw err
  }

  const headers = new Headers()
  for (const [k, v] of Object.entries(result.headers ?? {})) {
    if (!FRAMING_HEADERS.has(k.toLowerCase())) headers.set(k, v)
  }

  return new Response(stream, { status: result.status, headers })
}

// Safety net around nativeStreamFetch. The native plugin is unproven on real
// devices — if it hangs (request out, nothing back) the app would spin forever.
// This resolves a streaming Response ONLY after the first byte is confirmed
// within `firstByteMs`; if the plugin stalls/errors/never delivers, it throws
// so the caller can fall back to the buffered fetch (which works, just doesn't
// stream). Guarantee: the chat can never hang on a broken native path.
export const nativeStreamFetchOrThrow = async (
  url: string,
  init: {
    method?: string
    headers?: Record<string, string>
    body?: string
    signal?: AbortSignal | null
  } = {},
  firstByteMs = 10000,
): Promise<Response> => {
  const ctl = new AbortController()
  const ext = init.signal
  if (ext) {
    if (ext.aborted) ctl.abort()
    else ext.addEventListener('abort', () => ctl.abort(), { once: true })
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      streamLog(`first-byte timeout after ${firstByteMs}ms — aborting native stream`)
      ctl.abort() // tears down the native stream (cancelStream) via the signal
      reject(new Error('native stream first-byte timeout'))
    }, firstByteMs)
  })

  const attempt = (async (): Promise<Response> => {
    const resp = await nativeStreamFetch(url, { ...init, signal: ctl.signal })
    const reader = resp.body!.getReader()
    // Block until the first chunk actually arrives — this is what proves the
    // native path is alive. A hang here is caught by the timeout race below.
    const first = await reader.read()
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        if (!first.done && first.value) c.enqueue(first.value)
        if (first.done) {
          c.close()
          return
        }
        void (async () => {
          try {
            for (;;) {
              const { done, value } = await reader.read()
              if (done) break
              if (value) c.enqueue(value)
            }
            c.close()
          } catch (e) {
            c.error(e)
          }
        })()
      },
      cancel(reason) {
        void reader.cancel(reason)
      },
    })
    return new Response(stream, { status: resp.status, headers: resp.headers })
  })()

  // Don't let the losing branch's rejection surface as unhandled.
  attempt.catch(() => {})

  try {
    return await Promise.race([attempt, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
