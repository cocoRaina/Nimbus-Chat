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
// Persisted to localStorage so the in-memory maps can be seeded SYNCHRONOUSLY
// at module load — before the async Supabase fetch resolves. This matters for
// prompt-cache stability: buildStickerSystemSection() is baked into the BP1
// system block. If the list were empty on the first message of a session and
// then populated on the second, BP1's content would change and cold-write
// twice (~¥1.5 each). Seeding from localStorage keeps the list stable from the
// very first message (after the app has loaded stickers at least once).

const REMOTE_KEY = 'nimbus_stickers_remote_v1'

const buildMaps = (stickers: Array<{ name: string; url: string; pack: string }>) => {
  const byName = new Map(stickers.map((s) => [s.name, { url: s.url, pack: s.pack }]))
  const packs = new Map<string, RemoteStickerEntry[]>()
  for (const s of stickers) {
    const arr = packs.get(s.pack) ?? []
    arr.push({ name: s.name, url: s.url })
    packs.set(s.pack, arr)
  }
  return { byName, packs }
}

const readRemoteCache = (): Array<{ name: string; url: string; pack: string }> => {
  if (typeof window === 'undefined') return []
  try {
    const arr = JSON.parse(window.localStorage.getItem(REMOTE_KEY) ?? '[]')
    return Array.isArray(arr) ? arr.filter((s) => s && s.name && s.url && s.pack) : []
  } catch {
    return []
  }
}

// Seed synchronously from localStorage at module load.
const _seed = buildMaps(readRemoteCache())
let _remoteByName: Map<string, { url: string; pack: string }> = _seed.byName
let _remotePacks: RemotePackMap = _seed.packs

export const setRemoteStickerCache = (
  stickers: Array<{ name: string; url: string; pack: string }>,
) => {
  const { byName, packs } = buildMaps(stickers)
  _remoteByName = byName
  _remotePacks = packs
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(REMOTE_KEY, JSON.stringify(stickers))
    } catch {
      // quota — list is small, but degrade gracefully
    }
  }
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
export const buildStickerSystemSection = (): string => {
  const lines: string[] = []

  // Local stickers (我的)
  const local = getStickers()
  if (local.length > 0) {
    lines.push(`我的：${local.map((s) => s.name).join(' / ')}`)
  }

  // Remote stickers grouped by pack
  for (const [pack, entries] of _remotePacks) {
    lines.push(`${pack}：${entries.map((e) => e.name).join(' / ')}`)
  }

  const listSection = lines.length > 0
    ? `\n可用贴纸（按包分组）：\n${lines.map((l) => `- ${l}`).join('\n')}`
    : ''

  return (
    '\n\n## 表情包\n' +
    `你可以发表情包。直接用 \`[sticker:名字]\` 嵌入消息，名字从下方列表原样复制，一字不差。${listSection}\n` +
    '如果想先缩小范围，可调用 `search_stickers` 工具按关键词搜索（贴纸名是情感短语，搜"想你""懵""坏"等词而非"猫"）。' +
    '在合适的情绪下自然地用，不要每条都用。'
  )
}

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
