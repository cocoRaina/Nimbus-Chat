// Shared sticker set — both the user and the AI send stickers by NAME via the
// `[sticker:名字]` marker (rendered to the image). Images are compressed to a
// small PNG data URL and kept in localStorage; the AI is told the available
// names (see buildStickerSystemSection) so it can pick one.

export type Sticker = { name: string; desc: string; dataUrl: string }

const KEY = 'nimbus_stickers_v1'

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

export const findSticker = (name: string): Sticker | null =>
  getStickers().find((x) => x.name === name) ?? null

// Injected into the chat system prompt so the AI knows which stickers exist.
export const buildStickerSystemSection = (): string => {
  const all = getStickers()
  if (all.length === 0) return ''
  const list = all.map((s) => (s.desc ? `${s.name}（${s.desc}）` : s.name)).join('、')
  return `\n\n## 可用表情包\n你可以用 \`[sticker:名字]\` 发表情包（用户也会这样发给你）。可用：${list}。在合适的情绪/语气下自然地用，一次最多一个，别滥用。`
}

// Compress an imported image to a small PNG data URL (keeps transparency).
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
