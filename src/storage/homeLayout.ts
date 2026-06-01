export type DecorativeWidget =
  | {
      id: string
      type: 'text'
      text: string
      size?: '1x1' | '2x1'
    }
  | {
      id: string
      type: 'image'
      imageKey?: string
      imageDataUrl?: string
      fit?: 'cover' | 'contain'
      size?: '1x1' | '2x1'
    }
  | {
      id: string
      type: 'spacer'
      size?: '1x1' | '2x1'
    }
  | {
      // Pinned app launcher tile — what used to live in the dock for
      // less-frequent apps (打卡 / mimi / Claude / 用量 / 健康 / 导出 /
      // 主页布局). Moved into the widget grid so the dock can stay
      // lean (聊天 / 记忆库 / 设置) while these still surface on a
      // swipe-away page.
      id: string
      type: 'app_shortcut'
      appId: string
      size?: '1x1' | '2x1'
    }
  | {
      // Live read-out of today's row in health_data — steps, sleep,
      // heart rate, SpO2. Tap to jump to /health-sync.
      id: string
      type: 'health_panel'
      size?: '1x1' | '2x1'
    }
  | {
      // Today's foreground screen time from the UsageStats native
      // plugin. Falls back to a "需要授权" prompt when the AppOp
      // hasn't been granted. Tap to jump to /health-sync.
      id: string
      type: 'screen_time'
      size?: '1x1' | '2x1'
    }
  | {
      // Period tracking summary — current cycle day, phase, and days
      // until the next predicted start. Pulled from period_tracking.
      id: string
      type: 'period'
      size?: '1x1' | '2x1'
    }

export type AppIconConfig =
  | {
      type: 'emoji'
      emoji: string
    }

// One screenful of widgets. The home screen is now a horizontally
// paginated stack — `pages[0]` is the primary page (must contain the
// core checkin widget), and additional pages can hold whatever the
// user wants.
export type HomePageData = {
  widgetOrder: string[]
  widgets: DecorativeWidget[]
}

export type HomeSettingsState = {
  iconOrder: string[]
  // Multi-page widget layout. Always at least 1 page. Migrated from
  // the old single widgetOrder/widgets pair on first load.
  pages: HomePageData[]
  checkinSize?: '1x1' | '2x1'
  togetherSince?: string | null
  showEmptySlots?: boolean
  iconTileBgColor?: string
  iconTileBgOpacity?: number
  appIconConfigs?: Record<string, AppIconConfig>
}

const HOME_SETTINGS_STORAGE_KEY = 'nibble_ui_prefs_v1'
const LEGACY_HOME_SETTINGS_STORAGE_KEY = 'hamster_home_settings_v1'
const LEGACY_HOME_LAYOUT_STORAGE_KEY = 'hamster.home.layout.v1'
const IMAGE_DB_NAME = 'nibble-widget-db'
const IMAGE_STORE_NAME = 'widget_images'
const IMAGE_DB_VERSION = 2
const IMAGE_FALLBACK_STORAGE_KEY = 'nibble_widget_image_v1'
const DATA_URL_PREFIX = 'data:image/'

let schemaUpgradeLogged = false
let activeImageDbVersion = IMAGE_DB_VERSION
const imageCache = new Map<string, string>()

const getFallbackAssetMap = (): Record<string, string> => {
  try {
    const raw = localStorage.getItem(IMAGE_FALLBACK_STORAGE_KEY)
    if (!raw) {
      return {}
    }
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, string>
    }
  } catch (error) {
    console.warn('读取本地图片回退缓存失败', error)
  }
  return {}
}

const setFallbackAssetMap = (map: Record<string, string>) => {
  localStorage.setItem(IMAGE_FALLBACK_STORAGE_KEY, JSON.stringify(map))
}

const blobToDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result)
      } else {
        reject(new Error('读取 Blob 数据失败'))
      }
    }
    reader.onerror = () => reject(reader.error ?? new Error('读取 Blob 数据失败'))
    reader.readAsDataURL(blob)
  })

const dataUrlToBlob = async (dataUrl: string): Promise<Blob> => {
  const response = await fetch(dataUrl)
  return response.blob()
}

const isImageDataUrl = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith(DATA_URL_PREFIX)

