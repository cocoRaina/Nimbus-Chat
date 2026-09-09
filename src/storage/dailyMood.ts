import { supabase } from '../supabase/client'

// 每日心情：Wren(user) 每天一条（upsert）；小克(ai) 追加多条（碎碎念）。
// ai 那条由 autonomous_wake 写；user 那条在 Moments 的「碎碎念」tab 里写。

export type MoodAuthor = 'user' | 'ai'

export type DailyMood = {
  id: number
  moodDate: string // YYYY-MM-DD
  author: MoodAuthor
  emoji: string | null
  text: string | null
  createdAt: string
}

type DailyMoodRow = {
  id: number
  mood_date: string
  author: string
  emoji: string | null
  text: string | null
  created_at: string
}

const map = (r: DailyMoodRow): DailyMood => ({
  id: r.id,
  moodDate: r.mood_date,
  author: r.author === 'ai' ? 'ai' : 'user',
  emoji: r.emoji,
  text: r.text,
  createdAt: r.created_at,
})

export const todayMoodDate = (): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())

// 拉 AI 碎碎念（可能一天多条）+ 用户心情（每天一条）。
export const fetchDailyMoods = async (limit = 100): Promise<DailyMood[]> => {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('daily_moods')
    .select('id, mood_date, author, emoji, text, created_at')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) {
    console.warn('加载每日心情失败', error)
    return []
  }
  return (data ?? []).map((r) => map(r as DailyMoodRow))
}

// 写/更新 Wren 今天的心情（每人每天一条，upsert on partial unique index）。
export const upsertMyMood = async (text: string): Promise<DailyMood | null> => {
  if (!supabase) return null
  const { data: userData } = await supabase.auth.getUser()
  const userId = userData.user?.id
  if (!userId) return null
  const { data, error } = await supabase
    .from('daily_moods')
    .upsert(
      {
        user_id: userId,
        mood_date: todayMoodDate(),
        author: 'user',
        emoji: null,
        text: text.trim() || null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,mood_date,author' },
    )
    .select('id, mood_date, author, emoji, text, created_at')
    .maybeSingle()
  if (error) {
    console.warn('保存心情失败', error)
    return null
  }
  return data ? map(data as DailyMoodRow) : null
}
