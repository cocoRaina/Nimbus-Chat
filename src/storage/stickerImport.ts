// Batch sticker import: compress → (optional) AI naming → upload to the
// user's own Supabase (storage bucket `stickers` + table `stickers`).
// Remote rows are what search_stickers searches and what every device sees,
// so batch imports land there instead of localStorage (which is ~5MB and
// used to fail SILENTLY on quota — the "传不上去了" bug).

import { supabase } from '../supabase/client'
import { fetchOpenRouter } from '../api/openrouter'
import type { ProviderId } from './apiProvider'

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
  /** 小机看图生成的视觉描述（可选）。search_stickers 连它一起搜，让它按画面内容挑表情。 */
  description?: string
}

// Names are functional: the AI sends by name and searches emotional phrases,
// and [sticker:名字] parsing breaks on [ ] and newlines.
export const sanitizeStickerName = (s: string): string =>
  s.replace(/[[\]\n\r]/g, '').trim().slice(0, 20)

// 让小机看一张表情图，返回它自己起的名字 + 一句视觉描述。走当前渠道（现在是中转，
// 便宜且支持视觉）。失败返回 null，调用方保留原名（文件名）即可，优雅回退。
//
// ⚠️ 用「两行纯文本」而不是 JSON：表情的配文常带引号（例：配文"我睡睡睡睡"），
// 塞进 JSON 字符串会顶破 `"` 导致 JSON.parse 失败——实测 92% 的失败就是这么来的
// （侥幸成功的都是配文用单引号的）。两行格式无引号转义问题，且能容忍模型
// 前置的 <think> 思考块。
const CAPTION_PROMPT =
  '看这张聊天表情包/贴纸，严格用下面两行回答，不要 JSON、不要多余的话、不要解释：\n' +
  '名字：给它起个≤10字的名字，像人发表情时脑子里会冒出的短语，体现情绪/动作/场景（例：小猫生气、躲被窝里哭、早安亲亲、白眼三连）\n' +
  '描述：一句话客观描述图里画了啥（主体/表情/动作/画面里的文字）'

// 从回复里抠出「名字：」「描述：」两行的值。先去掉模型可能前置的 <think> 块，
// 再逐行找标签（中英文冒号都认）。任何一行缺失就返回空串，调用方按需回退。
const pickLabeledLine = (text: string, labels: string[]): string => {
  const clean = text.replace(/<think>[\s\S]*?<\/think>/gi, '')
  for (const line of clean.split(/\r?\n/)) {
    const t = line.trim().replace(/^[-*•\s]+/, '')
    for (const lab of labels) {
      if (t.startsWith(lab)) return t.slice(lab.length).replace(/^[：:\s]+/, '').trim()
    }
  }
  return ''
}

export type StickerCaption = { name: string; description: string }

export const captionStickerImage = async (
  dataUrl: string,
  model: string,
  provider: ProviderId,
): Promise<StickerCaption | null> => {
  if (!dataUrl || !model) return null
  try {
    const response = await fetchOpenRouter('/chat/completions', {
      provider,
      body: {
        model,
        stream: false,
        max_tokens: 300,
        temperature: 0.4,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: CAPTION_PROMPT },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
      },
    })
    if (!response.ok) {
      console.warn(`表情视觉命名失败 status=${response.status}`, await response.text().catch(() => ''))
      return null
    }
    const payload = (await response.json()) as Record<string, unknown>
    const choice = (payload.choices as Array<Record<string, unknown>> | undefined)?.[0]
    const message = (choice?.message as Record<string, unknown> | undefined) ?? {}
    const raw = typeof message.content === 'string' ? message.content : ''
    const name = sanitizeStickerName(pickLabeledLine(raw, ['名字', '名称', 'name', 'Name']))
    const description = pickLabeledLine(raw, ['描述', 'desc', 'Desc', '描述文字']).slice(0, 200)
    if (!name && !description) return null
    return { name, description }
  } catch (err) {
    console.warn('表情视觉命名异常', err)
    return null
  }
}

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
        description: item.description?.trim() || null,
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

// 给旧表情一键补视觉描述：找出 description 为空的行，逐张让小机看图写一句描述，
// 只更新 description、**不动名字**（旧表情名字通常已经很好）。返回处理进度。
export type BackfillOutcome = { total: number; done: number; filled: number; failed: number }

export const backfillStickerDescriptions = async (
  model: string,
  provider: ProviderId,
  onProgress?: (done: number, total: number) => void,
): Promise<BackfillOutcome> => {
  if (!supabase) throw new Error('Supabase 未配置')
  const { data: userData } = await supabase.auth.getUser()
  const userId = userData?.user?.id
  if (!userId) throw new Error('未登录')

  const { data, error } = await supabase
    .from('stickers')
    .select('name, url')
    .eq('user_id', userId)
    .is('description', null)
  if (error) throw error
  const rows = (data ?? []) as Array<{ name: string; url: string }>
  const outcome: BackfillOutcome = { total: rows.length, done: 0, filled: 0, failed: 0 }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    try {
      const cap = await captionStickerImage(row.url, model, provider)
      const desc = cap?.description?.trim()
      if (desc) {
        const { error: upErr } = await supabase
          .from('stickers')
          .update({ description: desc })
          .eq('user_id', userId)
          .eq('name', row.name)
        if (upErr) outcome.failed++
        else outcome.filled++
      } else {
        outcome.failed++
      }
    } catch {
      outcome.failed++
    }
    outcome.done = i + 1
    onProgress?.(outcome.done, outcome.total)
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
