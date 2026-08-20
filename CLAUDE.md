# 给新窗口的速览（CLAUDE.md）

Nimbus Chat = 自托管的私人 AI 陪伴 App。前端 React + Vite，打包成 PWA（GitHub Pages）和 **Android APK**（Capacitor）；后端是**用户自己的 Supabase**（数据库 + 认证 + Edge Functions）。LLM 走 **OpenRouter 或任意中转站**。

## 先看这些（别从零摸代码）

- **文档地图** → [docs/README.md](docs/README.md)
- 功能总览 + 设置/架构/部署 → [README.md](README.md)
- 缓存(很爱踩坑的区) → [docs/caching.md](docs/caching.md)
- 历史改动 + 踩坑库 → [docs/changelog.md](docs/changelog.md)
- 每个大功能的实现 → `docs/features/<功能>.md`

## 工作约定

- **session 开始时先跑**：`git config user.email noreply@anthropic.com && git config user.name Claude`，否则提交显示 Unverified。
- **改完就提交、推 `main`**（本仓库的工作流就是直接上 main）。提交署名用 `Claude <noreply@anthropic.com>`，否则 GitHub 显示 Unverified。
- **原生改动要重打 APK 才生效**：`android/`（Java/Kotlin 插件）、`capacitor.config`、加 native 依赖 —— 这些靠 CI 出新 APK，用户装上才生效。纯前端(TS/CSS)改动也是打进 APK 的，同样要等出包；只有 **Supabase 服务端改动(RLS/迁移/Edge Function)立即生效**。
- 验证：`npx tsc --noEmit` + `npm run build`（无法在这跑 APK / 真机，原生逻辑靠 review）。
- Supabase 是用户自己的项目，主库是名为 **memory** 的那个（用 MCP `list_projects` 确认 id）；DDL 用 `apply_migration` 并在 `supabase/migrations/` 留文件。

## 几个最容易咬人的点

- **Provider 系统**只有两个：`openrouter` 和 `msuicode`(自定义中转槽)。`msuicode` 的**格式必须设成 Anthropic 兼容**，才走原生 `/v1/messages`，**原生缓存 + 思考链才生效**；OpenAI 兼容那条两者都没有。`ProviderId` 联合类型缠在路由/缓存/续命多处，别轻易改成 N-provider（用「中转预设」绕过，见 `apiProvider.ts` `RelayPreset`）。
- **缓存**只在原生路径有效，且要 `cache_control` + 固定 `metadata.user_id`。OR 用 1h TTL + 55min 续命 ping；金瓜瓜类 5m TTL、不 ping。细节全在 docs/caching.md。
- **RLS 是单租户开放策略**（`USING(true)`），但 `memory_entries` 这类带 `user_id` 的表用 `auth.uid()=user_id` —— 加功能涉及 DELETE 等操作时记得**补对应 RLS 策略**，否则 PostgREST 静默返回 0 行(踩过)。
- **别拿 `supabase` 当条件门控塞消息 meta 字段**：`client.ts` 里 `supabase` 是 `export let` 可变 binding，配置解析后才 reassign，某些时刻取到 `null`。写 `x = supabase ? 值 : null` 会让整段字段**偶发消失、不落库**（`awayRecap`/`healthSnapshot` 都踩过，debug 俩小时）。字段的值若本就带静态兜底，直接 `缓存 ?? 兜底串`、别加门控。**调 meta 注入类 bug 别信模型口头"看没看到"，直接查 `messages.meta`（`jsonb_object_keys`）落库真相。** 设置页底部有构建号可确认用户跑的是不是新包。
- **Supabase Edge Function 整个请求硬顶 150 秒**（`504 IDLE_TIMEOUT`）。`autonomous_wake` 这种多轮工具循环，一旦上游（中转特价逆向档早高峰延迟能到 1-2 分钟）慢调用叠起来破 150s，就被平台直接杀、`patchState` 都跑不到。单次上游超时 `REQUEST_TIMEOUT_MS` 只能放到 ~130s 顶天；再想扛更慢的场景，靠**换更快的中转正向档**或切 OR，别指望调超时。**唤醒"只出心情不写随笔" ≠ 模型偷懒**——先看返回里的 `trace`（逐轮工具轨迹，特意留着）确认是不是慢调用被掐/超时，再动 prompt。唤醒成本：特价 ~3.5￥/次，OR ~4 倍。
- 改 README 前先看它现在很短（功能=一句话+链接），**长内容放 `docs/`**，别再往 README 堆。
- **公用教程（可对外分享的通用原理文章）写到 [github.com/cocoRaina/ai-guides](https://github.com/cocoRaina/ai-guides)**，不要放在本仓库（本仓库是 fork，授权不明确）。本仓库 `docs/guides/` 只做镜像留档。
