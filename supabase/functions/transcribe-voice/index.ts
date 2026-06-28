import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from 'jsr:@supabase/supabase-js@2'

// Proxy SiliconFlow SenseVoiceSmall transcription + emotion recognition.
// The client uploads audio to Supabase Storage and passes the public URL here.
// We fetch the audio, forward to SiliconFlow, and return cleaned transcription
// + detected emotion tag (HAPPY / SAD / ANGRY / NEUTRAL / ...).

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', ...CORS } })

// SenseVoice embeds emotion tags in the transcription.
// Handles both formats:
//   <|HAPPY|><|zh|><|Speech|>...<|withitn|>实际文字
//   HAPPY|实际文字
function parseTranscription(text: string): { cleanText: string; emotion: string | null } {
  // SenseVoice emotion tags (7 primary + unknown + meaningful audio events)
  const EMOTION_TAGS = /^(HAPPY|SAD|ANGRY|NEUTRAL|SURPRISED|FEARFUL|DISGUSTED|LAUGHTER|CRY|Unknown_Emo)$/i
  let emotion: string | null = null
  let hasSetEmotion = false
  let cleaned = text

  // Strip <|TAG|> angle-bracket markers; capture the first meaningful emotion/event tag.
  // Use a separate flag so NEUTRAL (which maps to null) doesn't leave the slot open for
  // a later tag to overwrite it.
  cleaned = cleaned.replace(/<\|([^|]+)\|>/g, (_, tag: string) => {
    if (!hasSetEmotion && EMOTION_TAGS.test(tag)) {
      const upper = tag.toUpperCase()
      emotion = (upper === 'UNKNOWN_EMO' || upper === 'NEUTRAL') ? null : upper
      hasSetEmotion = true
    }
    return ''
  })

  // Pipe-prefix format: "HAPPY|text"
  const pipeMatch = /^(HAPPY|SAD|ANGRY|NEUTRAL|SURPRISED|FEARFUL|DISGUSTED|LAUGHTER|CRY)\|/i.exec(cleaned)
  if (pipeMatch) {
    if (!emotion) emotion = pipeMatch[1].toUpperCase()
    cleaned = cleaned.slice(pipeMatch[0].length)
  }

  return { cleanText: cleaned.trim(), emotion }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
  const sfKey = Deno.env.get('SILICONFLOW_API_KEY') ?? ''

  const authHeader = req.headers.get('Authorization') ?? req.headers.get('authorization') ?? ''
  const apikey = req.headers.get('apikey') ?? ''

  if (!authHeader || !apikey) return json({ error: 'missing auth headers' }, 401)

  const sb = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader, apikey } },
  })
  const { data: { user }, error: userError } = await sb.auth.getUser()
  if (userError || !user) return json({ error: 'invalid auth token' }, 401)

  if (!sfKey) return json({ error: 'SILICONFLOW_API_KEY not configured' }, 500)

  let body: { voice_url?: string }
  try { body = await req.json() } catch { return json({ error: 'invalid JSON' }, 400) }

  const voiceUrl = (body.voice_url ?? '').trim()
  if (!voiceUrl) return json({ error: 'voice_url required' }, 400)

  // Fetch audio from Supabase Storage public URL
  let audioBlob: Blob
  let contentType: string
  try {
    const audioRes = await fetch(voiceUrl)
    if (!audioRes.ok) return json({ error: `fetch audio failed: ${audioRes.status}` }, 400)
    audioBlob = await audioRes.blob()
    contentType = audioRes.headers.get('content-type') ?? 'audio/webm'
  } catch (err) {
    return json({ error: `fetch audio error: ${String(err)}` }, 400)
  }

  const ext = contentType.includes('ogg') ? 'ogg'
    : contentType.includes('mp4') ? 'mp4'
    : contentType.includes('wav') ? 'wav'
    : 'webm'

  // Forward to SiliconFlow SenseVoiceSmall
  const formData = new FormData()
  formData.append('model', 'FunAudioLLM/SenseVoiceSmall')
  formData.append('file', new File([audioBlob], `recording.${ext}`, { type: contentType }))

  let sfData: { text?: string }
  try {
    const sfRes = await fetch('https://api.siliconflow.cn/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${sfKey}` },
      body: formData,
    })
    if (!sfRes.ok) {
      const errText = await sfRes.text()
      return json({ error: `SiliconFlow error ${sfRes.status}: ${errText}` }, 502)
    }
    sfData = await sfRes.json() as { text?: string }
  } catch (err) {
    return json({ error: `SiliconFlow request failed: ${String(err)}` }, 502)
  }

  const rawText = sfData.text ?? ''
  const { cleanText, emotion } = parseTranscription(rawText)

  return json({ text: cleanText, emotion, raw: rawText })
})
