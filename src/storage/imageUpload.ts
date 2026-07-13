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
}

const compressImage = async (file: File): Promise<Blob> => {
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

export const uploadChatImage = async (file: File): Promise<UploadedImage> => {
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
  }
}

export const deleteChatImage = async (path: string): Promise<void> => {
  if (!supabase) return
  const { error } = await supabase.storage.from(BUCKET).remove([path])
  if (error) {
    console.warn('删除图片失败', error)
  }
}
