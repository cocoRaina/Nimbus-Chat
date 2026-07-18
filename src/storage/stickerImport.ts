// Batch sticker import: compress → (optional) AI naming → upload to the
// user's own Supabase (storage bucket `stickers` + table `stickers`).
// Remote rows are what search_stickers searches and what every device sees,
// so batch imports land there instead of localStorage (which is ~5MB and
// used to fail SILENTLY on quota — the "传不上去了" bug).

import { supabase } from '../supabase/client'

const BUCKET = 'stickers'
// Stickers render at chat-bubble size; 256px webp is ~10-30KB each, so even
// a few hundred stickers stay in single-digit MB of storage.
const MAX_DIMENSION = 256
const WEBP_QUALITY = 0.85
const JPEG_QUALITY = 0.85

export type PreparedSticker = {
  blob: Blob
  dataUrl: string
  /** Editable in the review dialog before upload. */
  name: string
}

// Names are functional: the AI sends by name and searches emotional phrases,
// and [sticker:名字] parsing breaks on [ ] and newlines.
export const sanitizeStickerName = (s: string): string =>
  s.replace(/[[\]\n\r]/g, '').trim().slice(0, 20)

const blobToDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('读取图片失败'))
    reader.readAsDataURL(blob)
  })

// 本地(localStorage)贴纸迁移上云用:老贴纸只有 data URL,转回 Blob 才能
// 走和批量导入同一条上传管线。
export const dataUrlToBlob = async (dataUrl: string): Promise<Blob> => {
  const res = await fetch(dataUrl)
  return res.blob()
}

const compressSticker = async (file: File): Promise<Blob> => {
  const bitmap = await createImageBitmap(file)
  let { width, height } = bitmap
  const longest = Math.max(width, height)
  if (longest > MAX_DIMENSION) {
    const ratio = MAX_DIMENSION / longest
    width = Math.max(1, Math.round(width * ratio))
    height = Math.max(1, Math.round(height * ratio))
  }
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  try {
    if (!ctx) throw new Error('无法获取 canvas context')
    ctx.drawImage(bitmap, 0, 0, width, height)
  } finally {
    bitmap.close()
  }
  const encode = (type: string, quality: number): Promise<Blob | null> =>
    new Promise((resolve) => canvas.toBlob((b) => resolve(b), type, quality))
  let blob = await encode('image/webp', WEBP_QUALITY)
  if (!blob || blob.type !== 'image/webp') {
    blob = await encode('image/jpeg', JPEG_QUALITY)
  }
  if (!blob) throw new Error('图片压缩失败')
  return blob
}

export type PrepareResult = {
  items: PreparedSticker[]
  /** Files that failed to decode/compress (e.g. HEIC the WebView can't read). */
  failures: Array<{ fileName: string; reason: string }>
}

export const prepareStickerFiles = async (files: File[]): Promise<PrepareResult> => {
  const items: PreparedSticker[] = []
  const failures: PrepareResult['failures'] = []
  for (const file of files) {
    try {
      if (!file.type.startsWith('image/')) throw new Error('不是图片文件')
      const blob = await compressSticker(file)
      const dataUrl = await blobToDataUrl(blob)
      const base = sanitizeStickerName(file.name.replace(/\.[^.]+$/, ''))
      items.push({ blob, dataUrl, name: base })
    } catch (error) {
      failures.push({
        fileName: file.name,
        reason: error instanceof Error ? error.message : '无法读取（可能是 HEIC 等不支持的格式）',
      })
    }
  }
  return { items, failures }
}

// Make every name non-empty and unique — within the batch AND against names
// already taken (stickers table has UNIQUE(user_id, name), a dup would fail
// the whole insert).
export const dedupeStickerNames = (rawNames: string[], taken: Set<string>): string[] => {
  const used = new Set(taken)
  return rawNames.map((raw, i) => {
    const base = sanitizeStickerName(raw) || `表情${i + 1}`
    let name = base
    for (let n = 2; used.has(name); n++) {
      name = sanitizeStickerName(`${base}${n}`) || `表情${i + 1}-${n}`
    }
    used.add(name)
    return name
  })
}

export type UploadOutcome = {
  uploaded: number
  failures: Array<{ name: string; reason: string }>
}

export const uploadStickerPack = async (
  items: PreparedSticker[],
  pack: string,
  onProgress?: (done: number, total: number) => void,
): Promise<UploadOutcome> => {
  if (!supabase) throw new Error('Supabase 未配置')
  const { data: userData, error: userError } = await supabase.auth.getUser()
  if (userError || !userData.user) throw new Error('未登录')
  const userId = userData.user.id

  const outcome: UploadOutcome = { uploaded: 0, failures: [] }
  // Per-item upload+insert (not one bulk insert): a single bad row must not
  // void the other 30 — the review dialog reports per-item failures instead.
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    try {
      const ext = item.blob.type === 'image/webp' ? 'webp' : 'jpg'
      const path = `${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${i}`}.${ext}`
      const { error: uploadError } = await supabase.storage
        .from(BUCKET)
        .upload(path, item.blob, { contentType: item.blob.type, upsert: false })
      if (uploadError) throw uploadError
      const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(path)
      const { error: insertError } = await supabase.from('stickers').insert({
        user_id: userId,
        name: item.name,
        url: urlData.publicUrl,
        pack,
      })
      if (insertError) {
        // Roll back the orphan file so a failed row doesn't leak storage.
        void supabase.storage.from(BUCKET).remove([path])
        throw insertError
      }
      outcome.uploaded++
    } catch (error) {
      outcome.failures.push({
        name: item.name,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
    onProgress?.(i + 1, items.length)
  }
  return outcome
}

// Delete a remote sticker: table row + (when the URL points into our bucket)
// the storage object behind it.
export const deleteRemoteSticker = async (name: string, url: string): Promise<void> => {
  if (!supabase) throw new Error('Supabase 未配置')
  const { data: userData } = await supabase.auth.getUser()
  const userId = userData?.user?.id
  if (!userId) throw new Error('未登录')
  const { error } = await supabase
    .from('stickers')
    .delete()
    .eq('user_id', userId)
    .eq('name', name)
  if (error) throw error
  const marker = `/object/public/${BUCKET}/`
  const idx = url.indexOf(marker)
  if (idx >= 0) {
    const path = decodeURIComponent(url.slice(idx + marker.length))
    void supabase.storage.from(BUCKET).remove([path])
  }
}
