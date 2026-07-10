# 中转站面板（余额 / 花费 / 模型）

在 **设置 → 自定义中转** 的「中转预设」下面，显示每个中转站的**余额、累计花费、在线状态和可用模型价格**。灵感来自 [blueberriely/newapi-channel-panel](https://github.com/blueberriely/newapi-channel-panel)，但没有引入它的 Python 服务，而是把「拉取」这一步搬进一个 Supabase Edge Function（绕 CORS，服务端即时生效），前端只做只读展示。

## 为什么不是新 provider

这是纯展示增强，**不新增 `ProviderId`、不碰路由/缓存/续命**。数据源就是每个 `RelayPreset` 里已经存着的 `baseUrl + apiKey`，外加当前未保存的自定义槽。见 CLAUDE.md 里对 N-provider 的告警。

## 数据从哪来

Edge Function `relay-channel-info` 拿到 `{ baseUrl, apiKey }` 后按站点类型代拉：

| 类型 | 余额 | 模型 / 价格 |
| --- | --- | --- |
| NewAPI / One-API 中转 | `GET /dashboard/billing/subscription`（`hard_limit_usd` = 总额度）+ `GET /dashboard/billing/usage`（`total_usage`，美分 = 累计已用）。余额 = 总额度 − 已用。**用的是 sk- 推理密钥**，走 OpenAI 兼容计费口，不需要管理员 token。 | `GET /api/pricing` → 按 `model_ratio × 2 × group_ratio` 算每 1M token 价（One-API 约定：1 ratio = \$2/1M）；`quota_type=1` 的按次计费用 `model_price × group_ratio`。 |
| OpenRouter | `GET /api/v1/credits`（`total_credits − total_usage`），回退 `GET /api/v1/key`。 | 不走本面板（非 NewAPI 型）。 |

全部**尽力而为**：某个接口不存在就该项返回 `null`，前端显示「未提供」而不是报错。

## 关键点 / 坑

- **货币是 USD**：计费 dashboard 的 `hard_limit_usd` 和 pricing 的 ratio 都是美元口径，所以面板统一显示 `$`。个别魔改中转如果按 ¥ 展示，这里的数值仍是美元口径的 quota，注意别混。
- **鉴权两层**：Function 用调用者自己的 Supabase session（`/auth/v1/user`）校验，防止被当成开放代理；中转密钥只在 body 里透传给上游，不落库。
- **缓存**：最后一次成功结果按 base URL 存在 `localStorage`（`nimbus_channel_info_v1:`），打开设置时先显示缓存并标「上次 x 前」，点「刷新」才实时拉。离线站点因此还能看到上次余额。
- **改动生效**：Edge Function 已部署到 memory 项目，**立即生效**；前端 UI 是打进 APK/PWA 的，要等出包。

## 相关文件

- `supabase/functions/relay-channel-info/index.ts` — 代拉逻辑
- `src/storage/channelInfo.ts` — 前端 client + 类型 + 缓存 + 金额格式化
- `src/components/RelayChannelPanel.tsx` / `.css` — 面板 UI
- `src/pages/SettingsPage.tsx` — 组装 targets（预设 + 当前槽）并渲染
