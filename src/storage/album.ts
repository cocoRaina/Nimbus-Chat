import { supabase } from '../supabase/client'

// 🖼 小机的相册（storage 层）。小机收藏聊天里出现过的图 → 只存书签
// （图 URL 引用 + 收藏理由 + 标签），图本身早在 chat-images bucket 里，
// 零额外存储。工具 save_to_album/browse_album 和 MemoryVaultPage 相册页
// 共用这一层。

export type AlbumEntry = {
  id: string
  imageUrl: string
  imagePath: string | null
  note: string | null
  tags: string[]
  source: string
  createdAt: string
}

type AlbumRow = {
  id: string
  image_url: string
  image_path: string | null
  note: string | null
  tags: string[] | null
  source: string
  created_at: string
}

const toEntry = (r: AlbumRow): AlbumEntry => ({
  id: r.id,
  imageUrl: r.image_url,
  imagePath: r.image_path,
  note: r.note,
  tags: Array.isArray(r.tags) ? r.tags : [],
  source: r.source,
  createdAt: r.created_at,
})

// chat-images 公网 URL → bucket path（.../object/public/chat-images/<path>）。
// 存 path 是为了将来加图片清理时能保护被收藏的图；拿不到就存 null。
const urlToPath = (url: string): string | null => {
  const m = /\/chat-images\/(.+)$/.exec(url)
  return m ? decodeURIComponent(m[1]) : null
}

export const fetchAlbum = async (limit = 200): Promise<AlbumEntry[]> => {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('assistant_album')
    .select('id, image_url, image_path, note, tags, source, created_at')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return (data as AlbumRow[] | null)?.map(toEntry) ?? []
}

// 收藏一张图。同一张图（user+url 唯一）已收藏时返回 already_saved + 原条目，
// 让小机自己判断要不要改理由（和 add_memory 的 already_saved 一个套路）。
export const saveToAlbum = async (
  userId: string,
  imageUrl: string,
  note: string | null,
  tags: string[],
): Promise<{ saved: AlbumEntry } | { already_saved: AlbumEntry } | { updated: AlbumEntry }> => {
  if (!supabase) throw new Error('Supabase 未配置')
  const { data: existing } = await supabase
    .from('assistant_album')
    .select('id, image_url, image_path, note, tags, source, created_at')
    .eq('user_id', userId)
    .eq('image_url', imageUrl)
    .maybeSingle()
  if (existing) {
    const ex = toEntry(existing as AlbumRow)
    const newNote = note?.trim() || null
    // 已收藏，但这次带了新备注、且和原来不同（含"原来没备注"）→ 补/改备注
    // （+ 有新标签就一并更新）。这就是小机给旧图补备注的路径。
    if (newNote && newNote !== ex.note) {
      const patch: { note: string; tags?: string[] } = { note: newNote }
      if (tags.length > 0) patch.tags = tags
      await updateAlbumEntry(ex.id, patch)
      return { updated: { ...ex, note: newNote, tags: tags.length > 0 ? tags : ex.tags } }
    }
    return { already_saved: ex }
  }
  const { data, error } = await supabase
    .from('assistant_album')
    .insert({
      user_id: userId,
      image_url: imageUrl,
      image_path: urlToPath(imageUrl),
      note: note?.trim() || null,
      tags,
      source: 'chat',
    })
    .select('id, image_url, image_path, note, tags, source, created_at')
    .single()
  if (error) throw error
  return { saved: toEntry(data as AlbumRow) }
}

export const removeFromAlbum = async (id: string): Promise<void> => {
  if (!supabase) return
  const { error } = await supabase.from('assistant_album').delete().eq('id', id)
  if (error) throw error
}

// 更新收藏理由/标签（相册页里用户或小机改）
export const updateAlbumEntry = async (
  id: string,
  patch: { note?: string | null; tags?: string[] },
): Promise<void> => {
  if (!supabase) return
  const { error } = await supabase.from('assistant_album').update(patch).eq('id', id)
  if (error) throw error
}
