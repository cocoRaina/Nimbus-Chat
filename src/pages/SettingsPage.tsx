import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { User } from '@supabase/supabase-js'
import { useNavigate } from 'react-router-dom'
import ConfirmDialog from '../components/ConfirmDialog'
import LocalAvatar from '../components/LocalAvatar'
import RelayChannelPanel, { type ChannelTarget } from '../components/RelayChannelPanel'
import { fetchOpenRouterModels } from '../api/openrouter'
import { getRelaySelfHealHosts, clearRelaySelfHealRecords } from '../api/anthropic'
import type { UserSettings } from '../types'
import { supabase } from '../supabase/client'
import {
  clearOpenRouterApiKey,
  getOpenRouterApiKey,
  saveOpenRouterApiKey,
} from '../storage/openrouterKey'
import {
  clearQWeatherCredential,
  getQWeatherCredential,
  saveQWeatherCredential,
} from '../storage/qweatherKey'
import { peekCachedWeather, fetchCurrentWeather, type WeatherSnapshot } from '../storage/weather'
import {
  DEFAULT_MSUICODE_BASE,
  clearMsuicodeApiKey,
  deriveProviderDisplayName,
  getActiveProvider,
  getMsuicodeApiKey,
  getMsuicodeBaseUrl,
  getMsuicodeFormat,
  getOpenRouterFormat,
  saveMsuicodeApiKey,
  saveMsuicodeBaseUrl,
  setActiveProvider,
  setMsuicodeFormat,
  setOpenRouterFormat,
  getRelayPresets,
  saveRelayPreset,
  deleteRelayPreset,
  applyRelayPreset,
  type ApiFormat,
  type ProviderId,
  type RelayPreset,
} from '../storage/apiProvider'
import { getTtsConfig, saveTtsConfig, commitTtsConfig, hydrateTtsConfig, readbackTtsActive, DEFAULT_TTS_BASE, type TtsProvider, type TtsConfig } from '../storage/ttsConfig'
import { getCallConfig, saveCallConfig, type CallConfig } from '../storage/callConfig'
const TTS_MODELS = ['speech-2.8-turbo', 'speech-2.8-hd']
const EL_MODELS = ['eleven_v3', 'eleven_multilingual_v2', 'eleven_turbo_v2_5']
import {
  DEFAULT_SNACK_SYSTEM_OVERLAY,
  DEFAULT_SYZYGY_POST_PROMPT,
  DEFAULT_SYZYGY_REPLY_PROMPT,
  resolveSnackSystemOverlay,
  resolveSyzygyPostPrompt,
  resolveSyzygyReplyPrompt,
} from '../constants/aiOverlays'
import './SettingsPage.css'

type OpenRouterModel = {
  id: string
  name?: string
  context_length?: number | null
}

type SettingsPageProps = {
  user: User | null
  settings: UserSettings | null
  ready: boolean
  onSaveSettings: (nextSettings: UserSettings) => Promise<void>
  onSaveSnackSystemPrompt: (value: string) => Promise<void>
  onSaveSyzygyPostPrompt: (value: string) => Promise<void>
  onSaveSyzygyReplyPrompt: (value: string) => Promise<void>
}

const defaultModelId = 'openrouter/auto'

