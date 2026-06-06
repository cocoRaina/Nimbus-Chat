import { fetchOpenRouter } from '../api/openrouter'
import type { ProviderId } from './apiProvider'

// Image → short text description cache. Why this exists: every turn we
// re-send every historical image in the conversation, which on a cache
// miss / cold write is expensive (images are token-heavy) and bloats the
// prompt prefix. Once an image has been seen, we don't need the model to
// re-look at it — a one/two-sentence description carries enough context.
//
// So: the FIRST time an image appears it's sent for real (model sees it)
// and we asynchronously caption it; from the next turn on we send the
// cached text description instead. If captioning ever fails, there's no
// cache entry and we just keep sending the real image — i.e. graceful
// fallback to the previous behavior, no message/DB changes involved.

const STORAGE_KEY = 'nimbus_image_captions_v1'
const MAX_ENTRIES = 300

// FNV-1a → short hex. Image urls can be giant base64 data URLs, so we
// never key the map on the raw url.
const hashUrl = (url: string): string => {
  let h = 0x811c9dc5
  for (let i = 0; i < url.length; i += 1) {
    h ^= url.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

type CaptionMap = Record<string, string>

const readMap = (): CaptionMap => {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as CaptionMap) : {}
  } catch {
    return {}
  }
}

const writeMap = (map: CaptionMap) => {
  if (typeof window === 'undefined') return
  try {
    let entries = Object.entries(map)
    // Bound the store. JSON objects keep string-key insertion order, so the
    // tail is the most recently added — keep those, drop the oldest.
    if (entries.length > MAX_ENTRIES) entries = entries.slice(entries.length - MAX_ENTRIES)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)))
  } catch {
    // ignore quota errors
  }
}

export const getImageCaption = (url: string): string | null => {
  if (!url) return null
  return readMap()[hashUrl(url)] ?? null
}

export const setImageCaption = (url: string, caption: string) => {
  if (!url || !caption) return
  const map = readMap()
  map[hashUrl(url)] = caption
  writeMap(map)
}

const inFlight = new Set<string>()

const CAPTION_PROMPT =
  '用一两句简洁中文客观描述这张图片的关键内容（人物/场景/动作/画面/可见文字），作为后续对话的上下文参考。只描述，不要寒暄、不要评价、不要追问。'

// Generate + cache a caption once. Safe to call every turn: no-ops if it's
// already cached or already in flight. All errors are swallowed — on
// failure the caller keeps sending the real image and we retry next turn.
export const ensureImageCaption = async (
  url: string,
  model: string,
  provider: ProviderId,
): Promise<void> => {
  if (!url || !model) return
  const key = hashUrl(url)
  if (inFlight.has(key)) return
  if (readMap()[key]) return
  inFlight.add(key)
  try {
    const response = await fetchOpenRouter('/chat/completions', {
      provider,
      body: {
        model,
        stream: false,
        max_tokens: 200,
        temperature: 0.2,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: CAPTION_PROMPT },
              { type: 'image_url', image_url: { url } },
            ],
          },
        ],
      },
    })
    if (!response.ok) return
    const payload = (await response.json()) as Record<string, unknown>
    const choice = (payload.choices as Array<Record<string, unknown>> | undefined)?.[0]
    const message = (choice?.message as Record<string, unknown> | undefined) ?? {}
    const text = typeof message.content === 'string' ? message.content.trim() : ''
    if (text) setImageCaption(url, text)
  } catch {
    // keep sending the image; try again next turn
  } finally {
    inFlight.delete(key)
  }
}
