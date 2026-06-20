// Shared sticker set — user and AI both send stickers by NAME via `[sticker:名字]`.
// Local stickers (manually imported): compressed PNG data URLs in localStorage.
// Remote stickers (Supabase pack): remote URLs loaded on app start, grouped by pack.
// AI uses the search_stickers tool to find names; does NOT get a full list in the prompt.

export type Sticker = { name: string; desc: string; dataUrl: string }
export type RemoteStickerEntry = { name: string; url: string }
export type RemotePackMap = Map<string, RemoteStickerEntry[]>

const KEY = 'nimbus_stickers_v1'

// ── Local stickers (localStorage) ──────────────────────────────────────────

export const getStickers = (): Sticker[] => {
  if (typeof window === 'undefined') return []
  try {
    const arr = JSON.parse(window.localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(arr) ? arr.filter((s) => s && s.name && s.dataUrl) : []
  } catch {
    return []
  }
}

const write = (s: Sticker[]) => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    // quota — caller should keep stickers small / few
  }
}

export const upsertSticker = (s: Sticker) => {
  const all = getStickers().filter((x) => x.name !== s.name)
  all.push(s)
  write(all)
}

export const deleteSticker = (name: string) => write(getStickers().filter((x) => x.name !== name))

// ── Remote sticker cache (populated from Supabase on app start) ─────────────

let _remoteByName: Map<string, { url: string; pack: string }> = new Map()
let _remotePacks: RemotePackMap = new Map()

export const setRemoteStickerCache = (
  stickers: Array<{ name: string; url: string; pack: string }>,
) => {
  _remoteByName = new Map(stickers.map((s) => [s.name, { url: s.url, pack: s.pack }]))
  const packs = new Map<string, RemoteStickerEntry[]>()
  for (const s of stickers) {
    const arr = packs.get(s.pack) ?? []
    arr.push({ name: s.name, url: s.url })
    packs.set(s.pack, arr)
  }
  _remotePacks = packs
}

export const getRemotePacks = (): RemotePackMap => _remotePacks

// ── Unified lookup (local first, then remote) ────────────────────────────────

export const findSticker = (name: string): Sticker | null => {
  const local = getStickers().find((x) => x.name === name)
  if (local) return local
  const remote = _remoteByName.get(name)
  if (remote) return { name, desc: '', dataUrl: remote.url }
  return null
}

// ── Static system-prompt section for sticker tool usage ─────────────────────
// Replaces the old per-sticker name list — AI calls search_stickers instead.
export const buildStickerSystemSection = (): string =>
  '\n\n## 表情包\n' +
  '你可以发表情包（图片）。用法：先调用 `search_stickers` 工具，再用 `[sticker:名字]` 嵌入消息。\n' +
  '**重要**：贴纸名字是中文情感短语，不是图片内容描述。搜索时要用**情绪/语气关键词**，不要用"猫""动物"这类视觉词。\n' +
  '例：思念 → query="想你"；撒娇 → query="宝宝"；生气 → query="坏"；困惑 → query="懵"；冷漠 → query="不理"。\n' +
  '搜到结果后，把名字**原样**写进 `[sticker:名字]`，名字一个字都不能改。合适的情绪下自然地用，不要每条都用。'

// ── Compress an imported image to a small PNG data URL ───────────────────────
export const fileToStickerDataUrl = (file: File, max = 256): Promise<string> =>
  new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height))
      const w = Math.max(1, Math.round(img.width * scale))
      const h = Math.max(1, Math.round(img.height * scale))
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        URL.revokeObjectURL(url)
        reject(new Error('no canvas'))
        return
      }
      ctx.drawImage(img, 0, 0, w, h)
      URL.revokeObjectURL(url)
      resolve(canvas.toDataURL('image/png'))
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('image load failed'))
    }
    img.src = url
  })