const SettingsPage = ({
  user,
  settings,
  ready,
  onSaveSettings,
  onSaveSnackSystemPrompt,
  onSaveSyzygyPostPrompt,
  onSaveSyzygyReplyPrompt,
}: SettingsPageProps) => {
  const navigate = useNavigate()
  const [searchTerm, setSearchTerm] = useState('')
  const [catalog, setCatalog] = useState<OpenRouterModel[]>([])
  const [catalogStatus, setCatalogStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [pendingDisable, setPendingDisable] = useState<string | null>(null)
  const [temperatureInput, setTemperatureInput] = useState('')
  const [topPInput, setTopPInput] = useState('')
  const [maxTokensInput, setMaxTokensInput] = useState('')
  const [compressionEnabled, setCompressionEnabled] = useState(true)
  const [compressionRatioInput, setCompressionRatioInput] = useState('0.65')
  const [compressionKeepRecentInput, setCompressionKeepRecentInput] = useState('20')
  const [draftSummarizerModel, setDraftSummarizerModel] = useState<string | null>(null)
  const [draftSummarizerProvider, setDraftSummarizerProvider] = useState<ProviderId>('openrouter')
  const [modelSectionExpanded, setModelSectionExpanded] = useState(false)
  const [generationSectionExpanded, setGenerationSectionExpanded] = useState(false)
  const [reasoningSectionExpanded, setReasoningSectionExpanded] = useState(false)
  const [compressionSectionExpanded, setCompressionSectionExpanded] = useState(false)
  const [systemPromptSectionExpanded, setSystemPromptSectionExpanded] = useState(false)
  const [openRouterKeySectionExpanded, setOpenRouterKeySectionExpanded] = useState(false)
  const [draftEnabledModels, setDraftEnabledModels] = useState<string[]>([])
  const [openRouterApiKeyInput, setOpenRouterApiKeyInput] = useState(() => getOpenRouterApiKey())
  const [openRouterApiKeyVisible, setOpenRouterApiKeyVisible] = useState(false)
  const [openRouterApiKeyStatus, setOpenRouterApiKeyStatus] = useState<'idle' | 'saved'>('idle')
  const [openRouterFormat, setOpenRouterFormatState] = useState<ApiFormat>(() => getOpenRouterFormat())
  const [activeProvider, setActiveProviderState] = useState<ProviderId>(() => getActiveProvider())
  const [relayPresets, setRelayPresets] = useState<RelayPreset[]>(() => getRelayPresets())
  const [msuicodeSectionExpanded, setMsuicodeSectionExpanded] = useState(false)
  const [msuicodeApiKeyInput, setMsuicodeApiKeyInput] = useState(() => getMsuicodeApiKey())
  const [msuicodeApiKeyVisible, setMsuicodeApiKeyVisible] = useState(false)
  const [msuicodeApiKeyStatus, setMsuicodeApiKeyStatus] = useState<'idle' | 'saved'>('idle')
  const [msuicodeFormat, setMsuicodeFormatState] = useState<ApiFormat>(() => getMsuicodeFormat())
  const [msuicodeBaseUrlInput, setMsuicodeBaseUrlInput] = useState(() => getMsuicodeBaseUrl())
  const [selfHealHosts, setSelfHealHosts] = useState(() => getRelaySelfHealHosts())
  const [selfHealResetStatus, setSelfHealResetStatus] = useState<'idle' | 'done'>('idle')
  const selfHealSummary = useMemo(() => {
    const parts: string[] = []
    for (const h of selfHealHosts.thinking) parts.push(`${h} 已停用原生思考回传(改发文字)`)
    for (const h of selfHealHosts.beta) parts.push(`${h} 已停发 1h 缓存 beta 头`)
    for (const h of selfHealHosts.ttl) parts.push(`${h} 缓存 TTL 已降级 5 分钟`)
    return parts
  }, [selfHealHosts])
  const handleResetSelfHeal = useCallback(() => {
    clearRelaySelfHealRecords()
    setSelfHealHosts(getRelaySelfHealHosts())
    setSelfHealResetStatus('done')
  }, [])
  const [avatarSectionExpanded, setAvatarSectionExpanded] = useState(false)
  const [ttsSectionExpanded, setTtsSectionExpanded] = useState(false)
  const [weatherSectionExpanded, setWeatherSectionExpanded] = useState(false)
  const [qweatherHost, setQweatherHost] = useState(() => getQWeatherCredential()?.apiHost ?? '')
  const [qweatherPem, setQweatherPem] = useState(() => getQWeatherCredential()?.privateKeyPem ?? '')
  const [qweatherPemVisible, setQweatherPemVisible] = useState(false)
  const [qweatherKid, setQweatherKid] = useState(() => getQWeatherCredential()?.credentialId ?? '')
  const [qweatherSub, setQweatherSub] = useState(() => getQWeatherCredential()?.projectId ?? '')
  const [qweatherCredStatus, setQweatherCredStatus] = useState<'idle' | 'saved'>('idle')
  const [weatherSnap, setWeatherSnap] = useState<WeatherSnapshot | null>(() => peekCachedWeather())
  const [weatherRefreshing, setWeatherRefreshing] = useState(false)
  const [ttsDraft, setTtsDraft] = useState(() => getTtsConfig())
  const [ttsApiKeyVisible, setTtsApiKeyVisible] = useState(false)
  const [ttsStatus, setTtsStatus] = useState<'idle' | 'saving' | 'saved'>('idle')
  // Diagnostic readback after Save: what the durable store actually holds.
  const [ttsCheck, setTtsCheck] = useState<
    { native: boolean; provider: string; voiceLen: number; keyLen: number } | null
  >(null)
  const [ttsError, setTtsError] = useState<string | null>(null)
  // Write-through: persist each TTS field to localStorage as it changes, not
  // only on the Save click. Filling these often means alt-tabbing to ElevenLabs
  // to copy the key/voice id; Android can reclaim the WebView in the background
  // and reload, wiping any draft that lived only in React state. Saving on every
  // change means a reload re-reads the same values instead of losing them.
  // 📞 语音通话（callhome）：开关 + 勿扰，挂在 TTS 区块里（通话依赖 TTS）
  const [callCfg, setCallCfg] = useState<CallConfig>(() => getCallConfig())
  const patchCall = useCallback((patch: Partial<CallConfig>) => {
    setCallCfg((c) => ({ ...c, ...patch }))
    saveCallConfig(patch)
  }, [])
  const patchTts = useCallback((patch: Partial<TtsConfig>) => {
    setTtsDraft((d) => ({ ...d, ...patch }))
    saveTtsConfig(patch)
    setTtsStatus('saved')
  }, [])
  // On native, the WebView's localStorage may have dropped a recent write; pull
  // the durable Preferences copy back into the sync mirror, then refresh the
  // draft so re-opening this page shows what was actually saved.
  useEffect(() => {
    void hydrateTtsConfig().then(() => setTtsDraft(getTtsConfig()))
  }, [])
  // Friendly label for the custom provider, derived from its base URL hostname.
  const customProviderName = useMemo(
    () => deriveProviderDisplayName(msuicodeBaseUrlInput || DEFAULT_MSUICODE_BASE),
    [msuicodeBaseUrlInput],
  )
  // Relays to show in the channel panel: every saved preset, plus the
  // current (unsaved) custom slot when it isn't already one of them.
  const channelTargets = useMemo<ChannelTarget[]>(() => {
    const norm = (u: string) => u.trim().replace(/\/+$/, '')
    const list: ChannelTarget[] = relayPresets.map((p) => ({
      id: p.id,
      name: p.name,
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
    }))
    const curBase = msuicodeBaseUrlInput.trim()
    const curKey = msuicodeApiKeyInput.trim() || getMsuicodeApiKey()
    if (curBase && curKey && !relayPresets.some((p) => norm(p.baseUrl) === norm(curBase))) {
      list.unshift({ id: 'current-slot', name: customProviderName || '当前中转', baseUrl: curBase, apiKey: curKey })
    }
    return list
  }, [relayPresets, msuicodeBaseUrlInput, msuicodeApiKeyInput, customProviderName])
  const [catalogReloadKey, setCatalogReloadKey] = useState(0)
  const [draftDefaultModel, setDraftDefaultModel] = useState(defaultModelId)
  const [draftChatReasoning, setDraftChatReasoning] = useState(true)
  const [draftChatHighReasoning, setDraftChatHighReasoning] = useState(false)
  const [modelStatus, setModelStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [modelError, setModelError] = useState<string | null>(null)
  const [generationStatus, setGenerationStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [generationError, setGenerationError] = useState<string | null>(null)
  const [draftSystemPrompt, setDraftSystemPrompt] = useState('')
  const [systemPromptStatus, setSystemPromptStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [draftSnackSystemPrompt, setDraftSnackSystemPrompt] = useState('')
  const [snackOverlayStatus, setSnackOverlayStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [draftSyzygyPostPrompt, setDraftSyzygyPostPrompt] = useState(DEFAULT_SYZYGY_POST_PROMPT)
  const [draftSyzygyReplyPrompt, setDraftSyzygyReplyPrompt] = useState(DEFAULT_SYZYGY_REPLY_PROMPT)
  const [syzygyPostStatus, setSyzygyPostStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [syzygyReplyStatus, setSyzygyReplyStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [showUnsavedPromptDialog, setShowUnsavedPromptDialog] = useState(false)
  const [snackSectionExpanded, setSnackSectionExpanded] = useState(false)
  const [syzygySectionExpanded, setSyzygySectionExpanded] = useState(false)
  const [memoryExtractSectionExpanded, setMemoryExtractSectionExpanded] = useState(false)
  const [draftAutoExtractEnabled, setDraftAutoExtractEnabled] = useState(true)
  const [draftExtractModel, setDraftExtractModel] = useState('anthropic/claude-haiku-4-5')
  const [draftExtractProvider, setDraftExtractProvider] = useState<ProviderId>('openrouter')
  const [extractStatus, setExtractStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [errors, setErrors] = useState<{ temperature?: string; topP?: string; maxTokens?: string; compressionRatio?: string; compressionKeepRecent?: string }>(
    {},
  )
  const pendingNavigationRef = useRef<null | (() => void)>(null)

  useEffect(() => {
    document.documentElement.classList.add('settings-page-active')
    document.body.classList.add('settings-page-active')
    document.body.classList.remove('chat-page-active')

    return () => {
      document.documentElement.classList.remove('settings-page-active')
      document.body.classList.remove('settings-page-active')
    }
  }, [])

  useEffect(() => {
    if (!settings) {
      return
    }
    const timer = window.setTimeout(() => {
      setTemperatureInput(settings.temperature.toString())
      setTopPInput(settings.topP.toString())
      setMaxTokensInput(settings.maxTokens.toString())
      setDraftEnabledModels(settings.enabledModels)
      setDraftDefaultModel(settings.defaultModel)
      setCompressionEnabled(settings.compressionEnabled)
      setCompressionRatioInput(settings.compressionTriggerRatio.toString())
      setCompressionKeepRecentInput(settings.compressionKeepRecentMessages.toString())
      setDraftSummarizerModel(settings.summarizerModel)
      setDraftSummarizerProvider(settings.summarizerProvider)
      setDraftChatReasoning(settings.chatReasoningEnabled)
      setDraftChatHighReasoning(settings.chatHighReasoningEnabled)
      setDraftAutoExtractEnabled(settings.autoMemoryExtractEnabled)
      setDraftExtractModel(settings.memoryExtractModel)
      setDraftExtractProvider(settings.memoryExtractProvider)
    }, 0)
    return () => {
      window.clearTimeout(timer)
    }
  }, [settings])

  useEffect(() => {
    if (!settings) {
      return
    }
    const timer = window.setTimeout(() => {
      setDraftSnackSystemPrompt(resolveSnackSystemOverlay(settings.snackSystemOverlay))
    }, 0)
    return () => {
      window.clearTimeout(timer)
    }
  }, [settings])

  useEffect(() => {
    if (!settings) {
      return
    }
    const timer = window.setTimeout(() => {
      setDraftSystemPrompt(settings.systemPrompt)
    }, 0)
    return () => {
      window.clearTimeout(timer)
    }
  }, [settings])

  useEffect(() => {
    if (!settings) {
      return
    }
    const timer = window.setTimeout(() => {
      setDraftSyzygyPostPrompt(resolveSyzygyPostPrompt(settings.syzygyPostSystemPrompt))
      setDraftSyzygyReplyPrompt(resolveSyzygyReplyPrompt(settings.syzygyReplySystemPrompt))
    }, 0)
    return () => {
      window.clearTimeout(timer)
    }
  }, [settings])

  useEffect(() => {
    if (!user || !supabase) {
      return
    }
    const client = supabase
    let active = true
    const loadSyzygyPrompts = async () => {
      try {
        const { data, error } = await client
          .from('user_settings')
          .select('assistant_post_system_prompt,assistant_reply_system_prompt')
          .eq('user_id', user.id)
          .maybeSingle()
        if (!active || error) {
          return
        }
        setDraftSyzygyPostPrompt(resolveSyzygyPostPrompt(data?.assistant_post_system_prompt))
        setDraftSyzygyReplyPrompt(resolveSyzygyReplyPrompt(data?.assistant_reply_system_prompt))
      } catch {
        // ignore and keep local fallback
      }
    }
    void loadSyzygyPrompts()
    return () => {
      active = false
    }
  }, [user])

  useEffect(() => {
    if (!user) {
      return
    }
    let active = true
    // Clear stale catalog from previous provider so user sees the switch took effect
    setCatalog([])
    const timer = window.setTimeout(() => {
      setCatalogStatus('loading')
      setCatalogError(null)
    }, 0)
    fetchOpenRouterModels({ forceRefresh: catalogReloadKey > 0 })
      .then((models) => {
        if (!active) {
          return
        }
        setCatalog(models)
        setCatalogStatus('idle')
      })
      .catch((error) => {
        if (!active) {
          return
        }
        setCatalogStatus('error')
        const providerLabel = getActiveProvider() === 'msuicode' ? customProviderName : 'OpenRouter'
        setCatalogError(error instanceof Error ? `[${providerLabel}] ${error.message}` : `无法加载 ${providerLabel} 模型库`)
      })
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [user, catalogReloadKey])

  const handleSaveOpenRouterApiKey = () => {
    const trimmed = openRouterApiKeyInput.trim()
    if (!trimmed) {
      return
    }
    saveOpenRouterApiKey(trimmed)
    setOpenRouterApiKeyInput(trimmed)
    setOpenRouterApiKeyStatus('saved')
    setCatalogReloadKey((value) => value + 1)
  }

  const handleClearOpenRouterApiKey = () => {
    clearOpenRouterApiKey()
    setOpenRouterApiKeyInput('')
    setOpenRouterApiKeyStatus('idle')
  }

  const handleSwitchProvider = (next: ProviderId) => {
    if (next === activeProvider) return
    setActiveProvider(next)
    setActiveProviderState(next)
    setCatalogReloadKey((value) => value + 1)
  }

  const handleSaveMsuicodeApiKey = () => {
    const trimmed = msuicodeApiKeyInput.trim()
    if (!trimmed) return
    saveMsuicodeApiKey(trimmed)
    saveMsuicodeBaseUrl(msuicodeBaseUrlInput.trim() || DEFAULT_MSUICODE_BASE)
    setMsuicodeApiKeyInput(trimmed)
    setMsuicodeApiKeyStatus('saved')
    if (activeProvider === 'msuicode') {
      setCatalogReloadKey((value) => value + 1)
    }
  }

  const handleClearMsuicodeApiKey = () => {
    clearMsuicodeApiKey()
    setMsuicodeApiKeyInput('')
    setMsuicodeApiKeyStatus('idle')
  }

  // Save the current custom-relay fields as a reusable preset so several
  // relays can be kept around and switched between with one tap.
  const handleSaveCurrentRelayAsPreset = () => {
    const baseUrl = msuicodeBaseUrlInput.trim() || DEFAULT_MSUICODE_BASE
    const apiKey = msuicodeApiKeyInput.trim() || getMsuicodeApiKey()
    const id =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`
    saveRelayPreset({ id, name: deriveProviderDisplayName(baseUrl), baseUrl, apiKey, format: msuicodeFormat })
    setRelayPresets(getRelayPresets())
  }

  const handleApplyRelayPreset = (preset: RelayPreset) => {
    applyRelayPreset(preset.id)
    setMsuicodeBaseUrlInput(preset.baseUrl)
    setMsuicodeApiKeyInput(preset.apiKey)
    setMsuicodeFormatState(preset.format)
    setActiveProviderState('msuicode')
    setMsuicodeApiKeyStatus('saved')
    setCatalogReloadKey((value) => value + 1)
  }

  const handleDeleteRelayPreset = (id: string) => {
    deleteRelayPreset(id)
    setRelayPresets(getRelayPresets())
  }


  const catalogMap = useMemo(() => {
    return new Map(catalog.map((model) => [model.id, model.name ?? model.id]))
  }, [catalog])

  const filteredCatalog = useMemo(() => {
    const term = searchTerm.trim().toLowerCase()
    if (!term) {
      return catalog
    }
    return catalog.filter((model) => {
      const name = model.name?.toLowerCase() ?? ''
      return model.id.toLowerCase().includes(term) || name.includes(term)
    })
  }, [catalog, searchTerm])

  const visibleCatalog = useMemo(() => {
    const term = searchTerm.trim()
    if (!term) {
      return []
    }
    return filteredCatalog.slice(0, 20)
  }, [filteredCatalog, searchTerm])

  const buildNextSettings = useCallback((overrides: Partial<UserSettings> = {}) => {
    if (!settings) {
      return null
    }
    return {
      ...settings,
      ...overrides,
      updatedAt: new Date().toISOString(),
    }
  }, [settings])

  const parsedTemperature = Number(temperatureInput)
  const parsedTopP = Number(topPInput)
  const parsedMaxTokens = Number.parseInt(maxTokensInput, 10)
  const parsedCompressionRatio = Number(compressionRatioInput)
  const parsedCompressionKeepRecent = Number.parseInt(compressionKeepRecentInput, 10)
  const temperatureValid = !Number.isNaN(parsedTemperature) && parsedTemperature >= 0 && parsedTemperature <= 2
  const topPValid = !Number.isNaN(parsedTopP) && parsedTopP >= 0 && parsedTopP <= 1
  const maxTokensValid = !Number.isNaN(parsedMaxTokens) && parsedMaxTokens >= 32 && parsedMaxTokens <= 4000
  const compressionRatioValid = !Number.isNaN(parsedCompressionRatio) && parsedCompressionRatio >= 0.1 && parsedCompressionRatio <= 0.95
  const compressionKeepRecentValid = !Number.isNaN(parsedCompressionKeepRecent) && parsedCompressionKeepRecent >= 4 && parsedCompressionKeepRecent <= 200
  const generationDraftValid = temperatureValid && topPValid && maxTokensValid && compressionRatioValid && compressionKeepRecentValid

  const hasUnsavedModelSettings = settings
    ? settings.defaultModel !== draftDefaultModel ||
      settings.enabledModels.length !== draftEnabledModels.length ||
      !settings.enabledModels.every((m, i) => m === draftEnabledModels[i])
    : false

  const hasUnsavedGeneration = settings
    ? settings.temperature !== parsedTemperature ||
      settings.topP !== parsedTopP ||
      settings.maxTokens !== parsedMaxTokens ||
      settings.compressionEnabled !== compressionEnabled ||
      settings.compressionTriggerRatio !== parsedCompressionRatio ||
      settings.compressionKeepRecentMessages !== parsedCompressionKeepRecent ||
      (settings.summarizerModel ?? '') !== (draftSummarizerModel ?? '') ||
      settings.summarizerProvider !== draftSummarizerProvider ||
      settings.chatReasoningEnabled !== draftChatReasoning ||
      settings.chatHighReasoningEnabled !== draftChatHighReasoning
    : false
  const hasUnsavedSystemPrompt = settings ? draftSystemPrompt !== settings.systemPrompt : false
  const hasUnsavedSnackOverlay = settings
    ? draftSnackSystemPrompt !== resolveSnackSystemOverlay(settings.snackSystemOverlay)
    : false
  const hasUnsavedSyzygyPostPrompt = settings
    ? draftSyzygyPostPrompt !== resolveSyzygyPostPrompt(settings.syzygyPostSystemPrompt)
    : false
  const hasUnsavedSyzygyReplyPrompt = settings
    ? draftSyzygyReplyPrompt !== resolveSyzygyReplyPrompt(settings.syzygyReplySystemPrompt)
    : false
  const hasUnsavedPrompt =
    hasUnsavedSystemPrompt ||
    hasUnsavedSnackOverlay ||
    hasUnsavedSyzygyPostPrompt ||
    hasUnsavedSyzygyReplyPrompt ||
    hasUnsavedModelSettings ||
    hasUnsavedGeneration

  useEffect(() => {
    if (!hasUnsavedPrompt) {
      return
    }
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
  }, [hasUnsavedPrompt])

  const handleDisableModel = () => {
    if (!settings || !pendingDisable) {
      return
    }
    const modelId = pendingDisable
    const nextEnabled = draftEnabledModels.filter((id) => id !== modelId)
    const nextDefault = draftDefaultModel === modelId ? nextEnabled[0] ?? defaultModelId : draftDefaultModel
    setDraftEnabledModels(nextEnabled)
    setDraftDefaultModel(nextDefault)
    setModelStatus('idle')
    setPendingDisable(null)
  }

  const handleEnableModel = (modelId: string, setDefault: boolean) => {
    if (!settings) {
      return
    }
    const alreadyEnabled = draftEnabledModels.includes(modelId)
    const nextEnabled = alreadyEnabled ? draftEnabledModels : [...draftEnabledModels, modelId]
    const nextDefault = setDefault ? modelId : draftDefaultModel || (alreadyEnabled ? draftDefaultModel : modelId)
    setDraftEnabledModels(nextEnabled)
    setDraftDefaultModel(nextDefault)
    setModelStatus('idle')
  }

  const handleSetDefault = (modelId: string) => {
    if (!settings) {
      return
    }
    const nextEnabled = draftEnabledModels.includes(modelId)
      ? draftEnabledModels
      : [...draftEnabledModels, modelId]
    setDraftEnabledModels(nextEnabled)
    setDraftDefaultModel(modelId)
    setModelStatus('idle')
  }

  const handleSaveModelSettings = async () => {
    if (!settings || !hasUnsavedModelSettings) {
      return
    }
    const nextEnabledModels = draftEnabledModels.includes(draftDefaultModel)
      ? draftEnabledModels
      : [...draftEnabledModels, draftDefaultModel]
    const nextSettings = buildNextSettings({
      enabledModels: nextEnabledModels,
      defaultModel: draftDefaultModel,
    })
    if (!nextSettings) {
      return
    }
    setModelStatus('saving')
    setModelError(null)
    try {
      await onSaveSettings(nextSettings)
      setModelStatus('saved')
    } catch (error) {
      console.warn('保存模型库设置失败', error)
      setModelStatus('error')
      setModelError('保存失败，请稍后重试。')
    }
  }

  const handleTemperatureChange = (value: string) => {
    setTemperatureInput(value)
    const parsed = Number(value)
    if (Number.isNaN(parsed)) {
      setErrors((prev) => ({ ...prev, temperature: '请输入数字' }))
      return
    }
    if (parsed < 0 || parsed > 2) {
      setErrors((prev) => ({ ...prev, temperature: '温度需在 0 到 2 之间' }))
      return
    }
    setErrors((prev) => ({ ...prev, temperature: undefined }))
    setGenerationStatus('idle')
  }

  const handleTopPChange = (value: string) => {
    setTopPInput(value)
    const parsed = Number(value)
    if (Number.isNaN(parsed)) {
      setErrors((prev) => ({ ...prev, topP: '请输入数字' }))
      return
    }
    if (parsed < 0 || parsed > 1) {
      setErrors((prev) => ({ ...prev, topP: 'Top P 需在 0 到 1 之间' }))
      return
    }
    setErrors((prev) => ({ ...prev, topP: undefined }))
    setGenerationStatus('idle')
  }

  const handleMaxTokensChange = (value: string) => {
    setMaxTokensInput(value)
    const parsed = Number.parseInt(value, 10)
    if (Number.isNaN(parsed)) {
      setErrors((prev) => ({ ...prev, maxTokens: '请输入整数' }))
      return
    }
    if (parsed < 32 || parsed > 4000) {
      setErrors((prev) => ({ ...prev, maxTokens: '最大 token 需在 32 到 4000 之间' }))
      return
    }
    setErrors((prev) => ({ ...prev, maxTokens: undefined }))
    setGenerationStatus('idle')
  }

  const handleChatReasoningToggle = (enabled: boolean) => {
    setDraftChatReasoning(enabled)
    setGenerationStatus('idle')
  }

  const handleChatHighReasoningToggle = (enabled: boolean) => {
    setDraftChatHighReasoning(enabled)
    setGenerationStatus('idle')
  }

  const handleCompressionRatioChange = (value: string) => {
    setCompressionRatioInput(value)
    const parsed = Number(value)
    if (Number.isNaN(parsed)) {
      setErrors((prev) => ({ ...prev, compressionRatio: '请输入数字' }))
      return
    }
    if (parsed < 0.1 || parsed > 0.95) {
      setErrors((prev) => ({ ...prev, compressionRatio: '触发比例需在 0.1 到 0.95 之间' }))
      return
    }
    setErrors((prev) => ({ ...prev, compressionRatio: undefined }))
    setGenerationStatus('idle')
  }

  const handleCompressionKeepRecentChange = (value: string) => {
    setCompressionKeepRecentInput(value)
    const parsed = Number.parseInt(value, 10)
    if (Number.isNaN(parsed)) {
      setErrors((prev) => ({ ...prev, compressionKeepRecent: '请输入整数' }))
      return
    }
    if (parsed < 4 || parsed > 200) {
      setErrors((prev) => ({ ...prev, compressionKeepRecent: '保留消息数需在 4 到 200 之间' }))
      return
    }
    setErrors((prev) => ({ ...prev, compressionKeepRecent: undefined }))
    setGenerationStatus('idle')
  }

  const handleSaveGenerationSettings = async () => {
    if (!settings || !generationDraftValid || !hasUnsavedGeneration) {
      return
    }
    const nextSettings = buildNextSettings({
      temperature: parsedTemperature,
      topP: parsedTopP,
      maxTokens: parsedMaxTokens,
      compressionEnabled,
      compressionTriggerRatio: parsedCompressionRatio,
      compressionKeepRecentMessages: parsedCompressionKeepRecent,
      summarizerModel: draftSummarizerModel,
      summarizerProvider: draftSummarizerProvider,
      chatReasoningEnabled: draftChatReasoning,
      chatHighReasoningEnabled: draftChatHighReasoning,
    })
    if (!nextSettings) {
      return
    }
    setGenerationStatus('saving')
    setGenerationError(null)
    try {
      await onSaveSettings(nextSettings)
      setGenerationStatus('saved')
    } catch (error) {
      console.warn('保存生成参数失败', error)
      setGenerationStatus('error')
      setGenerationError('保存失败，请稍后重试。')
    }
  }

  const hasUnsavedExtract = settings
    ? settings.autoMemoryExtractEnabled !== draftAutoExtractEnabled ||
      settings.memoryExtractModel !== draftExtractModel ||
      settings.memoryExtractProvider !== draftExtractProvider
    : false

  // The on/off switch is a KILL switch — persist it immediately (like the
  // keepalive / mood toggles) instead of needing the explicit save button.
  // The old draft-only behaviour is why "我关了还在提取" happened: the user
  // flipped the UI but never saved, so the stored value stayed true and the
  // runtime kept extracting. Save the current draft model/provider alongside
  // so the settings→draft reset effect is a no-op (no half-edit loss).
  const handleToggleAutoExtract = async (checked: boolean) => {
    setDraftAutoExtractEnabled(checked)
    setExtractStatus('idle')
    if (!settings) return
    const nextSettings = buildNextSettings({
      autoMemoryExtractEnabled: checked,
      memoryExtractModel: draftExtractModel,
      memoryExtractProvider: draftExtractProvider,
    })
    if (!nextSettings) return
    try {
      await onSaveSettings(nextSettings)
      setExtractStatus('saved')
    } catch (error) {
      console.warn('保存自动提取开关失败', error)
      setExtractStatus('error')
    }
  }

  const handleSaveExtractSettings = async () => {
    if (!settings || !hasUnsavedExtract) return
    const nextSettings = buildNextSettings({
      autoMemoryExtractEnabled: draftAutoExtractEnabled,
      memoryExtractModel: draftExtractModel,
      memoryExtractProvider: draftExtractProvider,
    })
    if (!nextSettings) return
    setExtractStatus('saving')
    try {
      await onSaveSettings(nextSettings)
      setExtractStatus('saved')
    } catch (error) {
      console.warn('保存自动提取设置失败', error)
      setExtractStatus('error')
    }
  }

  const handleSystemPromptChange = (value: string) => {
    setDraftSystemPrompt(value)
    if (systemPromptStatus !== 'idle') {
      setSystemPromptStatus('idle')
    }
  }

  const handleSaveSystemPrompt = async () => {
    if (!settings || !hasUnsavedSystemPrompt) {
      return
    }
    const nextPrompt = draftSystemPrompt
    const nextSettings = buildNextSettings({ systemPrompt: nextPrompt })
    if (!nextSettings) {
      return
    }
    setSystemPromptStatus('saving')
    try {
      await onSaveSettings(nextSettings)
      setSystemPromptStatus('saved')
    } catch (error) {
      console.warn('保存系统提示词失败', error)
      setSystemPromptStatus('error')
    }
  }

  const handleSnackOverlayChange = (value: string) => {
    setDraftSnackSystemPrompt(value)
    if (snackOverlayStatus !== 'idle') {
      setSnackOverlayStatus('idle')
    }
  }

  const handleSaveSnackOverlay = async () => {
    if (!settings || !hasUnsavedSnackOverlay) {
      return
    }
    const nextOverlay = resolveSnackSystemOverlay(draftSnackSystemPrompt)
    setDraftSnackSystemPrompt(nextOverlay)
    setSnackOverlayStatus('saving')
    try {
      await onSaveSnackSystemPrompt(nextOverlay)
      setSnackOverlayStatus('saved')
    } catch (error) {
      console.warn('保存零食风格覆盖失败', error)
      setSnackOverlayStatus('error')
    }
  }

  const handleResetSnackOverlay = () => {
    setDraftSnackSystemPrompt(DEFAULT_SNACK_SYSTEM_OVERLAY)
    setSnackOverlayStatus('idle')
  }


  const handleSyzygyPostPromptChange = (value: string) => {
    setDraftSyzygyPostPrompt(value)
    if (syzygyPostStatus !== 'idle') {
      setSyzygyPostStatus('idle')
    }
  }

  const handleSyzygyReplyPromptChange = (value: string) => {
    setDraftSyzygyReplyPrompt(value)
    if (syzygyReplyStatus !== 'idle') {
      setSyzygyReplyStatus('idle')
    }
  }

  const handleSaveSyzygyPostPrompt = async () => {
    if (!settings || !hasUnsavedSyzygyPostPrompt) {
      return
    }
    const nextPrompt = resolveSyzygyPostPrompt(draftSyzygyPostPrompt)
    setDraftSyzygyPostPrompt(nextPrompt)
    setSyzygyPostStatus('saving')
    try {
      await onSaveSyzygyPostPrompt(nextPrompt)
      setSyzygyPostStatus('saved')
    } catch (error) {
      console.warn('保存TA发帖提示词失败', error)
      setSyzygyPostStatus('error')
    }
  }

  const handleSaveSyzygyReplyPrompt = async () => {
    if (!settings || !hasUnsavedSyzygyReplyPrompt) {
      return
    }
    const nextPrompt = resolveSyzygyReplyPrompt(draftSyzygyReplyPrompt)
    setDraftSyzygyReplyPrompt(nextPrompt)
    setSyzygyReplyStatus('saving')
    try {
      await onSaveSyzygyReplyPrompt(nextPrompt)
      setSyzygyReplyStatus('saved')
    } catch (error) {
      console.warn('保存TA回复提示词失败', error)
      setSyzygyReplyStatus('error')
    }
  }

  const handleResetSyzygyPostPrompt = () => {
    setDraftSyzygyPostPrompt(DEFAULT_SYZYGY_POST_PROMPT)
    setSyzygyPostStatus('idle')
  }

  const handleResetSyzygyReplyPrompt = () => {
    setDraftSyzygyReplyPrompt(DEFAULT_SYZYGY_REPLY_PROMPT)
    setSyzygyReplyStatus('idle')
  }

  const requestNavigation = (action: () => void) => {
    if (!hasUnsavedPrompt) {
      action()
      return
    }
    pendingNavigationRef.current = action
    setShowUnsavedPromptDialog(true)
  }

  const handleStayOnPage = () => {
    pendingNavigationRef.current = null
    setShowUnsavedPromptDialog(false)
  }

  const handleLeaveWithoutSave = () => {
    if (settings) {
      setTemperatureInput(settings.temperature.toString())
      setTopPInput(settings.topP.toString())
      setMaxTokensInput(settings.maxTokens.toString())
      setDraftEnabledModels(settings.enabledModels)
      setDraftDefaultModel(settings.defaultModel)
      setDraftChatReasoning(settings.chatReasoningEnabled)
      setDraftChatHighReasoning(settings.chatHighReasoningEnabled)
      setModelStatus('idle')
      setModelError(null)
      setDraftSystemPrompt(settings.systemPrompt)
      setDraftSnackSystemPrompt(resolveSnackSystemOverlay(settings.snackSystemOverlay))
      setGenerationStatus('idle')
      setGenerationError(null)
      setSystemPromptStatus('idle')
      setSnackOverlayStatus('idle')
      setDraftSyzygyPostPrompt(resolveSyzygyPostPrompt(settings.syzygyPostSystemPrompt))
      setDraftSyzygyReplyPrompt(resolveSyzygyReplyPrompt(settings.syzygyReplySystemPrompt))
      setSyzygyPostStatus('idle')
      setSyzygyReplyStatus('idle')
    }
    setShowUnsavedPromptDialog(false)
    const pendingAction = pendingNavigationRef.current
    pendingNavigationRef.current = null
    pendingAction?.()
  }

  const handleSaveAndLeave = async () => {
    const saves: Promise<void>[] = []
    if (hasUnsavedSystemPrompt) saves.push(handleSaveSystemPrompt())
    if (hasUnsavedSnackOverlay) saves.push(handleSaveSnackOverlay())
    if (hasUnsavedGeneration) saves.push(handleSaveGenerationSettings())
    if (hasUnsavedModelSettings) saves.push(handleSaveModelSettings())
    if (hasUnsavedSyzygyPostPrompt) saves.push(handleSaveSyzygyPostPrompt())
    if (hasUnsavedSyzygyReplyPrompt) saves.push(handleSaveSyzygyReplyPrompt())
    await Promise.allSettled(saves)
    setShowUnsavedPromptDialog(false)
    const pendingAction = pendingNavigationRef.current
    pendingNavigationRef.current = null
    pendingAction?.()
  }

  const selectedModelId = draftEnabledModels.includes(draftDefaultModel)
    ? draftDefaultModel
    : draftEnabledModels.includes(defaultModelId)
      ? defaultModelId
      : draftEnabledModels[0] ?? draftDefaultModel ?? defaultModelId

  if (!ready || !settings) {
    return (
      <div className="settings-shell app-shell">
        <header className="settings-header app-shell__header">
          <button
            type="button"
            className="page-back-btn"
            aria-label="返回"
            onClick={() => requestNavigation(() => navigate(-1))}
          >
            ‹
          </button>
          <h1 className="ui-title">设置</h1>
          <span className="header-spacer" />
        </header>
        <div className="settings-page app-shell__content">
          <div className="settings-ribbon-divider" aria-hidden="true">
            <span className="settings-ribbon-line" />
            <span className="settings-ribbon-icon">🎀</span>
            <span className="settings-ribbon-line" />
          </div>
          <div className="settings-loading">正在加载设置...</div>
        </div>
      </div>
    )
  }

  return (
    <div className="settings-shell app-shell">
      <header className="settings-header app-shell__header">
        <button
          type="button"
          className="page-back-btn"
          aria-label="返回"
          onClick={() => requestNavigation(() => navigate(-1))}
        >
          ‹
        </button>
        <h1 className="ui-title">设置</h1>
        <span className="header-spacer" />
      </header>

      <div className="settings-page app-shell__content">
        <div className="settings-ribbon-divider" aria-hidden="true">
          <span className="settings-ribbon-line" />
          <span className="settings-ribbon-icon">☁</span>
          <span className="settings-ribbon-line" />
        </div>

        <div className="settings-group" role="list">
      <section className="settings-section" role="listitem">
        <button
          type="button"
          className="collapse-header"
          onClick={() => setAvatarSectionExpanded((current) => !current)}
          aria-expanded={avatarSectionExpanded}
        >
          <span className="section-title">
            <span className="section-icon" aria-hidden="true">🖼️</span>
            <h2 className="ui-title">头像</h2>
            <p>点击上传，右上角 × 删除。</p>
          </span>
          <span className="collapse-indicator" aria-hidden="true">›</span>
        </button>
        {avatarSectionExpanded ? (
          <div className="accordion-content">
            <div className="settings-avatar-section">
              <div className="settings-avatar-item">
                <span className="settings-avatar-label">我的头像</span>
                <LocalAvatar storageKey="my-homepage-avatar" alt="kitten" />
              </div>
              <div className="settings-avatar-item">
                <span className="settings-avatar-label">Claude 头像</span>
                <LocalAvatar storageKey="syzygy-homepage-avatar" alt="Claude" />
              </div>
            </div>
          </div>
        ) : null}
      </section>
        </div>

        <div className="settings-group" role="list">
      <section className="settings-section" role="listitem">
        <button
          type="button"
          className="collapse-header"
          onClick={() => setOpenRouterKeySectionExpanded((current) => !current)}
          aria-expanded={openRouterKeySectionExpanded}
        >
          <span className="section-title">
            <span className="section-icon" aria-hidden="true">🔑</span>
            <h2 className="ui-title">OpenRouter API Key</h2>
            <p>API Key 仅保存在本地浏览器，不会上传。更换设备/浏览器需要重新填写。清除浏览器数据会丢失。</p>
          </span>
          <span className="collapse-indicator" aria-hidden="true">›</span>
        </button>
        {openRouterKeySectionExpanded ? (
          <div className="accordion-content">
            <label>API 格式</label>
            <div className="system-prompt-actions" role="radiogroup" aria-label="API 格式">
              <button
                type="button"
                role="radio"
                aria-checked={openRouterFormat === 'openai'}
                className={openRouterFormat === 'openai' ? 'primary' : 'ghost'}
                onClick={() => {
                  setOpenRouterFormatState('openai')
                  setOpenRouterFormat('openai')
                }}
              >
                OpenAI 兼容
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={openRouterFormat === 'anthropic'}
                className={openRouterFormat === 'anthropic' ? 'primary' : 'ghost'}
                onClick={() => {
                  setOpenRouterFormatState('anthropic')
                  setOpenRouterFormat('anthropic')
                }}
              >
                Anthropic 兼容
              </button>
            </div>
            <span className="settings-hint">
              {openRouterFormat === 'anthropic'
                ? '走 /v1/messages 路径，原生思考链 + 缓存。仅 Claude 模型可用。'
                : '走 /v1/chat/completions 路径，所有模型通用。'}
            </span>

            <label htmlFor="openrouter-api-key">API Key</label>
            <div className="model-select-row">
              <input
                id="openrouter-api-key"
                type={openRouterApiKeyVisible ? 'text' : 'password'}
                value={openRouterApiKeyInput}
                onChange={(event) => {
                  setOpenRouterApiKeyInput(event.target.value)
                  setOpenRouterApiKeyStatus('idle')
                }}
                placeholder="sk-or-v1-..."
              />
              <button
                type="button"
                className="ghost small"
                onClick={() => setOpenRouterApiKeyVisible((current) => !current)}
              >
                {openRouterApiKeyVisible ? '隐藏' : '显示'}
              </button>
            </div>
            <div className="system-prompt-actions">
              <button
                type="button"
                className="primary"
                onClick={handleSaveOpenRouterApiKey}
                disabled={!openRouterApiKeyInput.trim()}
              >
                保存
              </button>
              <button
                type="button"
                className="ghost danger"
                onClick={handleClearOpenRouterApiKey}
                disabled={!openRouterApiKeyInput.trim()}
              >
                清除
              </button>
              {openRouterApiKeyStatus === 'saved' ? <span className="system-prompt-status">已保存到本地</span> : null}
            </div>
          </div>
        ) : null}
      </section>
      <section className="settings-section" role="listitem">
        <button
          type="button"
          className="collapse-header"
          onClick={() => setMsuicodeSectionExpanded((current) => !current)}
          aria-expanded={msuicodeSectionExpanded}
        >
          <span className="section-title">
            <span className="section-icon" aria-hidden="true">🪞</span>
            <h2 className="ui-title">{customProviderName} API Key</h2>
            <p>备用 API 提供商（OpenAI 兼容格式）。在模型库里切换激活。</p>
          </span>
          <span className="collapse-indicator" aria-hidden="true">›</span>
        </button>
        {msuicodeSectionExpanded ? (
          <div className="accordion-content">
            <label>API 格式</label>
            <div className="system-prompt-actions" role="radiogroup" aria-label="API 格式">
              <button
                type="button"
                role="radio"
                aria-checked={msuicodeFormat === 'openai'}
                className={msuicodeFormat === 'openai' ? 'primary' : 'ghost'}
                onClick={() => {
                  setMsuicodeFormatState('openai')
                  setMsuicodeFormat('openai')
                }}
              >
                OpenAI 兼容
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={msuicodeFormat === 'anthropic'}
                className={msuicodeFormat === 'anthropic' ? 'primary' : 'ghost'}
                onClick={() => {
                  setMsuicodeFormatState('anthropic')
                  setMsuicodeFormat('anthropic')
                }}
              >
                Anthropic 兼容
              </button>
            </div>
            <span className="settings-hint">
              {msuicodeFormat === 'anthropic'
                ? '走 /v1/messages 路径，中转需透传 Anthropic 原生格式才能用，可拿到思考链。'
                : '走 /v1/chat/completions 路径，OpenAI 格式，通用但中转模型一般无思考链。'}
            </span>

            <label htmlFor="msuicode-base-url">Base URL</label>
            <input
              id="msuicode-base-url"
              type="text"
              value={msuicodeBaseUrlInput}
              onChange={(event) => {
                setMsuicodeBaseUrlInput(event.target.value)
                setMsuicodeApiKeyStatus('idle')
              }}
              placeholder={DEFAULT_MSUICODE_BASE}
            />
            <label htmlFor="msuicode-api-key">API Key</label>
            <div className="model-select-row">
              <input
                id="msuicode-api-key"
                type={msuicodeApiKeyVisible ? 'text' : 'password'}
                value={msuicodeApiKeyInput}
                onChange={(event) => {
                  setMsuicodeApiKeyInput(event.target.value)
                  setMsuicodeApiKeyStatus('idle')
                }}
                placeholder="sk-..."
              />
              <button
                type="button"
                className="ghost small"
                onClick={() => setMsuicodeApiKeyVisible((current) => !current)}
              >
                {msuicodeApiKeyVisible ? '隐藏' : '显示'}
              </button>
            </div>
            <div className="system-prompt-actions">
              <button
                type="button"
                className="primary"
                onClick={handleSaveMsuicodeApiKey}
                disabled={!msuicodeApiKeyInput.trim()}
              >
                保存
              </button>
              <button
                type="button"
                className="ghost danger"
                onClick={handleClearMsuicodeApiKey}
                disabled={!msuicodeApiKeyInput.trim()}
              >
                清除
              </button>
              {msuicodeApiKeyStatus === 'saved' ? <span className="system-prompt-status">已保存到本地</span> : null}
            </div>

            <label>中转预设</label>
            <div className="system-prompt-actions">
              <button
                type="button"
                className="ghost small"
                onClick={handleSaveCurrentRelayAsPreset}
                disabled={!(msuicodeBaseUrlInput.trim() || msuicodeApiKeyInput.trim())}
              >
                ＋ 把当前中转存为预设
              </button>
            </div>
            {relayPresets.length > 0 ? (
              <ul className="relay-preset-list">
                {relayPresets.map((preset) => (
                  <li key={preset.id} className="relay-preset-item">
                    <button
                      type="button"
                      className="relay-preset-apply"
                      onClick={() => handleApplyRelayPreset(preset)}
                    >
                      <span className="relay-preset-name">{preset.name}</span>
                      <span className="relay-preset-url">
                        {preset.baseUrl}（{preset.format === 'anthropic' ? 'Anthropic' : 'OpenAI'}）
                      </span>
                    </button>
                    <button
                      type="button"
                      className="relay-preset-delete"
                      aria-label="删除预设"
                      onClick={() => handleDeleteRelayPreset(preset.id)}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <span className="settings-hint">
                把当前 Base URL + Key + 格式存成预设，之后点一下就能在多个中转站之间切换。
              </span>
            )}

            <label>余额 · 花费 · 模型</label>
            <RelayChannelPanel targets={channelTargets} />

            <label>渠道自愈记录</label>
            <div className="system-prompt-actions">
              <button type="button" className="ghost small" onClick={handleResetSelfHeal}>
                重置渠道自愈记录
              </button>
              {selfHealResetStatus === 'done' ? (
                <span className="system-prompt-status">已重置,下次请求将重试最优形态</span>
              ) : null}
            </div>
            <span className="settings-hint">
              {selfHealSummary.length > 0
                ? `当前记录:${selfHealSummary.join(';')}。渠道换池子/升级后可重置让 App 重试最优请求形态——不兼容会自动再降级,重置永远安全。`
                : '暂无降级记录。撞到不兼容的中转节点时,App 会自动降级(如停用原生思考回传)并按渠道记住,这里可以随时清除重试。'}
            </span>
          </div>
        ) : null}
      </section>

      <section className="settings-section" role="listitem">
        <button
          type="button"
          className="collapse-header"
          onClick={() => setTtsSectionExpanded((current) => !current)}
          aria-expanded={ttsSectionExpanded}
        >
          <span className="section-title">
            <span className="section-icon" aria-hidden="true">🔊</span>
            <h2 className="ui-title">语音（TTS · MiniMax / ElevenLabs）</h2>
            <p>开启后，AI 用 [voice]…[/voice] 包起来的内容会显示成语音条（点播才合成，可转文字）。两家供应商二选一，各自的配置分开保存。</p>
          </span>
          <span className="collapse-indicator" aria-hidden="true">›</span>
        </button>
        {ttsSectionExpanded ? (
          <div className="accordion-content">
            <label className="header-menu-toggle" style={{ paddingLeft: 0 }}>
              <input
                type="checkbox"
                checked={ttsDraft.enabled}
                onChange={(e) => patchTts({ enabled: e.target.checked })}
              />
              <span>开启语音条</span>
            </label>

            <label htmlFor="tts-provider">供应商</label>
            <select id="tts-provider" value={ttsDraft.provider}
              onChange={(e) => patchTts({ provider: e.target.value as TtsProvider })}>
              <option value="minimax">MiniMax（中文最稳·按量便宜）</option>
              <option value="elevenlabs">ElevenLabs（最真实·会笑会叹气·免费档够轻量用）</option>
            </select>

            {ttsDraft.provider === 'elevenlabs' ? (
              <>
                <label htmlFor="tts-el-voice-id">Voice ID</label>
                <input id="tts-el-voice-id" type="text" value={ttsDraft.elVoiceId}
                  onChange={(e) => patchTts({ elVoiceId: e.target.value })}
                  placeholder="从 ElevenLabs 语音库复制（如 21m00Tcm...）" />
                <label htmlFor="tts-el-api-key">API Key</label>
                <div className="model-select-row">
                  <input id="tts-el-api-key" type={ttsApiKeyVisible ? 'text' : 'password'} value={ttsDraft.elApiKey}
                    onChange={(e) => patchTts({ elApiKey: e.target.value })}
                    placeholder="sk_...（仅存本地）" />
                  <button type="button" className="ghost small" onClick={() => setTtsApiKeyVisible((v) => !v)}>
                    {ttsApiKeyVisible ? '隐藏' : '显示'}
                  </button>
                </div>
                <label htmlFor="tts-el-model">模型</label>
                <select id="tts-el-model" value={ttsDraft.elModel}
                  onChange={(e) => patchTts({ elModel: e.target.value })}>
                  {(EL_MODELS.includes(ttsDraft.elModel) ? EL_MODELS : [ttsDraft.elModel, ...EL_MODELS]).map((m) => (
                    <option key={m} value={m}>
                      {
                        m === 'eleven_v3'
                          ? `${m}（最有感情·支持 [laughs] 等语气，推荐）`
                          : m === 'eleven_multilingual_v2'
                            ? `${m}（稳定·省积分）`
                            : m === 'eleven_turbo_v2_5'
                              ? `${m}（最快最省）`
                              : m
                      }
                    </option>
                  ))}
                </select>
                <label htmlFor="tts-el-stability">情绪稳定度（{ttsDraft.elStability}）</label>
                <select id="tts-el-stability" value={String(ttsDraft.elStability)}
                  onChange={(e) => patchTts({ elStability: Number(e.target.value) })}>
                  <option value="0">0 · Creative（最放飞·最有情绪）</option>
                  <option value="0.5">0.5 · Natural（自然·推荐）</option>
                  <option value="1">1 · Robust（最稳·像念稿）</option>
                </select>
                <span className="settings-hint">v3 可在文本里写 [laughs]/[sighs]/[whispers] 等标签触发语气；积分用完到下月重置，免费档不会自动扣费。</span>
              </>
            ) : (
              <>
                <label htmlFor="tts-voice-id">Voice ID</label>
                <input id="tts-voice-id" type="text" value={ttsDraft.voiceId}
                  onChange={(e) => patchTts({ voiceId: e.target.value })}
                  placeholder="moss_audio_..." />
                <label htmlFor="tts-api-key">API Key</label>
                <div className="model-select-row">
                  <input id="tts-api-key" type={ttsApiKeyVisible ? 'text' : 'password'} value={ttsDraft.apiKey}
                    onChange={(e) => patchTts({ apiKey: e.target.value })}
                    placeholder="MiniMax API Key（仅存本地）" />
                  <button type="button" className="ghost small" onClick={() => setTtsApiKeyVisible((v) => !v)}>
                    {ttsApiKeyVisible ? '隐藏' : '显示'}
                  </button>
                </div>
                <label htmlFor="tts-group-id">GroupId（MiniMax 控制台，可能必填）</label>
                <input id="tts-group-id" type="text" value={ttsDraft.groupId}
                  onChange={(e) => patchTts({ groupId: e.target.value })}
                  placeholder="留空先试，报错再填" />
                <label htmlFor="tts-base-url">Base URL</label>
                <input id="tts-base-url" type="text" value={ttsDraft.baseUrl}
                  onChange={(e) => patchTts({ baseUrl: e.target.value })}
                  placeholder={DEFAULT_TTS_BASE} />
                <span className="settings-hint">国际版 {DEFAULT_TTS_BASE}；国内账号用 https://api.minimaxi.com</span>
                <label htmlFor="tts-model">模型</label>
                <select id="tts-model" value={ttsDraft.model}
                  onChange={(e) => patchTts({ model: e.target.value })}>
                  {(TTS_MODELS.includes(ttsDraft.model) ? TTS_MODELS : [ttsDraft.model, ...TTS_MODELS]).map((m) => (
                    <option key={m} value={m}>
                      {
                        m === 'speech-2.8-turbo'
                          ? `${m}（快·便宜，推荐）`
                          : m === 'speech-2.8-hd'
                            ? `${m}（高质量·贵）`
                            : m
                      }
                    </option>
                  ))}
                </select>
              </>
            )}

            <div className="system-prompt-actions">
              <button type="button" className="primary"
                disabled={ttsStatus === 'saving'}
                onClick={() => {
                  setTtsStatus('saving')
                  setTtsError(null)
                  setTtsCheck(null)
                  void (async () => {
                    try {
                      await commitTtsConfig(ttsDraft)
                      // Read it straight back out of durable storage to prove it landed.
                      setTtsCheck(await readbackTtsActive())
                      setTtsStatus('saved')
                    } catch (e) {
                      setTtsError(e instanceof Error ? e.message : String(e))
                      setTtsStatus('idle')
                    }
                  })()
                }}>
                {ttsStatus === 'saving' ? '保存中…' : '保存'}
              </button>
              {ttsStatus === 'saved' ? <span className="system-prompt-status">已保存 ✓</span> : null}
            </div>
            {ttsCheck ? (
              <span className="settings-hint">
                存储自检 → 原生存储:{ttsCheck.native ? '开' : '关(localStorage)'}｜
                供应商:{ttsCheck.provider}｜Voice ID:{ttsCheck.voiceLen}位｜API Key:{ttsCheck.keyLen}位
                {ttsCheck.voiceLen > 0 && ttsCheck.keyLen > 0 ? '（已落盘✓）' : '（写入失败❌）'}
              </span>
            ) : null}
            {ttsError ? <span className="voice-bar__err">保存出错：{ttsError}</span> : null}
            <span className="settings-hint">边填边会自动保存；填完点一下「保存」更稳妥（确保写进系统存储，关 App 也不丢）。</span>

            <hr />
            <label className="header-menu-toggle" style={{ paddingLeft: 0 }}>
              <input
                type="checkbox"
                checked={callCfg.enabled}
                onChange={(e) => patchCall({ enabled: e.target.checked })}
              />
              <span>📞 开启语音通话（callhome）</span>
            </label>
            <span className="settings-hint">
              开启后 TA 可以主动给你打电话（回复里带 [call:理由] 就会全屏响铃 90 秒），
              没接到会留语音留言；聊天页右上角也会出现 📞 让你打给 TA。通话是「按住说话」
              轮次制：你的话经 SenseVoice 转写（带情绪），TA 的回复自动用上面的 TTS 读出来。
              需要先把上面的语音（TTS）配置好并开启。
            </span>
            <label className="header-menu-toggle" style={{ paddingLeft: 0 }}>
              <input
                type="checkbox"
                checked={callCfg.dnd}
                onChange={(e) => patchCall({ dnd: e.target.checked })}
              />
              <span>🔕 勿扰模式（拦下 TA 的主动来电）</span>
            </label>
            <span className="settings-hint">也可以直接在聊天里说「帮我开勿扰」——TA 会用 [dnd:on]/[dnd:off] 帮你切换。</span>
          </div>
        ) : null}
      </section>

      <section className="settings-section" role="listitem">
        <button
          type="button"
          className="collapse-header"
          onClick={() => setWeatherSectionExpanded((current) => !current)}
          aria-expanded={weatherSectionExpanded}
        >
          <span className="section-title">
            <span className="section-icon" aria-hidden="true">🌤️</span>
            <h2 className="ui-title">天气</h2>
            <p>填入和风天气 Key 后精度更好（国内数据源）；不填自动用 Open-Meteo。</p>
          </span>
          <span className="collapse-indicator" aria-hidden="true">›</span>
        </button>
        {weatherSectionExpanded ? (
          <div className="accordion-content">
            <span className="settings-hint">先在和风控制台「设置」页找到你的专属 API Host（形如 abc123.qweatherapi.com），填到下面第一栏——旧的 devapi 公共域名已停用，不填会 403。然后把凭据页的16进制 API Key 粘到第二栏即可。（Ed25519 凭据才需要填 PEM 私钥 + 凭据ID + 项目ID。）</span>

            <label htmlFor="qweather-host">API Host（控制台「设置」页）</label>
            <input
              id="qweather-host"
              type="text"
              value={qweatherHost}
              onChange={(e) => { setQweatherHost(e.target.value); setQweatherCredStatus('idle') }}
              placeholder="如 abc123def.qweatherapi.com"
            />

            <label htmlFor="qweather-pem">API Key（和风天气）</label>
            <div className="model-select-row">
              <input
                id="qweather-pem"
                type={qweatherPemVisible ? 'text' : 'password'}
                value={qweatherPem}
                onChange={(e) => { setQweatherPem(e.target.value); setQweatherCredStatus('idle') }}
                placeholder="-----BEGIN PRIVATE KEY-----..."
              />
              <button type="button" className="ghost small" onClick={() => setQweatherPemVisible((v) => !v)}>
                {qweatherPemVisible ? '隐藏' : '显示'}
              </button>
            </div>

            <label htmlFor="qweather-kid">凭据ID（kid，Ed25519 凭据才需要填）</label>
            <input
              id="qweather-kid"
              type="text"
              value={qweatherKid}
              onChange={(e) => { setQweatherKid(e.target.value); setQweatherCredStatus('idle') }}
              placeholder="如 CA5CN4E7H8（普通 API Key 可留空）"
            />

            <label htmlFor="qweather-sub">项目ID（sub，Ed25519 凭据才需要填）</label>
            <input
              id="qweather-sub"
              type="text"
              value={qweatherSub}
              onChange={(e) => { setQweatherSub(e.target.value); setQweatherCredStatus('idle') }}
              placeholder="控制台项目 ID（普通 API Key 可留空）"
            />

            <div className="system-prompt-actions">
              <button
                type="button"
                className="primary"
                onClick={() => {
                  const pem = qweatherPem.trim()
                  if (!pem) return
                  saveQWeatherCredential({
                    privateKeyPem: pem,
                    credentialId: qweatherKid.trim(),
                    projectId: qweatherSub.trim(),
                    apiHost: qweatherHost.trim(),
                  })
                  setQweatherCredStatus('saved')
                }}
                disabled={!qweatherPem.trim()}
              >
                保存
              </button>
              <button
                type="button"
                className="ghost danger"
                onClick={() => {
                  clearQWeatherCredential()
                  setQweatherHost('')
                  setQweatherPem('')
                  setQweatherKid('')
                  setQweatherSub('')
                  setQweatherCredStatus('idle')
                }}
                disabled={!qweatherPem.trim() && !qweatherKid.trim() && !qweatherSub.trim() && !qweatherHost.trim()}
              >
                清除
              </button>
              {qweatherCredStatus === 'saved' ? <span className="system-prompt-status">已保存到本地</span> : null}
            </div>

            <label>当前天气缓存</label>
            {weatherSnap ? (
              <div className="settings-hint" style={{ fontFamily: 'monospace', lineHeight: 1.7 }}>
                <div>来源：{weatherSnap.source === 'qweather' ? '✅ 和风天气' : `⚠️ Open-Meteo${weatherSnap.qweatherError ? `（和风失败: ${weatherSnap.qweatherError}）` : '（未填 key）'}`}</div>
                <div>坐标：{weatherSnap.lat.toFixed(4)}, {weatherSnap.lon.toFixed(4)}</div>
                <div>城市：{weatherSnap.city ?? '未知'}</div>
                <div>天气：{weatherSnap.temperatureC}°C {weatherSnap.condition}</div>
                <div>刷新于：{new Date(weatherSnap.fetchedAt).toLocaleTimeString('zh-CN')}</div>
              </div>
            ) : (
              <p className="settings-hint">暂无缓存（沈暮开口前不会主动定位）</p>
            )}
            <div className="system-prompt-actions">
              <button
                type="button"
                className="ghost small"
                disabled={weatherRefreshing}
                onClick={async () => {
                  setWeatherRefreshing(true)
                  window.localStorage.removeItem('nimbus_weather_cache_v1')
                  try {
                    const snap = await fetchCurrentWeather()
                    setWeatherSnap(snap)
                  } finally {
                    setWeatherRefreshing(false)
                  }
                }}
              >
                {weatherRefreshing ? '定位中…' : '强制刷新'}
              </button>
            </div>
          </div>
        ) : null}
      </section>

      <section className="settings-section" role="listitem">
        <button
          type="button"
          className="collapse-header"
          onClick={() => setModelSectionExpanded((current) => !current)}
          aria-expanded={modelSectionExpanded}
        >
          <span className="section-title">
            <span className="section-icon" aria-hidden="true">⚙️</span>
            <h2 className="ui-title">模型库</h2>
            <p>管理已启用模型并设置默认模型。</p>
          </span>
          <span className="collapse-indicator" aria-hidden="true">›</span>
        </button>
        {modelSectionExpanded ? (
          <div className="accordion-content">
            <div className="model-select-card">
              <label>当前使用的 API</label>
              <div className="system-prompt-actions" role="radiogroup" aria-label="API 提供商">
                <button
                  type="button"
                  role="radio"
                  aria-checked={activeProvider === 'openrouter'}
                  className={activeProvider === 'openrouter' ? 'primary' : 'ghost'}
                  onClick={() => handleSwitchProvider('openrouter')}
                >
                  OpenRouter
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={activeProvider === 'msuicode'}
                  className={activeProvider === 'msuicode' ? 'primary' : 'ghost'}
                  onClick={() => handleSwitchProvider('msuicode')}
                >
                  {customProviderName}
                </button>
                <span className="system-prompt-status">
                  {activeProvider === 'msuicode'
                    ? `⚠️ ${customProviderName} 下无 prompt caching（按全价）`
                    : '🚀 OR 下走 Anthropic 缓存可省 ~90%'}
                </span>
              </div>
            </div>
            {draftEnabledModels.length === 0 ? (
              <div className="empty-state">暂无启用模型，请从下方模型库启用。</div>
            ) : (
              <div className="model-select-card">
                <div className="model-select-row">
                  <label htmlFor="enabled-models">默认模型</label>
                  <select
                    id="enabled-models"
                    value={selectedModelId}
                    onChange={(event) => handleSetDefault(event.target.value)}
                  >
                    {draftEnabledModels.map((modelId) => (
                      <option key={modelId} value={modelId}>
                        {catalogMap.get(modelId) ?? modelId}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="ghost danger small"
                    onClick={() => setPendingDisable(selectedModelId)}
                  >
                    停用
                  </button>
                </div>
                <div className="model-selected-meta">
                  <strong>{catalogMap.get(selectedModelId) ?? selectedModelId}</strong>
                  <span className="model-id">{selectedModelId}</span>
                </div>
              </div>
            )}

            <div className="section-title nested-prompt-title">
              <h2 className="ui-title">{activeProvider === 'msuicode' ? customProviderName : 'OpenRouter'} 模型库</h2>
              <p>搜索并启用你想使用的模型。换了分组/站点后点刷新。</p>
            </div>
            <div className="model-select-row">
              <input
                className="search-input"
                type="search"
                placeholder="搜索模型名称或 ID"
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                style={{ flex: 1 }}
              />
              <button
                type="button"
                className="ghost small"
                disabled={catalogStatus === 'loading'}
                onClick={() => setCatalogReloadKey((v) => v + 1)}
                title="重新从服务器拉取模型列表"
              >
                {catalogStatus === 'loading' ? '…' : '↺ 刷新'}
              </button>
            </div>
            {catalogStatus === 'loading' ? (
              <div className="catalog-status">正在加载模型库...</div>
            ) : null}
            {catalogStatus === 'error' ? (
              <div className="catalog-status error">{catalogError}</div>
            ) : null}
            {searchTerm.trim().length === 0 ? (
              <div className="catalog-hint">继续输入以缩小范围。</div>
            ) : null}
            {searchTerm.trim().length > 0 ? (
              <div className="catalog-dropdown">
                {visibleCatalog.length === 0 && catalogStatus !== 'loading' ? (
                  <div className="catalog-empty">未找到匹配模型。</div>
                ) : null}
                <ul className="catalog-results">
                  {visibleCatalog.map((model) => {
                    const enabled = draftEnabledModels.includes(model.id)
                    return (
                      <li key={model.id} className="catalog-result-item">
                        <div className="catalog-meta">
                          <strong>{model.name ?? model.id}</strong>
                          <span className="model-id">{model.id}</span>
                          {model.context_length ? (
                            <span className="context-length">上下文 {model.context_length}</span>
                          ) : null}
                        </div>
                        <div className="catalog-actions">
                          {enabled ? (
                            <span className="badge subtle">已启用</span>
                          ) : (
                            <button type="button" onClick={() => handleEnableModel(model.id, false)}>
                              启用
                            </button>
                          )}
                        </div>
                      </li>
                    )
                  })}
                </ul>
                {filteredCatalog.length > visibleCatalog.length ? (
                  <div className="catalog-hint">结果较多，请继续输入以缩小范围。</div>
                ) : null}
              </div>
            ) : null}

            <div className="system-prompt-actions">
              <button
                type="button"
                className="primary"
                onClick={() => void handleSaveModelSettings()}
                disabled={!hasUnsavedModelSettings || modelStatus === 'saving'}
              >
                {modelStatus === 'saving' ? '保存中…' : '保存'}
              </button>
              {hasUnsavedModelSettings ? <span className="system-prompt-status">有未保存修改</span> : null}
              {modelStatus === 'saved' ? <span className="system-prompt-status">已保存</span> : null}
              {modelStatus === 'error' ? <span className="field-error">{modelError}</span> : null}
            </div>
          </div>
        ) : null}
      </section>

      <section className="settings-section" role="listitem">
        <button
          type="button"
          className="collapse-header"
          onClick={() => setGenerationSectionExpanded((current) => !current)}
          aria-expanded={generationSectionExpanded}
        >
          <span className="section-title">
            <span className="section-icon" aria-hidden="true">🎛️</span>
            <h2 className="ui-title">生成参数</h2>
            <p>调整生成行为与推理开关。</p>
          </span>
          <span className="collapse-indicator" aria-hidden="true">›</span>
        </button>
        {generationSectionExpanded ? (
          <div className="accordion-content">
            <div className="field-group">
              <label htmlFor="temperature">温度 (0 - 2)</label>
              <input
                id="temperature"
                type="number"
                min="0"
                max="2"
                step="0.1"
                value={temperatureInput}
                onChange={(event) => handleTemperatureChange(event.target.value)}
              />
              {errors.temperature ? <span className="field-error">{errors.temperature}</span> : null}
            </div>
            <div className="field-group">
              <label htmlFor="topP">Top P (0 - 1)</label>
              <input
                id="topP"
                type="number"
                min="0"
                max="1"
                step="0.05"
                value={topPInput}
                onChange={(event) => handleTopPChange(event.target.value)}
              />
              {errors.topP ? <span className="field-error">{errors.topP}</span> : null}
            </div>
            <div className="field-group">
              <label htmlFor="maxTokens">最大 tokens (32 - 4000)</label>
              <input
                id="maxTokens"
                type="number"
                min="32"
                max="4000"
                step="1"
                value={maxTokensInput}
                onChange={(event) => handleMaxTokensChange(event.target.value)}
              />
              {errors.maxTokens ? <span className="field-error">{errors.maxTokens}</span> : null}
            </div>
          </div>
        ) : null}
      </section>

      <section className="settings-section" role="listitem">
        <button
          type="button"
          className="collapse-header"
          onClick={() => setReasoningSectionExpanded((current) => !current)}
          aria-expanded={reasoningSectionExpanded}
        >
          <span className="section-title">
            <span className="section-icon" aria-hidden="true">🔮</span>
            <h2 className="ui-title">思考链</h2>
            <p>控制日常聊天是否请求思考链。</p>
          </span>
          <span className="collapse-indicator" aria-hidden="true">›</span>
        </button>
        {reasoningSectionExpanded ? (
          <div className="accordion-content">
            <div className="field-group">
              <label htmlFor="chatReasoningEnabled">日常聊天思考链</label>
              <label className="toggle-control">
                <input
                  id="chatReasoningEnabled"
                  type="checkbox"
                  checked={draftChatReasoning}
                  onChange={(event) => handleChatReasoningToggle(event.target.checked)}
                />
                <span>{draftChatReasoning ? '已开启' : '已关闭'}</span>
              </label>
            </div>
            <div className="field-group">
              <label htmlFor="chatHighReasoningEnabled">聊天：高触发 Thinking（仅非 Claude 模型，如 GPT-5.x）</label>
              <label className="toggle-control">
                <input
                  id="chatHighReasoningEnabled"
                  type="checkbox"
                  checked={draftChatHighReasoning}
                  onChange={(event) => handleChatHighReasoningToggle(event.target.checked)}
                />
                <span>{draftChatHighReasoning ? '已开启' : '已关闭'}</span>
              </label>
            </div>
            <p className="field-help">仅对非 Claude 的 reasoning 模型（如 GPT-5.x）生效：开启后附加 reasoning: effort=high。Claude 系列不受此开关影响——它每轮固定带思考链，深度思考档已移除（实测会撑大 prompt、破坏缓存）。</p>
          </div>
        ) : null}
      </section>

      <section className="settings-section" role="listitem">
        <button
          type="button"
          className="collapse-header"
          onClick={() => setCompressionSectionExpanded((current) => !current)}
          aria-expanded={compressionSectionExpanded}
        >
          <span className="section-title">
            <span className="section-icon" aria-hidden="true">🧩</span>
            <h2 className="ui-title">上下文压缩</h2>
            <p>配置压缩触发阈值、保留条数与摘要模型。</p>
          </span>
          <span className="collapse-indicator" aria-hidden="true">›</span>
        </button>
        {compressionSectionExpanded ? (
          <div className="accordion-content">
            <div className="compression-fields">
            <label className="toggle-control" htmlFor="compressionEnabled">
              <input
                id="compressionEnabled"
                type="checkbox"
                checked={compressionEnabled}
                onChange={(event) => {
                  setCompressionEnabled(event.target.checked)
                  setGenerationStatus('idle')
                }}
              />
              <span>{compressionEnabled ? '压缩已开启' : '压缩已关闭'}</span>
            </label>

            <label htmlFor="compressionRatio">触发比例 (0.1 - 0.95)</label>
            <input
              id="compressionRatio"
              type="number"
              min="0.1"
              max="0.95"
              step="0.05"
              value={compressionRatioInput}
              onChange={(event) => handleCompressionRatioChange(event.target.value)}
            />
            {errors.compressionRatio ? <span className="field-error">{errors.compressionRatio}</span> : null}
            <span className="settings-hint">
              上下文用量超过该比例后开始压缩。注意:Claude/GPT 这类带工具的模型有 0.35 的有效上限
              (工具消息会打断缓存,提前压缩省钱得多)——设更高也按 0.35 触发,设更低则按你的值。
            </span>

            <label htmlFor="compressionKeepRecent">保留最近消息数 (4 - 200)</label>
            <input
              id="compressionKeepRecent"
              type="number"
              min="4"
              max="200"
              step="1"
              value={compressionKeepRecentInput}
              onChange={(event) => handleCompressionKeepRecentChange(event.target.value)}
            />
            {errors.compressionKeepRecent ? <span className="field-error">{errors.compressionKeepRecent}</span> : null}

            <label>Summarizer 提供商</label>
            <div className="system-prompt-actions" role="radiogroup" aria-label="压缩使用的 API">
              <button
                type="button"
                role="radio"
                aria-checked={draftSummarizerProvider === 'openrouter'}
                className={draftSummarizerProvider === 'openrouter' ? 'primary' : 'ghost'}
                onClick={() => {
                  setDraftSummarizerProvider('openrouter')
                  setGenerationStatus('idle')
                }}
              >
                OpenRouter
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={draftSummarizerProvider === 'msuicode'}
                className={draftSummarizerProvider === 'msuicode' ? 'primary' : 'ghost'}
                onClick={() => {
                  setDraftSummarizerProvider('msuicode')
                  setGenerationStatus('idle')
                }}
              >
                {customProviderName}
              </button>
            </div>

            <label htmlFor="summarizerModel">Summarizer Model</label>
            <select
              id="summarizerModel"
              value={draftSummarizerModel ?? ''}
              onChange={(event) => {
                const nextModel = event.target.value.trim()
                setDraftSummarizerModel(nextModel.length > 0 ? nextModel : null)
                setGenerationStatus('idle')
              }}
            >
              <option value="">自动（默认模型/经济模型）</option>
              {draftEnabledModels.map((modelId) => (
                <option key={modelId} value={modelId}>
                  {catalogMap.get(modelId) ?? modelId}
                </option>
              ))}
            </select>
            <span className="settings-hint">
              从你「启用的模型」里选。想用其他模型，先在模型库启用它。
            </span>
            </div>
            <div className="system-prompt-actions">
              <button
                type="button"
                className="primary"
                onClick={() => void handleSaveGenerationSettings()}
                disabled={!hasUnsavedGeneration || !generationDraftValid || generationStatus === 'saving'}
              >
                {generationStatus === 'saving' ? '保存中…' : '保存'}
              </button>
              {hasUnsavedGeneration ? <span className="system-prompt-status">有未保存修改</span> : null}
              {generationStatus === 'saved' ? <span className="system-prompt-status">已保存</span> : null}
              {generationStatus === 'error' ? <span className="field-error">{generationError}</span> : null}
            </div>
          </div>
        ) : null}
      </section>

      <section className="settings-section" role="listitem">
        <button
          type="button"
          className="collapse-header"
          onClick={() => setMemoryExtractSectionExpanded((current) => !current)}
          aria-expanded={memoryExtractSectionExpanded}
        >
          <span className="section-title">
            <span className="section-icon" aria-hidden="true">✨</span>
            <h2 className="ui-title">自动记忆提取</h2>
            <p>聊天时自动提取长期记忆，写入记忆库。</p>
          </span>
          <span className="collapse-indicator" aria-hidden="true">›</span>
        </button>
        {memoryExtractSectionExpanded ? (
          <div className="accordion-content">
            <div className="field-group">
              <label htmlFor="autoExtractEnabled">自动提取</label>
              <label className="toggle-control">
                <input
                  id="autoExtractEnabled"
                  type="checkbox"
                  checked={draftAutoExtractEnabled}
                  onChange={(event) => {
                    void handleToggleAutoExtract(event.target.checked)
                  }}
                />
                <span>{draftAutoExtractEnabled ? '已开启' : '已关闭'}</span>
              </label>
            </div>
            {draftAutoExtractEnabled ? (
              <>
                <div className="field-group">
                  <label>提取提供商</label>
                  <div className="system-prompt-actions" role="radiogroup" aria-label="提取使用的 API">
                    <button
                      type="button"
                      role="radio"
                      aria-checked={draftExtractProvider === 'openrouter'}
                      className={draftExtractProvider === 'openrouter' ? 'primary' : 'ghost'}
                      onClick={() => {
                        setDraftExtractProvider('openrouter')
                        setExtractStatus('idle')
                      }}
                    >
                      OpenRouter
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={draftExtractProvider === 'msuicode'}
                      className={draftExtractProvider === 'msuicode' ? 'primary' : 'ghost'}
                      onClick={() => {
                        setDraftExtractProvider('msuicode')
                        setExtractStatus('idle')
                      }}
                    >
                      {customProviderName}
                    </button>
                  </div>
                  <span className="settings-hint">和聊天分开走 —— 比如聊天走中转站，提取走 OpenRouter。</span>
                </div>
                <div className="field-group">
                  <label htmlFor="extractModel">提取模型</label>
                  <select
                    id="extractModel"
                    value={draftExtractModel}
                    onChange={(event) => {
                      setDraftExtractModel(event.target.value)
                      setExtractStatus('idle')
                    }}
                  >
                    {draftEnabledModels.map((modelId) => (
                      <option key={modelId} value={modelId}>
                        {catalogMap.get(modelId) ?? modelId}
                      </option>
                    ))}
                  </select>
                  <span className="settings-hint">从「启用的模型」里选一个上方提供商认得的模型，推荐用便宜的小模型。</span>
                </div>
                <p className="field-help">每 12 轮用户发言自动触发一次提取，冷却 10 分钟。待确认记忆 ≥ 50 条时暂停。</p>
              </>
            ) : null}
            <div className="system-prompt-actions">
              <button
                type="button"
                className="primary"
                onClick={() => void handleSaveExtractSettings()}
                disabled={!hasUnsavedExtract || extractStatus === 'saving'}
              >
                {extractStatus === 'saving' ? '保存中…' : '保存'}
              </button>
              {hasUnsavedExtract ? <span className="system-prompt-status">有未保存修改</span> : null}
              {extractStatus === 'saved' ? <span className="system-prompt-status">已保存</span> : null}
              {extractStatus === 'error' ? <span className="field-error">保存失败</span> : null}
            </div>
          </div>
        ) : null}
      </section>

      <section className="settings-section" role="listitem">
        <button
          type="button"
          className="collapse-header"
          onClick={() => setSystemPromptSectionExpanded((current) => !current)}
          aria-expanded={systemPromptSectionExpanded}
        >
          <span className="section-title">
            <span className="section-icon" aria-hidden="true">📝</span>
            <h2 className="ui-title">系统提示词</h2>
            <p>用于引导模型的全局指令，仅对当前用户生效。</p>
          </span>
          <span className="collapse-indicator" aria-hidden="true">›</span>
        </button>
        {systemPromptSectionExpanded ? (
          <div className="accordion-content">
            <textarea
              className="system-prompt"
              placeholder="例如：你是一个耐心的助手，请用简洁的方式回答。"
              value={draftSystemPrompt}
              onChange={(event) => handleSystemPromptChange(event.target.value)}
            />
            <div className="system-prompt-actions">
              <button
                type="button"
                className="primary"
                disabled={!hasUnsavedSystemPrompt}
                onClick={() => void handleSaveSystemPrompt()}
              >
                保存
              </button>
              {systemPromptStatus === 'saved' ? (
                <span className="system-prompt-status">已保存</span>
              ) : null}
            </div>
          </div>
        ) : null}
      </section>

      <section className="settings-section" role="listitem">
        <button
          type="button"
          className="collapse-header"
          onClick={() => setSnackSectionExpanded((current) => !current)}
          aria-expanded={snackSectionExpanded}
        >
          <span className="section-title">
            <span className="section-icon" aria-hidden="true">🐱</span>
            <h2 className="ui-title">我的主页</h2>
            <p>仅用于我的主页；基础系统提示词保持不变。</p>
          </span>
          <span className="collapse-indicator" aria-hidden="true">›</span>
        </button>
        {snackSectionExpanded ? (
          <div className="accordion-content">
            <textarea
              className="system-prompt"
              value={draftSnackSystemPrompt}
              onChange={(event) => handleSnackOverlayChange(event.target.value)}
            />
            <div className="system-prompt-actions">
              <button
                type="button"
                className="primary"
                disabled={!hasUnsavedSnackOverlay}
                onClick={() => void handleSaveSnackOverlay()}
              >
                保存
              </button>
              <button type="button" className="ghost" onClick={handleResetSnackOverlay}>
                恢复默认
              </button>
              {snackOverlayStatus === 'saved' ? (
                <span className="system-prompt-status">已保存</span>
              ) : null}
            </div>
          </div>
        ) : null}
      </section>

      <section className="settings-section" role="listitem">
        <button
          type="button"
          className="collapse-header"
          onClick={() => setSyzygySectionExpanded((current) => !current)}
          aria-expanded={syzygySectionExpanded}
        >
          <span className="section-title">
            <span className="section-icon" aria-hidden="true">🐺</span>
            <h2 className="ui-title">TA的主页</h2>
            <p>控制发帖与回复时的提示词行为。</p>
          </span>
          <span className="collapse-indicator" aria-hidden="true">›</span>
        </button>
        {syzygySectionExpanded ? (
          <div className="accordion-content">
            <div className="section-title">
              <h2 className="ui-title">发帖风格（TA Post Prompt）</h2>
              <p>控制发帖按钮的文风与输出约束。</p>
            </div>
            <textarea
              className="system-prompt"
              value={draftSyzygyPostPrompt}
              onChange={(event) => handleSyzygyPostPromptChange(event.target.value)}
            />
            <div className="system-prompt-actions">
              <button
                type="button"
                className="primary"
                disabled={!hasUnsavedSyzygyPostPrompt}
                onClick={() => void handleSaveSyzygyPostPrompt()}
              >
                保存
              </button>
              <button type="button" className="ghost" onClick={handleResetSyzygyPostPrompt}>
                恢复默认
              </button>
              {syzygyPostStatus === 'saved' ? <span className="system-prompt-status">已保存</span> : null}
            </div>

            <div className="section-title nested-prompt-title">
              <h2 className="ui-title">回复风格（TA Reply Prompt）</h2>
              <p>控制AI回复的语气与长度。</p>
            </div>
            <textarea
              className="system-prompt"
              value={draftSyzygyReplyPrompt}
              onChange={(event) => handleSyzygyReplyPromptChange(event.target.value)}
            />
            <div className="system-prompt-actions">
              <button
                type="button"
                className="primary"
                disabled={!hasUnsavedSyzygyReplyPrompt}
                onClick={() => void handleSaveSyzygyReplyPrompt()}
              >
                保存
              </button>
              <button type="button" className="ghost" onClick={handleResetSyzygyReplyPrompt}>
                恢复默认
              </button>
              {syzygyReplyStatus === 'saved' ? <span className="system-prompt-status">已保存</span> : null}
            </div>
          </div>
        ) : null}
      </section>

        </div>
      </div>

      <ConfirmDialog
        open={pendingDisable !== null}
        title="停用这个模型？"
        description="停用后模型会从猫咪模型库移除，并不会删除云端数据。"
        confirmLabel="停用"
        onCancel={() => setPendingDisable(null)}
        onConfirm={handleDisableModel}
      />

      <ConfirmDialog
        open={showUnsavedPromptDialog}
        title="有未保存的系统提示词"
        description="离开当前页面前是否保存修改？"
        confirmLabel="保存并离开"
        cancelLabel="取消"
        neutralLabel="不保存离开"
        onCancel={handleStayOnPage}
        onNeutral={handleLeaveWithoutSave}
        onConfirm={handleSaveAndLeave}
      />

    </div>
  )
}

export default SettingsPage
