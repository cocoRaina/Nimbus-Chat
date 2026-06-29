import { fetchOpenRouter } from '../api/openrouter'
import type { ProviderId } from './apiProvider'
import { supabase } from '../supabase/client'

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
//
// Storage is TWO-TIER: localStorage (synchronous, read every turn while
// building the request) backed by a Supabase table (image_captions). The
// local-only design lost every caption on APK reinstall / device switch,
// so historical images reverted to raw base64 — on a relay that bills
// images by base64 size this re-inflated context to hundreds of thousands
// of tokens. The cloud tier survives reinstall: syncImageCaptionsFromCloud
// re-hydrates localStorage on startup, and every new caption is mirrored
// up so it's never lost again.

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

// Write to localStorage immediately (so this turn's later reads hit it) and
// mirror to the cloud so it survives reinstall. The cloud write is fire-and-
// forget — local cache is the hot path; cloud is the durability backstop.
export const setImageCaption = (url: string, caption: string, userId?: string) => {
  if (!url || !caption) return
  const key = hashUrl(url)
  const map = readMap()
  map[key] = caption
  writeMap(map)
  if (userId && supabase) {
    void supabase
      .from('image_captions')
      .upsert({ user_id: userId, url_hash: key, caption }, { onConflict: 'user_id,url_hash' })
      .then(({ error }) => {
        if (error) console.warn('图片描述写云失败', error)
      })
  }
}

// Pull every cloud caption for this user into localStorage. Call on startup /
// login so a freshly reinstalled app re-learns the descriptions it generated
// before — without this, historical images revert to raw base64 every turn.
export const syncImageCaptionsFromCloud = async (userId: string): Promise<void> => {
  if (!userId || !supabase) return
  try {
    const { data, error } = await supabase
      .from('image_captions')
      .select('url_hash, caption')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(MAX_ENTRIES)
    if (error) {
      console.warn('图片描述云端同步失败', error)
      return
    }
    if (!data || data.length === 0) return
    // Cloud wins on conflict (it's the durable source of truth); merge so we
    // don't drop any local-only entries written before the first sync lands.
    // Insert OLDEST-first: the query is created_at DESC (so .limit keeps the
    // newest MAX_ENTRIES), but writeMap evicts by insertion order and keeps the
    // tail. If we inserted newest-first, an overflow (local + cloud > 300) would
    // drop exactly the most-recent captions — reverting the newest images back
    // to raw base64, the opposite of what we want. So land the newest at the tail.
    const map = readMap()
    for (let i = data.length - 1; i >= 0; i -= 1) {
      const row = data[i]
      if (row.url_hash && row.caption) map[row.url_hash] = row.caption
    }
    writeMap(map)
  } catch (err) {
    console.warn('图片描述云端同步异常', err)
  }
}

const inFlight = new Set<string>()

// Url-hashes we've already surfaced a failure to the user for. A model/relay
// that can't read images fails captioning on EVERY turn for the same image, so
// without this the popup would fire every send. Warn once per image instead.
const failureNotified = new Set<string>()

const notifyFailure = (
  key: string,
  status: number | undefined,
  onError?: (status?: number) => void,
) => {
  if (!onError || failureNotified.has(key)) return
  failureNotified.add(key)
  onError(status)
}

const CAPTION_PROMPT =
  '用一两句简洁中文客观描述这张图片的关键内容（人物/场景/动作/画面/可见文字），作为后续对话的上下文参考。只描述，不要寒暄、不要评价、不要追问。'

// Generate + cache a caption once. Safe to call every turn: no-ops if it's
// already cached or already in flight. On failure the caller keeps sending
// the real image and we retry next turn — but failures are now LOGGED (they
// used to be silently swallowed, which hid the case where every caption
// request failed on a relay and historical images stayed raw forever).
export const ensureImageCaption = async (
  url: string,
  model: string,
  provider: ProviderId,
  userId?: string,
  // Called (at most once per image per session) when captioning fails, so the
  // UI can warn the user that this image keeps being sent as raw, token-heavy
  // base64 — usually because the active model/relay can't read images.
  onError?: (status?: number) => void,
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
    if (!response.ok) {
      // Surface relay/model failures instead of swallowing them — a caption
      // request that keeps 4xx-ing is exactly why an image never gets
      // replaced by text and keeps re-inflating context.
      console.warn(`图片描述生成失败 status=${response.status}`, await response.text().catch(() => ''))
      notifyFailure(key, response.status, onError)
      return
    }
    const payload = (await response.json()) as Record<string, unknown>
    const choice = (payload.choices as Array<Record<string, unknown>> | undefined)?.[0]
    const message = (choice?.message as Record<string, unknown> | undefined) ?? {}
    const text = typeof message.content === 'string' ? message.content.trim() : ''
    if (text) {
      setImageCaption(url, text, userId)
      // Recovered — allow a fresh warning if it ever fails again later.
      failureNotified.delete(key)
    } else {
      console.warn('图片描述生成返回空内容')
      notifyFailure(key, undefined, onError)
    }
  } catch (err) {
    console.warn('图片描述生成异常', err)
    notifyFailure(key, undefined, onError)
  } finally {
    inFlight.delete(key)
  }
}
