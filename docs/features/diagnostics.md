# 渠道体检 + Token 对账 + 站子健康（实现留档）

> 给下一个 session 的我：这套「防中转骗」的诊断功能怎么实现的、代码在哪、踩过什么坑。
> 用户向导（怎么读结果）见对外版 [docs/guides/relay-check-and-token-audit.md](../guides/relay-check-and-token-audit.md)；本篇是**实现参考**。
> 入口：App → 用量页（`UsagePage.tsx`）→ 顶部四标签「用量统计 / API检测 / 压缩状态 / 记忆状态」。

## 记忆状态 tab（2026-07-02 加）

监控记忆系统的新部件是否健康运行：

1. **会话摘要覆盖（最近 7 天）**：`digest_coverage` RPC 按北京日对比「当天消息数 vs 摘要数」——🟢 已生成 / ⚪ 消息不足 6 条跳过 / 🔴 该有但没生成。**连续 🔴 = session_digest cron 出问题了**，去 Supabase 看 Edge Function 日志。
2. **会话摘要列表（最近 14 条）**：点开看全文，检查摘要质量（换提取模型后来这里看效果）。
3. **每轮自动召回日志（本次启动）**：每次召回的 query / 命中数 / 注入内容预览（`memoryRecall.ts` 的 `getRecallLog()`，内存环形日志 20 条）。🔴 = 该轮召回失败（超时/报错，消息本身照常发出）。重启 App 清空。

---

## 代码地图

| 模块 | 文件 | 干啥 |
|---|---|---|
| 全部 UI + 探针 + 综合判断 | `src/pages/UsagePage.tsx` | `runApiChecks`、`guessChannel`、`healthOverview`、`providerLabel`/`relayName`、逐条明细表 |
| 样式 | `src/pages/UsagePage.css` | `.health-overview*`、`.diag-detail-fold`、`.diag-cost-hint` |
| 用量数据层 | `src/storage/usageStats.ts` | `UsageLogRow`（含 `cacheRead`/`cacheWrite`/`latencyMs`）、`recordUsage`、`fetchUsageLogs` |
| 延迟测量 + 落库 | `src/App.tsx` | `sendMessage` 里 `reqLatencyMs`（iter1 首字延迟）→ `flushUsageRecord` → `recordUsage` |
| 响应头保留（关键修） | `src/api/anthropic.ts` | `buildJsonHeaders`：非流式响应带回上游指纹头 |
| 渠道名自适应 | `src/storage/apiProvider.ts` | `getCustomProviderDisplayName()`（从 base URL 推，如 treegpt） |
| 数据表 | Supabase `usage_logs` | 新列 `latency_ms`；`cached_tokens`=缓存读；缓存写在 `raw_usage.cache_creation_input_tokens` |

---

## API检测：6 张卡（`runApiChecks` + `guessChannel`）

点「运行检测」发 5~6 条小请求（成本提示见 `.diag-cost-hint`）。`runApiChecks` 累积一个 `ChannelSignals`，最后 `guessChannel(sig)` `unshift` 到结果最前。

1. **🔍 渠道猜测**：`guessChannel` 综合。优先级：偷换/降智(fail) → 注入(warn) → 真缓存命中(pass) → 其余(warn)。
   - ⚠️ **注入分支要看实测缓存**：反代 Claude Code 也能透传原生缓存。早期写死「通常无原生缓存」和同轮 `真缓存命中=pass` 自相矛盾，已改成按 `s.realCacheHit` 分叉措辞。
2. **连通性 + 延迟**：最小请求测毫秒；同时 `collectHeaders(r.headers)` 存进 `sig.headers`。
3. **真实缓存命中** ⭐：`CACHE_FILLER`（≥1024 token 固定文本）当 system 块 + `cache_control`，带 `user:'nimbus-diag-probe'`（→ 适配器映射成 `metadata.user_id` 粘同一上游）。**读回最多 2 次**，命中即停；连 2 次都没读到才判「打散」（避免单次粘连抽风误判）。
4. **模型核验**：金丝雀 `canaryText()` 原样复述 + 比对 `model` 字段。
5. **响应头指纹**：从 `sig.headers` 出。正则白名单见 `collectHeaders`/`FINGERPRINT_HEADER_RE`。
6. **身份注入探测**：不发 system，问身份。判定要**强身份词**（claude code/开发环境/代码助手…）+ 没否认（`denies`），避免「我能帮你编程」误报。

