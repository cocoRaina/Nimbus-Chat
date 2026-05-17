import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { User } from '@supabase/supabase-js'
import { removeLocalSupabaseConfig, setLocalSupabaseConfig, supabase } from '../supabase/client'
import { readLocalSupabaseConfig } from '../storage/supabaseConfig'
import { getSupabaseProjectInputDisplay, normalizeSupabaseProjectInput } from '../utils/supabaseProjectInput'
import './AuthPage.css'

type AuthPageProps = {
  user: User | null
  supabaseConfigured: boolean
}

const AuthPage = ({ user, supabaseConfigured }: AuthPageProps) => {
  const [email, setEmail] = useState('')
  const [otp, setOtp] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [activePanel, setActivePanel] = useState<'login' | 'setup'>('login')
  const [setupProjectInput, setSetupProjectInput] = useState('')
  const [setupAnonKey, setSetupAnonKey] = useState('')
  const navigate = useNavigate()


  const openSetupPanel = useCallback(() => {
    const localConfig = readLocalSupabaseConfig()
    setSetupProjectInput(localConfig ? getSupabaseProjectInputDisplay(localConfig.url) : '')
    setSetupAnonKey(localConfig?.anonKey ?? '')
    setActivePanel('setup')
  }, [])

  useEffect(() => {
    if (!supabase) {
      return
    }
    let active = true
    supabase.auth.getSession().then(({ data }) => {
      if (!active) {
        return
      }
      if (data.session?.user) {
        navigate('/')
      }
    })
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) {
        navigate('/')
      }
    })
    return () => {
      active = false
      data.subscription.unsubscribe()
    }
  }, [navigate])

  const handleSendOtp = useCallback(async () => {
    if (!supabaseConfigured) {
      setError('请先点击“新用户请先完成初始配置”并保存 Supabase 配置。')
      setStatus(null)
      return
    }
    const trimmed = email.trim()
    if (!trimmed) {
      setError('请输入邮箱地址。')
      return
    }
    if (!supabase) {
      setError('服务暂不可用，请稍后重试。')
      return
    }
    setSending(true)
    setError(null)
    setStatus(null)
    const { error: signInError } = await supabase.auth.signInWithOtp({
      email: trimmed,
    })
    setSending(false)
    if (signInError) {
      setError('验证码发送失败，请稍后再试。')
      return
    }
    setStatus('验证码已发送，请查收邮箱。')
  }, [email, supabaseConfigured])

  const handleVerifyOtp = useCallback(async () => {
    if (!supabaseConfigured) {
      setError('请先完成初始配置，再验证验证码登录。')
      setStatus(null)
      return
    }
    const trimmedEmail = email.trim()
    const trimmedOtp = otp.trim()
    if (!trimmedEmail) {
      setError('请输入邮箱地址。')
      return
    }
    if (!trimmedOtp) {
      setError('请输入验证码。')
      return
    }
    if (!supabase) {
      setError('服务暂不可用，请稍后重试。')
      return
    }
    setVerifying(true)
    setError(null)
    setStatus(null)
    const { error: verifyError } = await supabase.auth.verifyOtp({
      email: trimmedEmail,
      token: trimmedOtp,
      type: 'email',
    })
    setVerifying(false)
    if (verifyError) {
      setError('验证码无效或已过期。')
      return
    }
    setStatus('登录成功，欢迎回来。')
  }, [email, otp, supabaseConfigured])

  const handleSaveSetup = useCallback(() => {
    const normalizedProject = normalizeSupabaseProjectInput(setupProjectInput)
    const trimmedAnonKey = setupAnonKey.trim()
    if ('error' in normalizedProject) {
      setError(normalizedProject.error)
      setStatus(null)
      return
    }
    if (!trimmedAnonKey) {
      setError('请输入 Supabase anon public key。')
      setStatus(null)
      return
    }
    setLocalSupabaseConfig({ url: normalizedProject.url, anonKey: trimmedAnonKey })
    setActivePanel('login')
    setError(null)
    setStatus('配置已保存，可继续发送验证码登录。')
  }, [setupAnonKey, setupProjectInput])

  const handleClearSetup = useCallback(() => {
    removeLocalSupabaseConfig()
    setSetupProjectInput('')
    setSetupAnonKey('')
    setError(null)
    setStatus('已清除本地 Supabase 配置，请重新配置后再登录。')
  }, [])

  const handleLogout = useCallback(async () => {
    if (!supabase) {
      setError('服务暂不可用，请稍后重试。')
      return
    }
    setError(null)
    setStatus(null)
    await supabase.auth.signOut()
  }, [])

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="hamster-logo" aria-hidden="true">
          <span className="auth-logo-icon" />
        </div>
        <h1 className="ui-title">欢迎使用 Nimbus-Chat</h1>
        {activePanel === 'login' ? (
          <>
            <p className="subtitle">请输入邮箱获取验证码并登录</p>
            <label className="field">
              <span className="field-label">邮箱地址</span>
              <div className="input-shell">
                <span className="input-icon" aria-hidden="true">
                  @
                </span>
                <input
                  type="email"
                  placeholder="输入你的邮箱"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </div>
            </label>
            <button
              type="button"
              className="primary"
              onClick={handleSendOtp}
              disabled={sending || !supabaseConfigured}
            >
              {sending ? '发送中...' : '发送验证码 ✨'}
            </button>
            <label className="field">
              <span className="field-label">验证码</span>
              <div className="input-shell">
                <span className="input-icon" aria-hidden="true">
                  #
                </span>
                <input
                  type="text"
                  placeholder="输入邮箱中的验证码"
                  value={otp}
                  onChange={(event) => setOtp(event.target.value)}
                />
              </div>
            </label>
            <button
              type="button"
              className="primary"
              onClick={handleVerifyOtp}
              disabled={verifying || !supabaseConfigured}
            >
              {verifying ? '验证中...' : '验证并登录 ✨'}
            </button>
            <button type="button" className="forgot-link" onClick={handleSendOtp} disabled={!supabaseConfigured}>
              Forgot Password?
            </button>
            <button type="button" className="setup-entry" onClick={openSetupPanel}>
              新用户请先完成初始配置
            </button>
          </>
        ) : (
          <>
            <p className="subtitle">请填写你的 Supabase 项目连接信息</p>
            <p className="setup-helper">配置仅保存在本地浏览器，不会上传。更换设备需要重新填写。</p>
            <label className="field">
              <span className="field-label">Supabase Project ID (ref)</span>
              <span className="setup-helper">只需填写 Project ID（ref）。系统会自动生成 https://&#123;ref&#125;.supabase.co</span>
              <div className="input-shell">
                <input
                  type="text"
                  placeholder="gugyzgigttcyytrgxeqi"
                  value={setupProjectInput}
                  onChange={(event) => setSetupProjectInput(event.target.value)}
                />
              </div>
            </label>
            <label className="field">
              <span className="field-label">Supabase anon public key</span>
              <div className="input-shell">
                <input
                  type="text"
                  placeholder="粘贴 anon public key"
                  value={setupAnonKey}
                  onChange={(event) => setSetupAnonKey(event.target.value)}
                />
              </div>
            </label>
            <div className="setup-actions">
              <button type="button" className="primary" onClick={handleSaveSetup}>
                Save
              </button>
              <button type="button" className="ghost" onClick={handleClearSetup}>
                Clear
              </button>
              <button type="button" className="ghost" onClick={() => setActivePanel('login')}>
                Back to Login
              </button>
            </div>
          </>
        )}
        {!supabaseConfigured && activePanel === 'login' ? (
          <p className="error">请先完成 Supabase 初始配置，再进行邮箱验证码登录。</p>
        ) : null}
        {status ? <p className="status">{status}</p> : null}
        {error ? <p className="error">{error}</p> : null}
        <div className="divider" />
        {user ? (
          <div className="auth-user">
            <p>
              当前用户：<strong>{user.email ?? '未知邮箱'}</strong>
            </p>
            <div className="user-actions">
              <button type="button" className="ghost" onClick={() => navigate('/')}>
                进入聊天
              </button>
              <button type="button" className="danger" onClick={handleLogout}>
                退出登录
              </button>
            </div>
          </div>
        ) : (
          <p className="hint">登录后将自动同步你的会话与消息。</p>
        )}
      </div>
    </div>
  )
}

export default AuthPage
