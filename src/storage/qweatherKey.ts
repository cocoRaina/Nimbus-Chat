const KEY_PREFIX = 'nimbus_qweather_v2_'

export type QWeatherCredential = {
  privateKeyPem: string  // Ed25519 private key PEM from console "API KEY" field
  credentialId: string   // 凭据ID (kid in JWT header)
  projectId: string      // 项目ID (sub in JWT payload)
}

const load = (): QWeatherCredential | null => {
  if (typeof window === 'undefined') return null
  const pem = window.localStorage.getItem(KEY_PREFIX + 'pem') ?? ''
  const kid = window.localStorage.getItem(KEY_PREFIX + 'kid') ?? ''
  const sub = window.localStorage.getItem(KEY_PREFIX + 'sub') ?? ''
  if (!pem || !kid || !sub) return null
  return { privateKeyPem: pem, credentialId: kid, projectId: sub }
}

export const getQWeatherCredential = (): QWeatherCredential | null => load()

export const hasQWeatherCredential = (): boolean => load() !== null

export const saveQWeatherCredential = (c: QWeatherCredential) => {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(KEY_PREFIX + 'pem', c.privateKeyPem.trim())
  window.localStorage.setItem(KEY_PREFIX + 'kid', c.credentialId.trim())
  window.localStorage.setItem(KEY_PREFIX + 'sub', c.projectId.trim())
}

export const clearQWeatherCredential = () => {
  if (typeof window === 'undefined') return
  window.localStorage.removeItem(KEY_PREFIX + 'pem')
  window.localStorage.removeItem(KEY_PREFIX + 'kid')
  window.localStorage.removeItem(KEY_PREFIX + 'sub')
  // also clear old v1 key if present
  window.localStorage.removeItem('nimbus_qweather_key_v1')
}

// Generate a short-lived Ed25519 JWT for QWeather API calls.
// TTL is 5 minutes; caller should regenerate on each request (cheap).
export const generateQWeatherJWT = async (c: QWeatherCredential): Promise<string> => {
  const pemContents = c.privateKeyPem
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s/g, '')
  const binaryDer = Uint8Array.from(atob(pemContents), ch => ch.charCodeAt(0))

  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    binaryDer.buffer,
    { name: 'Ed25519' },
    false,
    ['sign'],
  )

  const b64url = (source: ArrayBuffer | string): string => {
    const encoded = typeof source === 'string'
      ? btoa(unescape(encodeURIComponent(source)))
      : btoa(String.fromCharCode(...new Uint8Array(source)))
    return encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
  }

  const now = Math.floor(Date.now() / 1000)
  const header = b64url(JSON.stringify({ alg: 'EdDSA', kid: c.credentialId }))
  const payload = b64url(JSON.stringify({ sub: c.projectId, iat: now, exp: now + 300 }))
  const message = `${header}.${payload}`
  const sig = await crypto.subtle.sign(
    { name: 'Ed25519' },
    privateKey,
    new TextEncoder().encode(message),
  )
  return `${message}.${b64url(sig)}`
}
