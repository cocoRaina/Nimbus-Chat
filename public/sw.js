// bump SW_VERSION on every deploy that wants to invalidate old client caches
const SW_VERSION = 'v4-2026-05-21-edit-user-msg'
const RUNTIME_CACHE = `nimbus-chat-runtime-${SW_VERSION}`
const NAV_FALLBACK_CACHE = `nimbus-chat-nav-fallback-${SW_VERSION}`

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== RUNTIME_CACHE && key !== NAV_FALLBACK_CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request

  if (request.method !== 'GET') {
    return
  }

  const url = new URL(request.url)

  // Navigation: always go to network first. Only fall back to last-known-good
  // HTML if the network is actually unreachable (offline). Never serve stale
  // HTML that references bundle hashes that no longer exist on the server.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request)
          if (response.ok) {
            const cache = await caches.open(NAV_FALLBACK_CACHE)
            cache.put('./', response.clone()).catch(() => {})
          }
          return response
        } catch (networkError) {
          const cache = await caches.open(NAV_FALLBACK_CACHE)
          const cached = await cache.match('./')
          if (cached) {
            return cached
          }
          throw networkError
        }
      })(),
    )
    return
  }

  if (url.origin !== self.location.origin) {
    return
  }

  const isStaticAsset = ['style', 'script', 'worker', 'font', 'image'].includes(request.destination)

  if (!isStaticAsset) {
    return
  }

  // Hash-based assets are immutable. Cache-first is safe. But never cache a
  // non-OK response, and on network failure only fall back to cache if it
  // exists — otherwise let the original network response (or rejection) reach
  // the browser so it can surface a real error.
  event.respondWith(
    caches.open(RUNTIME_CACHE).then(async (cache) => {
      const cached = await cache.match(request)
      if (cached) {
        return cached
      }
      try {
        const response = await fetch(request)
        if (response.ok) {
          cache.put(request, response.clone()).catch(() => {})
        }
        return response
      } catch (networkError) {
        const fallback = await cache.match(request)
        if (fallback) {
          return fallback
        }
        throw networkError
      }
    }),
  )
})