const removeImageBlobFallback = (key: string) => {
  const map = getFallbackAssetMap()
  if (!(key in map)) {
    return
  }
  delete map[key]
  setFallbackAssetMap(map)
}

const saveImageDataUrlFallback = (dataUrl: string, key: string) => {
  const map = getFallbackAssetMap()
  map[key] = dataUrl
  setFallbackAssetMap(map)
}

const loadImageDataUrlFallback = (key: string): string | null => {
  const map = getFallbackAssetMap()
  const dataUrl = map[key]
  return isImageDataUrl(dataUrl) ? dataUrl : null
}

const ensureImageStore = (db: IDBDatabase) => {
  if (!db.objectStoreNames.contains(IMAGE_STORE_NAME)) {
    db.createObjectStore(IMAGE_STORE_NAME)
  }
}

const openImageDb = (version = activeImageDbVersion): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(IMAGE_DB_NAME, version)
    request.onupgradeneeded = () => {
      const db = request.result
      ensureImageStore(db)
      if (!schemaUpgradeLogged) {
        schemaUpgradeLogged = true
        console.info('Home 本地图片缓存结构已升级')
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('打开 IndexedDB 失败'))
  })

const withImageStore = async <T>(
  mode: IDBTransactionMode,
  handler: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> => {
  const runTransaction = async (allowRepairRetry: boolean): Promise<T> => {
    const db = await openImageDb()

    if (!db.objectStoreNames.contains(IMAGE_STORE_NAME)) {
      db.close()
      if (allowRepairRetry) {
        activeImageDbVersion += 1
        const repairedDb = await openImageDb(activeImageDbVersion)
        repairedDb.close()
        return runTransaction(false)
      }
      throw new Error(`IndexedDB 缺少对象仓库: ${IMAGE_STORE_NAME}`)
    }

    return new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(IMAGE_STORE_NAME, mode)
      const store = transaction.objectStore(IMAGE_STORE_NAME)
      const request = handler(store)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('IndexedDB 操作失败'))
      transaction.oncomplete = () => db.close()
      transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB 事务失败'))
    })
  }

  try {
    return await runTransaction(true)
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') {
      activeImageDbVersion += 1
      const repairedDb = await openImageDb(activeImageDbVersion)
      repairedDb.close()
      return runTransaction(false)
    }
    throw error
  }
}

