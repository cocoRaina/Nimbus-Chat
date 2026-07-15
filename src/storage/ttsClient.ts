import { supabase } from '../supabase/client'
import { getTtsConfig } from './ttsConfig'

// 共享的 TTS 合成客户端：VoiceBubble（点播语音条）和 CallOverlay（通话
// 自动播报）共用。按文本缓存 object URL，重播/重渲染不再扣费。

const audioCache = new Map<string, string>()

export async function synthesizeSpeech(text: string): Promise<string> {
  const cached = audioCache.get(text)
  if (cached) return cached
  if (!supabase) throw new Error('Supabase 未配置')
  const cfg = getTtsConfig()
  const body = cfg.provider === 'elevenlabs'
    ? {
        provider: 'elevenlabs',
        text,
        voice_id: cfg.elVoiceId,
        api_key: cfg.elApiKey,
        model: cfg.elModel,
        stability: cfg.elStability,
      }
    : {
        provider: 'minimax',
        text,
        voice_id: cfg.voiceId,
        api_key: cfg.apiKey,
        group_id: cfg.groupId,
        base_url: cfg.baseUrl,
        model: cfg.model,
      }
  const { data, error } = await supabase.functions.invoke('tts', { body })
  if (error) throw new Error(error.message ?? String(error))
  const b64 = (data as { audio_base64?: string; error?: string })?.audio_base64
  if (!b64) throw new Error((data as { error?: string })?.error ?? '合成失败')
  const blob = await (await fetch(`data:audio/mp3;base64,${b64}`)).blob()
  const url = URL.createObjectURL(blob)
  audioCache.set(text, url)
  return url
}
