// send_proactive_push — delivers due scheduled proactive_queue messages as
// FCM push notifications. Invoked every minute by pg_cron (job 1).
//
// Credentials: the Firebase service-account private key MUST be provided via
// the FIREBASE_PRIVATE_KEY Edge Function secret (Project Settings → Edge
// Functions → Secrets). It used to be hard-coded inline as a fallback; that
// was removed so the key never lives in version control. If the secret is
// missing the function fails fast rather than silently using a stale key.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1'

const FIREBASE_PROJECT_ID = 'nimbus-chat-3a27e'
const FCM_ENDPOINT = `https://fcm.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/messages:send`

const SA_CLIENT_EMAIL = 'firebase-adminsdk-fbsvc@nimbus-chat-3a27e.iam.gserviceaccount.com'
const SA_PRIVATE_KEY = Deno.env.get('FIREBASE_PRIVATE_KEY')
const TOKEN_URI = 'https://oauth2.googleapis.com/token'

function base64url(data: Uint8Array | string): string {
  const str = typeof data === 'string' ? data : String.fromCharCode(...data)
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

async function getAccessToken(): Promise<string> {
  if (!SA_PRIVATE_KEY) {
    throw new Error('FIREBASE_PRIVATE_KEY secret is not set')
  }
  const pem = SA_PRIVATE_KEY
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\n/g, '')
  const binaryKey = Uint8Array.from(atob(pem), c => c.charCodeAt(0))
  const key = await crypto.subtle.importKey(
    'pkcs8', binaryKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign'],
  )
  const now = Math.floor(Date.now() / 1000)
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = base64url(JSON.stringify({
    iss: SA_CLIENT_EMAIL,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: TOKEN_URI,
    iat: now,
    exp: now + 3600,
  }))
  const sigInput = new TextEncoder().encode(`${header}.${payload}`)
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, sigInput))
  const jwt = `${header}.${payload}.${base64url(sig)}`
  const resp = await fetch(TOKEN_URI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  })
  if (!resp.ok) throw new Error(`OAuth2 failed: ${resp.status} ${await resp.text()}`)
  return ((await resp.json()) as { access_token: string }).access_token
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { status: 200 })
  }
  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )
    const { data: due, error } = await supabase
      .from('proactive_queue')
      .select('*')
      .lte('fire_at', new Date().toISOString())
      .eq('sent', false)
      .limit(10)
    if (error || !due || due.length === 0) {
      return new Response(JSON.stringify({ processed: 0 }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }
    // Get FCM tokens for the users in the queue
    const userIds = [...new Set(due.map((d: { user_id: string }) => d.user_id))]
    const { data: tokens } = await supabase
      .from('fcm_tokens')
      .select('user_id, token')
      .in('user_id', userIds)
    const tokenMap = new Map((tokens ?? []).map((t: { user_id: string; token: string }) => [t.user_id, t.token]))
    const accessToken = await getAccessToken()
    let sent = 0
    for (const msg of due) {
      const fcmToken = tokenMap.get(msg.user_id)
      if (!fcmToken) {
        await supabase.from('proactive_queue').update({ sent: true }).eq('id', msg.id)
        continue
      }
      try {
        const fcmResp = await fetch(FCM_ENDPOINT, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            message: {
              token: fcmToken,
              notification: { title: '哥哥', body: msg.text },
              data: { session_id: msg.session_id, proactive_id: msg.id, text: msg.text },
            },
          }),
        })
        if (!fcmResp.ok) {
          console.warn(`FCM ${fcmResp.status}:`, await fcmResp.text())
        } else {
          sent++
        }
      } catch (e) {
        console.warn('FCM send error:', e)
      }
      await supabase.from('proactive_queue').update({ sent: true }).eq('id', msg.id)
    }
    return new Response(JSON.stringify({ processed: sent }), {
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 })
  }
})