const parseHomeSettings = (raw: string | null): HomeSettingsState | null => {
  if (!raw) {
    return null
  }
  try {
    // `as unknown` because we're parsing across the schema change
    // (old layouts had widgetOrder/widgets at the top level; new
    // layouts have a pages[] array). The fields land in slightly
    // different places depending on which version wrote the row.
    const parsed = JSON.parse(raw) as Record<string, unknown> & Partial<HomeSettingsState>

    const normalizeWidgetList = (raw: unknown): DecorativeWidget[] => {
      if (!Array.isArray(raw)) return []
      return raw.reduce<DecorativeWidget[]>((accumulator, widget) => {
        if (!widget || typeof widget !== 'object' || typeof (widget as { id?: unknown }).id !== 'string') {
          return accumulator
        }
        const w = widget as DecorativeWidget
        if (
          w.type === 'text' ||
          w.type === 'image' ||
          w.type === 'spacer' ||
          w.type === 'app_shortcut' ||
          w.type === 'health_panel' ||
          w.type === 'screen_time' ||
          w.type === 'period'
        ) {
          accumulator.push({ ...w, size: w.size ?? '1x1' })
        }
        return accumulator
      }, [])
    }

    // Pages come either as the new pages[] array (preferred) or as
    // legacy top-level widgetOrder/widgets which we collapse into a
    // single first page. Either way we end up with at least one
    // page so the renderer never sees an empty pages array.
    let normalizedPages: HomePageData[]
    if (Array.isArray(parsed.pages) && parsed.pages.length > 0) {
      normalizedPages = parsed.pages.map((p) => {
        const pd = p as Partial<HomePageData> | undefined
        return {
          widgetOrder: Array.isArray(pd?.widgetOrder) ? (pd!.widgetOrder as string[]) : [],
          widgets: normalizeWidgetList(pd?.widgets),
        }
      })
    } else {
      const legacyOrder = Array.isArray((parsed as { widgetOrder?: unknown }).widgetOrder)
        ? ((parsed as { widgetOrder: string[] }).widgetOrder)
        : []
      const legacyWidgets = normalizeWidgetList((parsed as { widgets?: unknown }).widgets)
      normalizedPages = [{
        widgetOrder: legacyOrder,
        widgets: legacyWidgets,
      }]
    }

    // Migration: dock has been removed; every app lives on page 0 as
    // a shortcut tile. Consolidate any existing shortcut widgets
    // (from earlier migrations that put them on page 1) onto page 0,
    // dedupe by appId, then fill in any missing apps.
    const ALL_APP_IDS = [
      'chat',
      'checkin',
      'memory',
      'snacks',
      'syzygy',
      'usage',
      'health',
      'settings',
      'export',
    ]
    type AppShortcut = Extract<DecorativeWidget, { type: 'app_shortcut' }>
    const collectedShortcuts: AppShortcut[] = []
    const cleanedPages = normalizedPages.map((page) => {
      const others: DecorativeWidget[] = []
      for (const widget of page.widgets) {
        if (widget.type === 'app_shortcut') {
          collectedShortcuts.push(widget)
        } else {
          others.push(widget)
        }
      }
      const keptIds = new Set(others.map((w) => w.id))
      return {
        widgets: others,
        widgetOrder: page.widgetOrder.filter((id) => keptIds.has(id) || id.startsWith('widget-checkin')),
      }
    })

    // Dedupe by appId, keep first occurrence.
    const seenAppIds = new Set<string>()
    const finalShortcuts = collectedShortcuts.filter((s) => {
      if (seenAppIds.has(s.appId)) return false
      seenAppIds.add(s.appId)
      return true
    })
    for (const appId of ALL_APP_IDS) {
      if (!seenAppIds.has(appId)) {
        const id = `shortcut-${appId}-${Math.random().toString(36).slice(2, 8)}`
        finalShortcuts.push({ id, type: 'app_shortcut', appId, size: '1x1' })
        seenAppIds.add(appId)
      }
    }

    // Glue everything onto page 0; downstream HomePage logic keeps
    // the checkin core widget anchored at the top by virtue of being
    // in CORE_WIDGET_ID.
    if (cleanedPages.length === 0) {
      cleanedPages.push({ widgetOrder: [], widgets: [] })
    }
    cleanedPages[0].widgets.push(...finalShortcuts)
    cleanedPages[0].widgetOrder.push(...finalShortcuts.map((s) => s.id))

    normalizedPages = cleanedPages.filter(
      (p, idx) => idx === 0 || p.widgets.length > 0 || p.widgetOrder.length > 0,
    )

    const normalizedIconConfigs =
      parsed.appIconConfigs && typeof parsed.appIconConfigs === 'object'
        ? Object.entries(parsed.appIconConfigs).reduce<Record<string, AppIconConfig>>(
            (accumulator, [iconId, config]) => {
              if (
                config &&
                typeof config === 'object' &&
                (config as AppIconConfig).type === 'emoji' &&
                typeof (config as AppIconConfig).emoji === 'string'
              ) {
                accumulator[iconId] = {
                  type: 'emoji',
                  emoji: (config as AppIconConfig).emoji,
                }
              }
              return accumulator
            },
            {},
          )
        : undefined

    return {
      iconOrder: Array.isArray(parsed.iconOrder) ? (parsed.iconOrder as string[]) : [],
      pages: normalizedPages,
      checkinSize: parsed.checkinSize ?? '1x1',
      togetherSince:
        typeof parsed.togetherSince === 'string' && parsed.togetherSince.length > 0
          ? parsed.togetherSince
          : null,
      showEmptySlots: parsed.showEmptySlots,
      iconTileBgColor: parsed.iconTileBgColor,
      iconTileBgOpacity: parsed.iconTileBgOpacity,
      appIconConfigs: normalizedIconConfigs,
    }
  } catch (error) {
    console.warn('解析 Home 配置失败', error)
    return null
  }
}

