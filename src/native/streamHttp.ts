import { registerPlugin, Capacitor, type PluginListenerHandle } from '@capacitor/core'

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

  listeners.push(
    await StreamHttp.addListener('streamChunk', (data) => {
      if (data.streamId !== streamId || !controllerRef) return
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
      closeOnce(() => controllerRef?.close())
    }),
  )
  listeners.push(
    await StreamHttp.addListener('streamError', (data) => {
      if (data.streamId !== streamId) return
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

  let result: StartStreamResult
  try {
    result = await StreamHttp.startStream({
      streamId,
      url,
      method: init.method ?? 'POST',
      headers: init.headers ?? {},
      body: init.body,
    })
  } catch (err) {
    cleanup()
    throw err
  }

  const headers = new Headers()
  for (const [k, v] of Object.entries(result.headers ?? {})) {
    if (!FRAMING_HEADERS.has(k.toLowerCase())) headers.set(k, v)
  }

  return new Response(stream, { status: result.status, headers })
}
