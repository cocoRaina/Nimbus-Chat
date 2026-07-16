import { supabase } from '../supabase/client'

// 🧸 玩具库（storage 层）。用户收藏喜欢的 artifact 小玩具：长按聊天里带
// 玩具的消息 →「收藏小玩具」→ 存进 toy_box 表。和相册存"书签"不同，
// 这里直接存代码本体——聊天记录哪天被压缩/清理了，收藏过的玩具照样能玩。
// 记忆库抽屉的「玩具库」栏用这一层读/删。

export type ToyEntry = {
  id: string
  title: string
  code: string
  note: string | null
  createdAt: string
}

type ToyRow = {
  id: string
  title: string
  code: string
  note: string | null
  created_at: string
}

const toEntry = (r: ToyRow): ToyEntry => ({
  id: r.id,
  title: r.title,
  code: r.code,
  note: r.note,
  createdAt: r.created_at,
})

export const fetchToys = async (limit = 200): Promise<ToyEntry[]> => {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('toy_box')
    .select('id, title, code, note, created_at')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return (data as ToyRow[] | null)?.map(toEntry) ?? []
}

// 收藏一个玩具。同一份代码（user+code 完全一致）已收藏时返回 already_saved
// ——小机可能忘了自己收过（和 save_to_album 一个套路）；用户手动重复收也
// 一并防住。code 比对在服务端做（eq 过滤），不用把库里的大文本拉下来。
export const saveToy = async (
  userId: string,
  title: string,
  code: string,
  note: string | null,
): Promise<{ saved: ToyEntry } | { already_saved: ToyEntry }> => {
  if (!supabase) throw new Error('Supabase 未配置')
  const { data: existing } = await supabase
    .from('toy_box')
    .select('id, title, code, note, created_at')
    .eq('user_id', userId)
    .eq('code', code)
    .maybeSingle()
  if (existing) {
    return { already_saved: toEntry(existing as ToyRow) }
  }
  const { data, error } = await supabase
    .from('toy_box')
    .insert({
      user_id: userId,
      title: title.trim() || '未命名小玩具',
      code,
      note: note?.trim() || null,
    })
    .select('id, title, code, note, created_at')
    .single()
  if (error) throw error
  return { saved: toEntry(data as ToyRow) }
}

export const removeToy = async (id: string): Promise<void> => {
  if (!supabase) return
  const { error } = await supabase.from('toy_box').delete().eq('id', id)
  if (error) throw error
}
