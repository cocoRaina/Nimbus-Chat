# 🧸 Artifact 小玩具

> Claude App artifact 的聊天气泡版：小机用 ```html 代码块写一个自包含的互动页面（小游戏/贺卡/倒计时/抽签转盘…），聊天气泡里直接渲染成能玩的沙箱 iframe。**零配置、零成本**——写代码的能力模型本来就有，前端只是给它一块能跑代码的画布。

| 模块 | 文件 |
|---|---|
| 渲染卡片（iframe/看代码/全屏） | `src/components/ArtifactFrame.tsx` + `.css` |
| fence 检测 + 流式占位 | `src/components/MarkdownRenderer.tsx`（`pre` 组件覆写） |
| 系统提示段（教小机怎么做玩具） | `src/constants/artifactSection.ts` → `buildArtifactSystemSection` |
| 接线 | `App.tsx` 系统提示拼接处；`ChatPage.tsx` 传 `artifactsLive` |

## 工作方式

没有工具调用、没有 API、没有配置——纯输出约定 + 渲染器：

1. 系统提示常驻一段「小玩具」规则（`buildArtifactSystemSection`，静态字符串，BP1 缓存稳定），教模型：用 ```html 代码块输出**完整自包含 HTML** 就会被渲染成可玩的 iframe，主动做也行（哄人/纪念/陪玩/小工具）。
2. `MarkdownRenderer` 覆写 `pre`：`language-html` 代码块 → `ArtifactFrame`（其他语言的代码块照旧）。
3. `ArtifactFrame`：标题栏（🧸 小玩具 + 「</> 代码」切换 + 「⛶ 全屏」）+ `<iframe sandbox="allow-scripts" srcDoc={code}>`。全屏是 portal 到 body 的第二个 iframe（全屏=重开一局；DOM 里搬 iframe 必然重载，规范如此，不如明着重开）。

## 安全模型（为什么敢直接跑模型写的代码）

`sandbox="allow-scripts"` **不带** `allow-same-origin` → srcdoc 内容跑在不透明源（opaque origin）：

- 拿不到 localStorage / cookies / supabase session——模型代码再怎么写都碰不到 App 数据
- 不能导航宿主页面、不能开弹窗（没给 allow-popups/allow-top-navigation）
- 系统提示要求素材全内联（emoji + CSS 画），断网也能玩；沙箱里发外部请求受 CORS 限制且没有凭据

## 流式防闪烁（关键细节）

流式生成中，未闭合的 ```html fence 会被 markdown 解析成"还在长大的代码块"——如果直接渲染 iframe，每个 chunk 都换一次 `srcDoc` = iframe 疯狂重载闪烁。所以：

- `ChatPage` 传 `artifactsLive={message.meta?.streaming !== true}`
- 流式中 html 块显示脉冲占位「🧸 小玩具制作中…写完就能玩」（也避免代码墙刷屏）
- 消息落定（`meta.streaming` 置 false、消息对象整体替换触发 memo 重渲）→ 真 iframe 上线

## 上下文成本

玩具代码就在消息正文里（100-200 行 ≈ 2-4k token），历史重放随消息走——和 Claude App 一个待遇，会话压缩到点自然摘要掉。系统提示段约 +300 token 常驻（一次冷写）。

## 验证

SSR 冒烟测试（react-dom/server + esbuild，见 session 记录）：html 块 → artifact-card + sandbox iframe ✓；`artifactsLive=false` → 占位无 iframe ✓；js 代码块/普通文本不受影响 ✓。真机交互（点玩具/全屏/长按气泡不冲突）待 APK 实测。

## 未做 / 边界

- 玩具不能持久存档（沙箱无 localStorage）——「重新打开还在」的玩具需要以后把代码存进相册式书签再加
- [NEXT] 别进代码块（提示里叮嘱了）；朋友圈/主页也用同一渲染器，小机发帖带玩具同样能玩（默认 live）
- App 被杀在流式中途的极端情况：那条消息的 `meta.streaming` 可能永远是 true → 占位不转正（罕见、纯外观）
