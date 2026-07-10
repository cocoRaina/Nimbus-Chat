import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  fetchChannelInfo,
  readCachedChannelInfo,
  writeCachedChannelInfo,
  formatMoney,
  formatFetchedAgo,
  isUnlimitedBalance,
  type ChannelInfo,
  type ChannelKind,
} from '../storage/channelInfo'
import './RelayChannelPanel.css'

export type ChannelTarget = {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  kind?: ChannelKind
}

type CardState = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  info: ChannelInfo | null
  stale: boolean // info came from cache, not a live fetch this session
  error?: string
}

const initialState = (baseUrl: string): CardState => {
  const cached = readCachedChannelInfo(baseUrl)
  return cached
    ? { status: 'ready', info: cached, stale: true }
    : { status: 'idle', info: null, stale: false }
}

const ChannelCard = ({ target, reloadToken }: { target: ChannelTarget; reloadToken: number }) => {
  const [state, setState] = useState<CardState>(() => initialState(target.baseUrl))
  const [expanded, setExpanded] = useState(false)

  const load = useCallback(async () => {
    setState((s) => ({ ...s, status: 'loading', error: undefined }))
    try {
      const info = await fetchChannelInfo({
        baseUrl: target.baseUrl,
        apiKey: target.apiKey,
        kind: target.kind,
      })
      writeCachedChannelInfo(target.baseUrl, info)
      setState({ status: 'ready', info, stale: false })
    } catch (err) {
      setState((s) => ({
        ...s,
        status: 'error',
        error: err instanceof Error ? err.message : '查询失败',
      }))
    }
  }, [target.baseUrl, target.apiKey, target.kind])

  // "刷新全部" bumps reloadToken; skip the initial render (token 0).
  const firstRun = useRef(true)
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false
      return
    }
    void load()
  }, [reloadToken, load])

  const info = state.info
  const balance = info?.balance ?? null
  const online = info?.status === 'online'
  const currency = balance?.currency ?? 'USD'
  const unlimited = isUnlimitedBalance(balance)

  const statusPill = (() => {
    if (state.status === 'loading') return <span className="rc-pill rc-loading">查询中…</span>
    if (!info) return <span className="rc-pill rc-idle">未查询</span>
    if (state.stale) return <span className="rc-pill rc-idle">上次 {formatFetchedAgo(info.fetchedAt)}</span>
    return online ? <span className="rc-pill rc-ok">在线</span> : <span className="rc-pill rc-down">离线</span>
  })()

  return (
    <div className={`rc-card${expanded ? ' rc-open' : ''}`}>
      <div className="rc-head">
        <div className="rc-body">
          <div className="rc-name">{target.name}</div>
          <div className="rc-sub" title={target.baseUrl}>
            {target.baseUrl}
          </div>
        </div>
        {statusPill}
        <button
          type="button"
          className="rc-refresh"
          onClick={() => void load()}
          disabled={state.status === 'loading'}
          aria-label="刷新"
        >
          ↻
        </button>
      </div>

      {balance ? (
        <div className={`rc-balance${state.stale ? ' rc-stale' : ''}`}>
          <div className="rc-cell rc-lead">
            <span className="rc-k">余额</span>
            <span className="rc-v">{unlimited ? '不限额' : formatMoney(balance.remaining, currency)}</span>
          </div>
          <div className="rc-cell">
            <span className="rc-k">累计已用</span>
            <span className="rc-v">{formatMoney(balance.used, currency)}</span>
          </div>
          {!unlimited && balance.granted != null ? (
            <div className="rc-cell">
              <span className="rc-k">总额度</span>
              <span className="rc-v">{formatMoney(balance.granted, currency)}</span>
            </div>
          ) : null}
        </div>
      ) : state.status === 'ready' ? (
        <div className="rc-empty">该中转站未提供余额接口</div>
      ) : null}

      {state.status === 'error' ? <div className="rc-error">{state.error}</div> : null}

      {info && info.models.length > 0 ? (
        <>
          <button
            type="button"
            className="rc-expand"
            onClick={() => setExpanded((e) => !e)}
            aria-expanded={expanded}
          >
            <span>
              {info.models.length} 个模型
              {info.pricing ? ` · 分组 ${info.pricing.appliedGroup} ×${info.pricing.groupRatio}` : ''}
            </span>
            <span className="rc-chev" aria-hidden="true">
              ▾
            </span>
          </button>
          {expanded ? (
            <div className="rc-models">
              {info.models.map((m) => (
                <div className="rc-mrow" key={m.name}>
                  <div className="rc-mname">
                    {m.name}
                    {m.cached ? <span className="rc-flag">缓存</span> : null}
                  </div>
                  <div className="rc-mprice">
                    {m.perRequest != null ? (
                      <span>
                        {formatMoney(m.perRequest, currency)} <span className="rc-unit">/ 次</span>
                      </span>
                    ) : (
                      <>
                        <span>
                          {formatMoney(m.outputPerM, currency)} <span className="rc-unit">/ M</span>
                        </span>
                        <span className="rc-io">
                          入 {formatMoney(m.inputPerM, currency)} · 出 {formatMoney(m.outputPerM, currency)}
                        </span>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  )
}

const RelayChannelPanel = ({ targets }: { targets: ChannelTarget[] }) => {
  const [reloadToken, setReloadToken] = useState(0)

  // Dedupe by base URL so the current custom slot and a saved preset that
  // point at the same relay don't render twice.
  const unique = useMemo(() => {
    const seen = new Set<string>()
    return targets.filter((t) => {
      const key = t.baseUrl.replace(/\/+$/, '')
      if (!t.baseUrl.trim() || !t.apiKey.trim() || seen.has(key)) return false
      seen.add(key)
      return true
    })
  }, [targets])

  if (unique.length === 0) {
    return (
      <span className="settings-hint">
        保存一个带密钥的中转预设后，这里会显示它的余额、花费和可用模型。
      </span>
    )
  }

  return (
    <div className="rc-panel">
      <div className="rc-panel-head">
        <span className="rc-panel-title">中转站面板</span>
        <button type="button" className="rc-refresh-all" onClick={() => setReloadToken((t) => t + 1)}>
          ↻ 刷新全部
        </button>
      </div>
      {unique.map((t) => (
        <ChannelCard key={t.id} target={t} reloadToken={reloadToken} />
      ))}
    </div>
  )
}

export default RelayChannelPanel
