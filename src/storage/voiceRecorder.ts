import { supabase } from '../supabase/client'
import { vfetch, isVpsConfigured } from './vpsConfig'

// Blob → base64 (no data: prefix), for sending audio straight to the VPS.
const blobToBase64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onloadend = () => {
      const s = String(r.result || '')
      resolve(s.slice(s.indexOf(',') + 1)) // strip "data:...;base64,"
    }
    r.onerror = () => reject(new Error('read audio failed'))
    r.readAsDataURL(blob)
  })

export type VoiceRecording = {
  blob: Blob
  durationMs: number
  mimeType: string
}

export type TranscriptionResult = {
  text: string
  emotion: string | null
}

const BUCKET = 'voice-recordings'

export async function uploadVoiceRecording(
  recording: VoiceRecording,
  userId: string,
): Promise<{ url: string; path: string }> {
  if (!supabase) throw new Error('Supabase not configured')
  const ext = recording.mimeType.includes('ogg') ? 'ogg'
    : recording.mimeType.includes('mp4') ? 'mp4'
    : recording.mimeType.includes('wav') ? 'wav'
    : 'webm'
  const path = `${userId}/${Date.now()}.${ext}`
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, recording.blob, { contentType: recording.mimeType, upsert: false })
  if (error) throw new Error(`上传录音失败: ${error.message}`)
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path)
  return { url: data.publicUrl, path }
}

// Transcribe a recording. When a VPS is configured we send the audio bytes
// straight to the Tokyo VPS (→ SiliconFlow, both in Asia) instead of routing
// through the US Supabase edge function — much faster, and it doesn't depend on
// the storage upload finishing. Falls back to the edge function (needs the
// uploaded voiceUrl) when the VPS is absent or errors.
export async function transcribeVoice(
  voiceUrl: string,
  audio?: { blob: Blob; mimeType: string },
): Promise<TranscriptionResult> {
  if (audio && isVpsConfigured()) {
    try {
      const audio_base64 = await blobToBase64(audio.blob)
      const res = await vfetch('/api/transcribe', {
        method: 'POST',
        body: JSON.stringify({ audio_base64, mime: audio.mimeType }),
      })
      const data = await res.json()
      if (res.ok && !data.error) {
        return { text: data.text ?? '', emotion: data.emotion ?? null }
      }
      console.warn('VPS 转录失败，回退 Edge', data?.error)
    } catch (err) {
      console.warn('VPS 转录异常，回退 Edge', err)
    }
    // VPS failed. Only the edge function can help now, and it needs a real
    // voiceUrl — in the parallel path the caller passes '' (upload still in
    // flight), so signal failure and let the caller retry with the uploaded
    // URL instead of hitting the edge with an empty voice_url (→ 400).
    if (!voiceUrl) throw new Error('VPS transcribe failed; retry via edge with uploaded URL')
  }
  if (!supabase) throw new Error('Supabase not configured')
  const { data, error } = await supabase.functions.invoke('transcribe-voice', {
    body: { voice_url: voiceUrl },
  })
  if (error) throw error
  const result = data as { text?: string; emotion?: string | null }
  return { text: result.text ?? '', emotion: result.emotion ?? null }
}

// Pick the best supported MIME type for this device.
export function getBestMimeType(): string {
  for (const type of [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/ogg',
    'audio/mp4',
  ]) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) return type
  }
  return 'audio/webm'
}
