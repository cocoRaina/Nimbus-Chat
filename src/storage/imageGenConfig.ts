// 🎨 画画（AI 生图）配置。和聊天中转是两把独立的 key：生图走 OpenAI 兼容
// 中转站的生图分组（gpt-image 系等），聊天走 openrouter/msuicode 槽，互不影响。
// key 只存本机 localStorage（和其他 key 同一套安全模型），UI 里只回显掩码。

export type ImageGenShape = 'images' | 'chat'

export type ImageGenSize = '1024x1024' | '1536x1024' | '1024x1536'

export const IMAGE_GEN_SIZES: ImageGenSize[] = ['1024x1024', '1536x1024', '1024x1536']

const STORAGE_BASE = 'nimbus_imagegen_base_url'
const STORAGE_KEY = 'nimbus_imagegen_api_key'
const STORAGE_MODEL = 'nimbus_imagegen_model'
const STORAGE_SHAPE = 'nimbus_imagegen_shape'
const STORAGE_SIZE = 'nimbus_imagegen_default_size'

const read = (key: string): string => {
  if (typeof window === 'undefined') return ''
  return window.localStorage.getItem(key)?.trim() ?? ''
}

const write = (key: string, value: string) => {
  if (typeof window === 'undefined') return
  const v = value.trim()
  if (v) window.localStorage.setItem(key, v)
  else window.localStorage.removeItem(key)
}

export const getImageGenBaseUrl = (): string => read(STORAGE_BASE)
export const saveImageGenBaseUrl = (url: string) => write(STORAGE_BASE, url)

export const getImageGenApiKey = (): string => read(STORAGE_KEY)
export const saveImageGenApiKey = (key: string) => write(STORAGE_KEY, key)

export const getImageGenModel = (): string => read(STORAGE_MODEL)
export const saveImageGenModel = (model: string) => write(STORAGE_MODEL, model)

export const getImageGenShape = (): ImageGenShape =>
  read(STORAGE_SHAPE) === 'chat' ? 'chat' : 'images'
export const saveImageGenShape = (shape: ImageGenShape) => write(STORAGE_SHAPE, shape)

export const getImageGenDefaultSize = (): ImageGenSize => {
  const v = read(STORAGE_SIZE)
  return (IMAGE_GEN_SIZES as string[]).includes(v) ? (v as ImageGenSize) : '1024x1024'
}
export const saveImageGenDefaultSize = (size: ImageGenSize) => write(STORAGE_SIZE, size)

// 三样齐了才把 generate_image 工具亮给模型 —— 没配置时模型根本不知道
// 自己会画画，不会出现「说画了却画不了」的尴尬。
export const isImageGenConfigured = (): boolean =>
  Boolean(getImageGenBaseUrl() && getImageGenApiKey() && getImageGenModel())

// key 掩码回显：sk-3ESxx…xxxx。UI 永远不回显完整 key。
export const maskImageGenKey = (key: string): string => {
  if (!key) return ''
  if (key.length <= 10) return `${key.slice(0, 3)}…`
  return `${key.slice(0, 6)}…${key.slice(-4)}`
}
