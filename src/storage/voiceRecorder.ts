import { supabase } from '../supabase/client'

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

export async function transcribeVoice(voiceUrl: string): Promise<TranscriptionResult> {
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
