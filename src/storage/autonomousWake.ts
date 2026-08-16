import { supabase } from '../supabase/client'

// 自主唤醒的设置：单行状态表 autonomous_state（id=1，单租户、开放 RLS）。
// 这里只碰「用户可调」的三个字段：
//   enabled           —— 总开关
//   wake_provider     —— 走哪个站：'openrouter' | 'relay'（relay=聊天用的中转，
//                        服务端按 Supabase 密钥 RELAY_BASE_URL/RELAY_API_KEY 路由）
//   max_wakes_per_day —— 每天最多醒几次（1–12）
// 其余字段（next_wake_at / wakes_today / mood …）由 autonomous_wake 函数自己维护，
// 客户端不动。

export type WakeProvider = 'openrouter' | 'relay'

export type AutonomousWakeConfig = {
  enabled: boolean
  wakeProvider: WakeProvider
  maxWakesPerDay: number
}

export const DEFAULT_WAKE_CONFIG: AutonomousWakeConfig = {
  enabled: true,
  wakeProvider: 'openrouter',
  maxWakesPerDay: 6,
}

const clampWakes = (n: unknown): number => {
  const v = typeof n === 'number' ? n : Number(n)
  if (!Number.isFinite(v)) return DEFAULT_WAKE_CONFIG.maxWakesPerDay
  return Math.max(1, Math.min(12, Math.round(v)))
}

// 读当前配置。表里没有行（理论上不该）时返回默认值。
export const fetchAutonomousWakeConfig = async (): Promise<AutonomousWakeConfig> => {
  if (!supabase) return DEFAULT_WAKE_CONFIG
  const { data, error } = await supabase
    .from('autonomous_state')
    .select('enabled, wake_provider, max_wakes_per_day')
    .eq('id', 1)
    .maybeSingle()
  if (error || !data) return DEFAULT_WAKE_CONFIG
  return {
    enabled: data.enabled !== false,
    wakeProvider: data.wake_provider === 'relay' ? 'relay' : 'openrouter',
    maxWakesPerDay: clampWakes(data.max_wakes_per_day),
  }
}

// 保存配置。只更新这三个字段，不碰状态字段。
export const saveAutonomousWakeConfig = async (
  cfg: AutonomousWakeConfig,
): Promise<{ ok: boolean; error?: string }> => {
  if (!supabase) return { ok: false, error: '未连接 Supabase' }
  const { error } = await supabase
    .from('autonomous_state')
    .update({
      enabled: cfg.enabled,
      wake_provider: cfg.wakeProvider,
      max_wakes_per_day: clampWakes(cfg.maxWakesPerDay),
      updated_at: new Date().toISOString(),
    })
    .eq('id', 1)
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}