export const loadHomeSettings = (): HomeSettingsState | null => {
  const current = parseHomeSettings(localStorage.getItem(HOME_SETTINGS_STORAGE_KEY))
  if (current) {
    return current
  }

  const legacyCurrent = parseHomeSettings(localStorage.getItem(LEGACY_HOME_SETTINGS_STORAGE_KEY))
  if (legacyCurrent) {
    localStorage.setItem(HOME_SETTINGS_STORAGE_KEY, JSON.stringify(legacyCurrent))
    localStorage.removeItem(LEGACY_HOME_SETTINGS_STORAGE_KEY)
    return legacyCurrent
  }

  const legacy = parseHomeSettings(localStorage.getItem(LEGACY_HOME_LAYOUT_STORAGE_KEY))
  if (legacy) {
    localStorage.setItem(HOME_SETTINGS_STORAGE_KEY, JSON.stringify(legacy))
    localStorage.removeItem(LEGACY_HOME_LAYOUT_STORAGE_KEY)
  }
  return legacy
}

export const saveHomeSettings = (state: HomeSettingsState) => {
  const nextState: HomeSettingsState = {
    ...state,
    pages: (state.pages.length > 0 ? state.pages : [{ widgetOrder: [], widgets: [] }]).map((page) => ({
      widgetOrder: page.widgetOrder,
      widgets: page.widgets.map((widget) => ({
        ...widget,
        size: widget.size ?? '1x1',
      })),
    })),
    checkinSize: state.checkinSize ?? '1x1',
    togetherSince: state.togetherSince ?? null,
  }
  localStorage.setItem(HOME_SETTINGS_STORAGE_KEY, JSON.stringify(nextState))
  window.dispatchEvent(new Event('hamster-home-settings-changed'))
}

export const loadHomeLayout = (): HomeSettingsState | null => {
  return loadHomeSettings()
}

export const saveHomeLayout = (state: HomeSettingsState) => {
  saveHomeSettings(state)
}

export const createImageKey = () =>
  globalThis.crypto?.randomUUID?.() ?? `image-${Date.now()}-${Math.random().toString(16).slice(2)}`

export const saveImageBlob = async (blob: Blob, key = createImageKey()): Promise<string> => {
  return saveImageDataUrl(await blobToDataUrl(blob), key)
}

export const saveImageDataUrl = async (dataUrl: string, key: string = createImageKey()): Promise<string> => {
  if (!isImageDataUrl(dataUrl)) {
    throw new Error('仅支持 data:image/ 开头的 DataURL')
  }
  try {
    await withImageStore('readwrite', (store) => store.put(dataUrl, key))
  } catch (error) {
    console.warn('IndexedDB 保存图片失败，已回退到 localStorage', error)
    saveImageDataUrlFallback(dataUrl, key)
  }
  imageCache.set(key, dataUrl)
  return key
}

export const loadImageBlob = async (key: string): Promise<Blob | null> => {
  const dataUrl = await loadImageDataUrl(key)
  if (!dataUrl) {
    return null
  }
  return dataUrlToBlob(dataUrl)
}

export const loadImageDataUrl = async (key: string): Promise<string | null> => {
  const cached = imageCache.get(key)
  if (cached) {
    return cached
  }

  try {
    const result = await withImageStore<Blob | string | undefined>('readonly', (store) => store.get(key))
    if (!result) {
      return null
    }

    if (isImageDataUrl(result)) {
      imageCache.set(key, result)
      return result
    }

    if (result instanceof Blob) {
      const migratedDataUrl = await blobToDataUrl(result)
      await saveImageDataUrl(migratedDataUrl, key)
      return migratedDataUrl
    }

    return null
  } catch (error) {
    console.warn('IndexedDB 读取图片失败，尝试 localStorage 回退缓存', error)
    const fallback = loadImageDataUrlFallback(key)
    if (fallback) {
      imageCache.set(key, fallback)
      return fallback
    }
    return null
  }
}

export const removeImageBlob = async (key: string): Promise<void> => {
  return removeImageData(key)
}

export const removeImageData = async (key: string): Promise<void> => {
  try {
    await withImageStore('readwrite', (store) => store.delete(key))
  } catch (error) {
    console.warn('IndexedDB 删除图片失败，清理 localStorage 回退缓存', error)
  } finally {
    removeImageBlobFallback(key)
    imageCache.delete(key)
  }
}
