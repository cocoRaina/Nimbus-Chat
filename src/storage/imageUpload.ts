import { supabase } from '../supabase/client'

const BUCKET = 'chat-images'
// Size directly drives cost on relays that bill images by base64 length
// (~1.4 chars/token — a 148KB jpeg billed ~139k tokens, 10x a whole chat
// turn; see docs/caching.md §8). 1024px long side is still near Claude
// vision's physical-token sweet spot (~1092px); WebP shaves another ~30%
// over JPEG at like quality. Trade-off: fine print in screenshots gets
// slightly softer than the old 1568px/jpeg-0.85.
const MAX_DIMENSION = 1024
const WEBP_QUALITY = 0.8
// Fallback for engines whose canvas.toBlob can't encode WebP (they return
// a blob of a different type instead) — e.g. iOS Safari yields PNG.
const JPEG_QUALITY = 0.82

export type UploadedImage = {
  url: string
  path: string
  width: number
  height: number
  sizeBytes: number
  // The compressed bytes that were actually uploaded. generate_image reads
  // this to build the data-URL image block it feeds back to the model —
  // re-downloading our own public URL would be a wasted round trip.
  blob: Blob
}

const compressImage = async (file: Blob): Promise<Blob> => {
  const bitmap = await createImageBitmap(file)
  let { width, height } = bitmap
  const longest = Math.max(width, height)
  if (longest > MAX_DIMENSION) {
    const ratio = MAX_DIMENSION / longest
    width = Math.round(width * ratio)
    height = Math.round(height * ratio)
  }
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  // try/finally so the bitmap GPU handle is always released — drawImage
  // can throw on giant images on Android WebView and we shouldn't leak.
  try {
    if (!ctx) {
      throw new Error('无法获取 canvas context')
    }
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
  if (!blob) {
    throw new Error('图片压缩失败')
  }
  return blob
}

const randomFilename = (ext: string) => {
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${id}.${ext}`
}

export const uploadChatImage = async (file: File | Blob): Promise<UploadedImage> => {
  if (!supabase) {
    throw new Error('Supabase 客户端未配置')
  }
  if (!file.type.startsWith('image/')) {
    throw new Error('只支持图片文件')
  }
  const blob = await compressImage(file)
  const path = randomFilename(blob.type === 'image/webp' ? 'webp' : 'jpg')
  const { error } = await supabase.storage.from(BUCKET).upload(path, blob, {
    contentType: blob.type,
    upsert: false,
  })
  if (error) {
    throw error
  }
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path)
  const objectUrl = URL.createObjectURL(blob)
  const img = new Image()
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('读取图片尺寸失败'))
    img.src = objectUrl
  })
  const dimensions = { width: img.naturalWidth, height: img.naturalHeight }
  URL.revokeObjectURL(objectUrl)
  return {
    url: data.publicUrl,
    path,
    width: dimensions.width,
    height: dimensions.height,
    sizeBytes: blob.size,
    blob,
  }
}

export const deleteChatImage = async (path: string): Promise<void> => {
  if (!supabase) return
  const { error } = await supabase.storage.from(BUCKET).remove([path])
  if (error) {
    console.warn('删除图片失败', error)
  }
}

type BucketFile = { name: string; created_at?: string; metadata?: { size?: number } | null }

// 列 chat-images 桶（分页，flat 路径——上传用随机文件名无子目录）。
const listBucketFiles = async (): Promise<BucketFile[]> => {
  if (!supabase) return []
  const all: BucketFile[] = []
  const PAGE = 1000
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .list('', { limit: PAGE, offset, sortBy: { column: 'created_at', order: 'asc' } })
    if (error) throw error
    const batch = (data ?? []) as BucketFile[]
    all.push(...batch)
    if (batch.length < PAGE) break
  }
  return all
}

// 按 bucket path 还原 chat-images 公网 URL（save_to_album 按 ref 存指定图用）。
export const chatImagePublicUrl = (path: string): string | null => {
  if (!supabase || !path) return null
  return supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl
}

// 📷 列出 storage 里所有照片（给小机的 list_photos 用）：公网 URL + path +
// 时间，newest first。描述(caption)和在不在相册由调用方补。
export type StoredPhoto = { url: string; path: string; createdAt: string | null }

export const listStoredPhotos = async (): Promise<StoredPhoto[]> => {
  if (!supabase) return []
  const files = await listBucketFiles()
  return files
    .map((f) => ({
      url: supabase!.storage.from(BUCKET).getPublicUrl(f.name).data.publicUrl,
      path: f.name,
      createdAt: f.created_at ?? null,
    }))
    .sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime())
}

// 🧹 整理 chat-images 桶：删掉超过 days 天、且没被收藏进相册的老图。
// 相册收藏的（assistant_album.image_path）永远保护。dry_run 只统计不删。
// 老气泡里被删的图会显示占位，但文字描述（imageCaptions）还在，上下文不丢。
export type TidyResult = { removed: number; freedBytes: number; kept: number; protectedByAlbum: number }

export const tidyOldImages = async (
  days = 30,
  dryRun = false,
): Promise<TidyResult> => {
  if (!supabase) throw new Error('Supabase 未配置')
  const cutoffDays = Math.max(7, Math.round(days))
  const cutoff = Date.now() - cutoffDays * 86400_000

  // 相册保护清单：收藏图的 bucket path
  const { data: albumRows } = await supabase.from('assistant_album').select('image_path')
  const protectedPaths = new Set(
    (albumRows ?? [])
      .map((r) => (r as { image_path: string | null }).image_path)
      .filter((p): p is string => Boolean(p)),
  )

  const all = await listBucketFiles()
  const doomed = all.filter((f) => {
    if (protectedPaths.has(f.name)) return false // 相册收藏，保护
    const created = f.created_at ? new Date(f.created_at).getTime() : 0
    return created > 0 && created < cutoff // 够老才删
  })
  const freedBytes = doomed.reduce((s, f) => s + (f.metadata?.size ?? 0), 0)
  const result: TidyResult = {
    removed: 0,
    freedBytes,
    kept: all.length - doomed.length,
    protectedByAlbum: protectedPaths.size,
  }
  if (dryRun || doomed.length === 0) {
    result.removed = 0
    return { ...result, removed: dryRun ? doomed.length : 0 }
  }
  // 分批删（storage remove 一次别塞太多）
  for (let i = 0; i < doomed.length; i += 100) {
    const names = doomed.slice(i, i + 100).map((f) => f.name)
    const { error } = await supabase.storage.from(BUCKET).remove(names)
    if (error) throw error
    result.removed += names.length
  }
  return result
}
