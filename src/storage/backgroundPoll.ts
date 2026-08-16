import { Capacitor } from '@capacitor/core'
import { BackgroundRunner } from '@capacitor/background-runner'
import { supabase } from '../supabase/client'
import { readLocalSupabaseConfig } from './supabaseConfig'
import { getAssistantName } from './assistantPersona'

// 后台轮询接线：把 proactive_peek 需要的配置（端点 URL / anon key / peek_secret /
// 助手名）塞进 background-runner 的 CapacitorKV，供 runners/proactive.js 每 ~15min
// 拉起时用。peek_secret 存进 autonomous_state（后台任务没登录态，靠它自校验）。
// 仅原生有效；纯前端/网页无后台任务。

const SECRET_KEY = 'nimbus_peek_secret_v1'
const RUNNER_LABEL = 'com.cocoraina.nimbuschat.proactive'

const genSecret = (): string => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '')
  }
  return `${Date.now()}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`
}

const resolveUrlKey = (): { url: string; anon: string } | null => {
  const local = readLocalSupabaseConfig()
  if (local?.url && local?.anonKey) return { url: local.url, anon: local.anonKey }
  const envUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined
  const envKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
  if (envUrl?.trim() && envKey?.trim()) return { url: envUrl.trim(), anon: envKey.trim() }
  return null
}

export const setupBackgroundPoll = async (): Promise<void> => {
  if (Capacitor.getPlatform() === 'web') return
  if (!supabase) return
  const uk = resolveUrlKey()
  if (!uk) return

  try {
    // peek_secret：优先用服务端已有的；没有就本地生成一个写上去，两边对齐。
    let secret = ''
    try { secret = localStorage.getItem(SECRET_KEY) ?? '' } catch { /* ignore */ }

    const { data: st } = await supabase
      .from('autonomous_state').select('peek_secret').eq('id', 1).maybeSingle()
    const serverSecret = (st as { peek_secret?: string } | null)?.peek_secret ?? ''

    if (serverSecret) {
      secret = serverSecret
    } else {
      if (!secret) secret = genSecret()
      await supabase.from('autonomous_state').update({ peek_secret: secret }).eq('id', 1)
    }
    try { localStorage.setItem(SECRET_KEY, secret) } catch { /* ignore */ }

    const cfg = JSON.stringify({
      fnUrl: `${uk.url.replace(/\/+$/, '')}/functions/v1/proactive_peek`,
      anon: uk.anon,
      secret,
      name: getAssistantName(),
    })

    await BackgroundRunner.dispatchEvent({
      label: RUNNER_LABEL,
      event: 'saveConfig',
      details: { cfg },
    })
  } catch (e) {
    console.warn('后台轮询配置失败', e)
  }
}
