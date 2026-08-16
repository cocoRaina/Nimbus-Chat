// 后台轮询任务（@capacitor/background-runner）。安卓用 WorkManager 每 ~15min 拉起，
// 即使 App 已被杀也会跑（华为需给 App 加电池白名单/自启动，否则仍会被冻）。
// 跑在受限的 QuickJS 运行时里，只有 fetch / CapacitorKV / CapacitorNotifications
// 这几个全局，拿不到 App 的 supabase 客户端/localStorage——配置由 App 通过
// dispatchEvent('saveConfig') 存进 CapacitorKV。
//
// 逻辑：读配置 → 调 proactive_peek（带 peek_secret + 上次时间）→ 有新主动消息就
// 弹本地通知 → 记录最新时间。

addEventListener('saveConfig', (resolve, reject, args) => {
  try {
    if (args && typeof args.cfg === 'string') {
      CapacitorKV.set('nimbus_cfg', args.cfg)
    }
    resolve()
  } catch (e) {
    reject(e)
  }
})

addEventListener('checkProactive', async (resolve, reject) => {
  try {
    let cfg = {}
    try { cfg = JSON.parse(CapacitorKV.get('nimbus_cfg').value || '{}') } catch (e) { cfg = {} }
    if (!cfg.fnUrl || !cfg.secret) { resolve(); return }

    let since = ''
    try { since = CapacitorKV.get('nimbus_last_seen').value || '' } catch (e) { since = '' }

    const resp = await fetch(cfg.fnUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': cfg.anon || '',
        'Authorization': 'Bearer ' + (cfg.anon || ''),
      },
      body: JSON.stringify({ secret: cfg.secret, since: since || undefined }),
    })
    if (!resp.ok) { resolve(); return }

    const data = await resp.json()
    const msgs = (data && data.messages) || []
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i]
      if (!m || !m.text) continue
      CapacitorNotifications.schedule([{
        id: Math.floor(Math.random() * 2000000000),
        title: cfg.name || '沈暮',
        body: m.text,
      }])
    }
    if (msgs.length > 0 && msgs[msgs.length - 1].created_at) {
      CapacitorKV.set('nimbus_last_seen', String(msgs[msgs.length - 1].created_at))
    }
    resolve()
  } catch (e) {
    reject(e)
  }
})
