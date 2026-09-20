import { vfetch, isVpsConfigured } from './vpsConfig'

const PUSH_SUBSCRIBED_KEY = 'nimbus_push_subscribed'

export const isPushSupported = (): boolean =>
  'serviceWorker' in navigator && 'PushManager' in window

export const isPushSubscribed = (): boolean => {
  try {
    return localStorage.getItem(PUSH_SUBSCRIBED_KEY) === '1'
  } catch {
    return false
  }
}

export const subscribePush = async (): Promise<boolean> => {
  if (!isPushSupported() || !isVpsConfigured()) return false

  try {
    const res = await vfetch('/api/push/vapid-public-key')
    if (!res.ok) return false
    const { publicKey } = await res.json()
    if (!publicKey) return false

    const reg = await navigator.serviceWorker.ready
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey) as unknown as ArrayBuffer,
    })

    const subRes = await vfetch('/api/push/subscribe', {
      method: 'POST',
      body: JSON.stringify({ subscription: sub.toJSON() }),
    })
    if (subRes.ok) {
      try { localStorage.setItem(PUSH_SUBSCRIBED_KEY, '1') } catch {}
      return true
    }
    return false
  } catch (e) {
    console.error('[web-push] subscribe failed:', e)
    return false
  }
}

export const unsubscribePush = async (): Promise<void> => {
  try {
    const reg = await navigator.serviceWorker.ready
    const sub = await reg.pushManager.getSubscription()
    if (sub) {
      await vfetch('/api/push/unsubscribe', {
        method: 'POST',
        body: JSON.stringify({ endpoint: sub.endpoint }),
      })
      await sub.unsubscribe()
    }
    try { localStorage.removeItem(PUSH_SUBSCRIBED_KEY) } catch {}
  } catch (e) {
    console.error('[web-push] unsubscribe failed:', e)
  }
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  const outputArray = new Uint8Array(rawData.length)
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i)
  }
  return outputArray
}