### ⚠️ 头一开始读到空 = 我们自己的 bug（已修）
非流式 Claude 走 `collectAnthropicStreamAsJson`，旧代码 `new Response(json,{headers:{Content-Type}})` **把上游头全丢了**。修：`buildJsonHeaders(upstream)` 按 `FINGERPRINT_HEADER_RE` 白名单带回（**跳过 content-length/encoding/type 等 body-framing 头，否则会搞坏新 JSON body**）。修后实测能读到 `server: nginx`。读到多少仍取决于中转漏不漏（tree 在 nginx 边缘清了上游头）。

---

## 用量统计 + 对账

- **顶部「输入 tokens（总）」卡**：value=`prompt`；hint 两行=命中缓存 `cached`（Y%·0.1×）+ **真实新增** `prompt-cached`（全价，真花钱）。
- **缓存读 vs 写**：`cached_tokens` 列=读（0.1×）；写只在 `raw_usage.cache_creation_input_tokens`（无独立列），`mapRow` 用 `numField` 取。`UsageLogRow.cacheRead`/`cacheWrite` 即此。
- **逐条明细表**（`.diag-detail-fold`，`<details>` 默认折叠）：`rows.slice(0,80)`，**精确数字**（`toLocaleString`，不缩 K）：时间/模型/输入/输出/缓存读/缓存写——逐条和站子日志对，对不上=虚报。

口径坑：OpenAI 形态 `prompt_tokens` 常含缓存；Anthropic 原生 `input_tokens` 不含。对账认准 `cache_read`/`cache_creation` 两个具体数。

---

## 站子健康概览（`healthOverview` useMemo + `.health-overview`）

用量页顶部。从**当前 provider**(`getActiveProvider()`)近 50 条算：平均首字延迟 + Claude 缓存命中率 → 🟢/🟡/🔴。
- 阈值：延迟 ≥12s=🔴、≥6s=🟡；Claude 样本≥5 且命中<10%→至少🟡。
- 名字 `provider==='openrouter'?'OpenRouter':(relayName||'中转站')`——换站自动变。

### 延迟从哪来
`App.tsx sendMessage`：iter1 fetch 前 `tFetch0=performance.now()`，`await fetchOpenRouter` 解析后 `if(iteration===1) reqLatencyMs=...`（= 请求发出→响应头回来 ≈ 首字）。经 `recordUsage({latencyMs})` 落 `usage_logs.latency_ms`。**只有装了带此改动的包之后的对话才有延迟数据**；之前的 row 该列为 null，概览显示「延迟暂无」。

---

## 自适应渠道名（贯穿）

`getCustomProviderDisplayName()` = `deriveProviderDisplayName(getMsuicodeBaseUrl())`：取 host、剥 `www./api./gateway.`、取首段（`api.treegpt.cc`→`treegpt`）。UsagePage 的 `providerLabel`、`healthOverview.name`、历史分组都用它，换中转自动跟着变。
> 注意：历史 row 只存 provider id（`openrouter`/`msuicode`），不存当时是哪家中转。所以历史里的 `msuicode` 一律显示**当前**中转名——换过站的话旧记录会被标成新名，可接受。

---

## 踩坑 / 教训

- **TTL 判断别拍脑袋**：曾凭「听说 5min」就停了保活 cron，实际中转认 `ttl:'1h'`、ping 在 ~50min 仍命中 → 误判。**看 usage 命中数据为准**（详见 changelog 06-27 保活那条）。
- **真缓存测试要重试**：单次粘连失败会误报「打散」，故读回 2 次。
- **头白名单别带 body-framing 头**：会搞坏合成 JSON body。
- **草稿式开关的坑**：自动提取开关曾是「拨完要点保存」的草稿，用户拨了没保存→存值仍 true→还在提取。kill-switch 类开关应**一拨立即落库**（参考保活/情绪/自动提取开关现都是即时）。

---

## 诚实边界（写给我自己，别过度承诺）

- 只能给**类别**（官方/逆向/模拟缓存/偷换），给不了**确切牌子**（反重力 vs Kiro）——中转抹了上游来源。
- 精确 TTL 快测给不出（要隔时再测）。
- 探针有偶然性，缓存类结论连试 2~3 次再下。
