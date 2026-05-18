import { supabase } from '../supabase/client'

const BUCKET = 'chat-images'
const MAX_DIMENSION = 1568 // Claude vision recommended long-side max
const TARGET_QUALITY = 0.85

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
  if (!ctx) {
    bitmap.close()
    throw new Error('无法获取 canvas context')
  }
  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  const blob: Blob | null = await new Promise((resolve) =>
    canvas.toBlob((b) => resolve(b), 'image/jpeg', TARGET_QUALITY),
  )
  if (!blob) {
    throw new Error('图片压缩失败')
  }
  return blob
}

const randomFilename = () => {
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${id}.jpg`
}

export const uploadChatImage = async (file: File): Promise<UploadedImage> => {
  if (!supabase) {
    throw new Error('Supabase 客户端未配置')
  }
  if (!file.type.startsWith('image/')) {
    throw new Error('只支持图片文件')
  }
  const blob = await compressImage(file)
  const path = randomFilename()
  const { error } = await supabase.storage.from(BUCKET).upload(path, blob, {
    contentType: 'image/jpeg',
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
