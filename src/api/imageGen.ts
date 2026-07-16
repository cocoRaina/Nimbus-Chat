// 🎨 生图核心：调 OpenAI 兼容中转站画图，返回图片 Blob。
// 两种接口形状（中转站不同支持不同，设置里可切）：
//   images — 原生生图接口 /v1/images/generations，返回 b64_json 或 url
//   chat   — /v1/chat/completions，返回 markdown ![Image](url) 或 message.images
// 血泪超时链路（docs/features/image-gen.md）：生图晚高峰一张 1~3 分钟，
// 这里 270s 超时；瞬时错误（5xx/429/断连）且失败得快（<120s）自动重试一次，
// 慢死的不重试（时间预算已经没了，重试只会双倍扣费）。
import {
  getImageGenApiKey,
  getImageGenBaseUrl,
  getImageGenModel,
  getImageGenShape,
  type ImageGenSize,
} from '../storage/imageGenConfig'
import { isNativeStreamAvailable, nativeStreamFetch } from '../native/streamHttp'

const GEN_TIMEOUT_MS = 270_000
// 失败得比这快才值得重试——慢失败说明上游已经耗掉了大半时间预算。
const RETRY_BUDGET_MS = 120_000

export type GeneratedImage = {
  blob: Blob
  mediaType: string
  model: string
  size: ImageGenSize
  prompt: string
  durationMs: number
}

const trimSlash = (s: string) => s.replace(/\/+$/, '')

// /v1 结尾就直接用，否则补上——中转站地址两种写法都有人填。
const apiBase = (): string => {
  const base = trimSlash(getImageGenBaseUrl())
  return /\/v1$/.test(base) ? base : `${base}/v1`
}

const b64ToBlob = (b64: string, mediaType: string): Blob => {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mediaType })
}

// 下载生图结果 URL → Blob。APK 上必须走 nativeStreamFetch：CapacitorHttp
// 补丁过的 window.fetch 对二进制 body 的 arrayBuffer() 会拿到乱码
// （anthropic.ts fetchImageAsBase64 同一个坑）。Web 上直接 fetch，
// 图床不给 CORS 时这里会抛错，由调用方兜底报错。
const downloadImage = async (url: string, signal?: AbortSignal): Promise<Blob> => {
  const resp = isNativeStreamAvailable()
    ? await nativeStreamFetch(url, { method: 'GET', signal })
    : await fetch(url, { signal })
  if (!resp.ok) {
    throw new Error(`下载生成的图片失败 (${resp.status})`)
  }
  const mediaType = (resp.headers.get('content-type') ?? 'image/png').split(';')[0].trim()
  const buf = await resp.arrayBuffer()
  return new Blob([buf], { type: mediaType.startsWith('image/') ? mediaType : 'image/png' })
}

class TransientGenError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TransientGenError'
  }
}

const requestOnce = async (
  prompt: string,
  size: ImageGenSize,
  signal: AbortSignal,
): Promise<Blob> => {
  const base = apiBase()
  const apiKey = getImageGenApiKey()
  const model = getImageGenModel()
  const shape = getImageGenShape()
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  }

  const path = shape === 'images' ? '/images/generations' : '/chat/completions'
  const body =
    shape === 'images'
      ? { model, prompt, size, n: 1 }
      : { model, stream: false, messages: [{ role: 'user', content: prompt }] }

  const resp = await fetch(`${base}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    const message = `生图接口 ${resp.status}：${text.slice(0, 300)}`
    if (resp.status >= 500 || resp.status === 429) throw new TransientGenError(message)
    throw new Error(message)
  }
  const payload = (await resp.json().catch(() => null)) as Record<string, unknown> | null
  if (!payload) throw new Error('生图接口返回了无法解析的响应')

  if (shape === 'images') {
    const item = (payload.data as Array<Record<string, unknown>> | undefined)?.[0]
    const b64 = typeof item?.b64_json === 'string' ? item.b64_json : ''
    if (b64) return b64ToBlob(b64, 'image/png')
    const url = typeof item?.url === 'string' ? item.url : ''
    if (url) return downloadImage(url, signal)
    throw new Error('生图接口没有返回图片（data[0] 缺 b64_json/url）')
  }

  // chat 形状：兼容三种回法 —— message.images（OpenRouter 式）、
  // markdown ![Image](url)、正文里裸的 data:image base64。
  const choice = (payload.choices as Array<Record<string, unknown>> | undefined)?.[0]
  const message = (choice?.message as Record<string, unknown> | undefined) ?? {}
  const images = message.images as Array<Record<string, unknown>> | undefined
  const nestedUrl = (images?.[0]?.image_url as { url?: string } | undefined)?.url
  if (typeof nestedUrl === 'string' && nestedUrl) {
    const dataMatch = nestedUrl.match(/^data:([^;]+);base64,(.+)$/)
    if (dataMatch) return b64ToBlob(dataMatch[2], dataMatch[1])
    return downloadImage(nestedUrl, signal)
  }
  const content = typeof message.content === 'string' ? message.content : ''
  const dataUrlMatch = content.match(/data:(image\/[a-z+]+);base64,([A-Za-z0-9+/=]+)/)
  if (dataUrlMatch) return b64ToBlob(dataUrlMatch[2], dataUrlMatch[1])
  const mdMatch = content.match(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/)
  if (mdMatch) return downloadImage(mdMatch[1], signal)
  throw new Error(`生图接口没有返回图片：${content.slice(0, 200) || '(空回复)'}`)
}

// 生一张图。timeout 270s；外部 signal（用户停止流式）会一起掐断。
export const generateImage = async (
  prompt: string,
  size: ImageGenSize,
  externalSignal?: AbortSignal,
): Promise<GeneratedImage> => {
  const startedAt = Date.now()
  const attempt = async (): Promise<Blob> => {
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), GEN_TIMEOUT_MS)
    const onExternalAbort = () => controller.abort()
    externalSignal?.addEventListener('abort', onExternalAbort)
    if (externalSignal?.aborted) controller.abort()
    try {
      return await requestOnce(prompt, size, controller.signal)
    } catch (err) {
      // 网络层断连（TypeError: failed to fetch 等）也算瞬时——但用户主动
      // 停止（外部 signal）不算，直接向上抛。
      if (externalSignal?.aborted) throw err
      if (err instanceof TypeError) throw new TransientGenError(err.message)
      throw err
    } finally {
      window.clearTimeout(timer)
      externalSignal?.removeEventListener('abort', onExternalAbort)
    }
  }

  let blob: Blob
  try {
    blob = await attempt()
  } catch (err) {
    const elapsed = Date.now() - startedAt
    const retriable = err instanceof TransientGenError && elapsed < RETRY_BUDGET_MS && !externalSignal?.aborted
    if (!retriable) throw err
    console.warn(`[生图] 瞬时失败（${Math.round(elapsed / 1000)}s），自动补一笔`, err)
    blob = await attempt()
  }

  return {
    blob,
    mediaType: blob.type || 'image/png',
    model: getImageGenModel(),
    size,
    prompt,
    durationMs: Date.now() - startedAt,
  }
}
