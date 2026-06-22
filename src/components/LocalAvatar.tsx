import { useRef, useState } from 'react'
import type { ChangeEvent } from 'react'

type LocalAvatarProps = {
  storageKey: string
  alt: string
}

// Shrink an uploaded image to a small avatar before storing. The old code put
// the RAW file straight into localStorage as a base64 data URL — a single phone
// photo (2–5MB) could fill the whole ~5MB localStorage quota by itself, which
// then made every other setItem (TTS keys, chat cache…) throw QuotaExceeded.
// We downscale to 256px and JPEG-encode, taking each avatar to ~20–40KB.
const compressToAvatar = (file: File, max = 256): Promise<string> =>
  new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height))
      const w = Math.max(1, Math.round(img.width * scale))
      const h = Math.max(1, Math.round(img.height * scale))
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      URL.revokeObjectURL(url)
      if (!ctx) {
        reject(new Error('no canvas'))
        return
      }
      ctx.drawImage(img, 0, 0, w, h)
      resolve(canvas.toDataURL('image/jpeg', 0.82))
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('image load failed'))
    }
    img.src = url
  })

const LocalAvatar = ({ storageKey, alt }: LocalAvatarProps) => {
  const [avatarDataUrl, setAvatarDataUrl] = useState<string | null>(() => localStorage.getItem(storageKey))
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const handleAvatarClick = () => {
    fileInputRef.current?.click()
  }

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) {
      return
    }
    try {
      const result = await compressToAvatar(file)
      localStorage.setItem(storageKey, result)
      setAvatarDataUrl(result)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'QuotaExceededError') {
        window.alert('本地存储已满，头像没能保存。可以先移除旧头像/背景图或清理缓存后再试。')
      } else {
        window.alert('头像处理失败，请换一张图片再试。')
      }
    }
  }

  const handleRemoveAvatar = () => {
    localStorage.removeItem(storageKey)
    setAvatarDataUrl(null)
  }

  return (
    <div className="profile-avatar-wrap">
      <button type="button" className="profile-avatar-button" onClick={handleAvatarClick} aria-label="上传头像">
        {avatarDataUrl ? (
          <img className="profile-avatar-image" src={avatarDataUrl} alt={alt} />
        ) : (
          <span className="profile-avatar-placeholder" aria-hidden="true" />
        )}
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="profile-avatar-input"
        onChange={handleFileChange}
      />
      {avatarDataUrl ? (
        <button
          type="button"
          className="profile-avatar-remove"
          onClick={handleRemoveAvatar}
          aria-label="移除头像"
          title="移除头像"
        >
          ×
        </button>
      ) : null}
    </div>
  )
}

export default LocalAvatar
