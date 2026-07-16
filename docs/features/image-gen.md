# 🎨 画画（AI 生图 · generate_image）

> 小机自己的画笔：聊天里想画就画，画完的图直接落进气泡；**tool_result 里塞的是真图片块，它自己看得见画成了什么样**——你说「猫耳朵歪了」，它是真的看着图在改。参考「克克的窗台」的画画教程，按 Nimbus 的架构（无自建网关，纯前端 + Supabase）重新落地。

| 模块 | 文件 |
|---|---|
| 生图核心（两种接口形状、超时、重试） | `src/api/imageGen.ts` |
| 配置存储（localStorage，key 掩码） | `src/storage/imageGenConfig.ts` |
| 工具定义 | `src/tools/definitions.ts` → `TOOL_GENERATE_IMAGE` |
| 执行分支 | `App.tsx`（`tc.function.name === 'generate_image'`） |
| tool_result 图片块转换 | `src/api/anthropic.ts`（tool 消息数组 content → tool_result blocks）；`src/api/openrouter.ts` `flattenToolImageParts`（OpenAI 路径降级） |
| 重新画一张 | ChatPage 长按菜单 → `App.tsx` `redrawGeneratedImage` + `supabaseSync.updateRemoteMessageMeta` |
| 设置 UI | SettingsPage「🎨 画画（AI 生图）」折叠区 |

## 架构（对比教程原版）

教程假设有自建 Node 网关，生图在服务端跑、SSE 推给前端。Nimbus 没有网关——聊天请求本来就是**前端直连中转**（APK 上 CapacitorHttp 绕 CORS），所以生图也走同一路：

```
模型在工具循环里调 generate_image
        │
        ▼
前端（App.tsx 工具分支）本地执行：
  调生图中转（形状 images 或 chat）→ 拿到图（b64 或 URL 下载）
        │
        ├─→ 压缩成 webp（复用 uploadChatImage 管线）→ 上传 chat-images 桶
        ├─→ caption 直接冻结为 prompt（不花识图钱）→ image_captions
        ├─→ attachment 挂进 assistant 消息 meta（气泡立即显示，带 gen 出生证明）
        └─→ tool_result = [text, image(压缩后 base64)] ★ 模型看见自己画的成品
```

- **和手发的图同一条管线**：落 `chat-images`、有 caption、能被 `save_to_album` / `list_photos` / `tidy_images` 处理。「图默认不保存」在 Nimbus 里 = 没收藏进相册的生成图跟老照片一起被 tidy 清掉。
- **出生证明**不是教程的 PNG iTXt（那要求存 PNG 原图，几 MB/张 撑爆存储；webp 也没有 iTXt），而是三处冗余：attachment 的 `gen: {prompt, size, model}`（驱动重画）+ caption（`TA 自己画的：<prompt>`，历史重放/翻图库都认得）+ 相册备注（若收藏）。
- **两把独立的 key**：生图中转和聊天中转互不影响，生图 key 只在本机 localStorage，UI 回显掩码（`sk-3ES…xxxx`），填新的才覆盖。

## 模型怎么「看见」自己画的图

内部消息表示是 OpenAI 形状，tool 消息的 content 现在允许数组（text + `image_url` parts）：

- **Anthropic 原生路径**（msuicode-anthropic / OR 的 Claude）：`convertOpenAiRequestToAnthropic` 把数组 content 转成 `tool_result.content = [text块, image块(base64)]`——Anthropic 官方支持 tool_result 里带图。
- **OpenAI 兼容路径**：tool role 不允许图片块（多数中转 400），`openrouter.ts` 的 `flattenToolImageParts` 在发送前把图片 part 压平成文字。此路径模型看不见成品（本来这条路缓存/思考链也没有，Nimbus 主路径是 Anthropic 原生）。
- 回看的图用**压缩后的 webp**（~100KB）而不是原始 PNG（几 MB）——有的中转按 base64 长度折 token 计费（1.4 字符/token），原始 PNG 一张能收几十万 token（教程里「180 万 token 别吓到」就是这个）。
- **缓存不受伤**：tool_use/tool_result 只活在当前回合（本仓库历史重放从不回放工具块，靠 toolDigest），图片块不进滚动缓存前缀。工具列表加了 `generate_image` 会让 tools 块变化 → 配置齐全的第一条消息冷写一次缓存，属预期。

## 超时链路（教程里血泪最浓的一节，Nimbus 版）

生图晚高峰 1~3 分钟。Nimbus 没有 nginx 反代（前端直连中转），要防的环节不同：

| 环节 | 处理 |
|---|---|
| 生图 fetch 超时 | `imageGen.ts` 270s AbortController |
| **45s 流停滞看门狗**（`STREAM_STALL_MS`）| ⚠️ 最大的坑：工具执行期间没有流式 chunk，看门狗会把整个回合掐死（钱扣了图没了）。执行分支里 10s 心跳喂 `lastChunkAtRef`，画完恢复 |
| 失败自动补一笔 | 瞬时错误（5xx/429/断连）且失败得快（<120s）重试一次；慢死的不重试（时间预算没了，重试=双倍扣费） |
| 用户点停止 | 外部 signal 链进生图 AbortController，一起掐断 |
| 日志三件套 | console：`[生图] 开画`（模型/尺寸/prompt 头 40 字）/ `画好了`（耗时/大小）/ 失败原因 |

工具描述里写死「动笔前先用文字回她一句」——生图要一两分钟，先说话再开画，等待体验完全不一样。

## 两种接口形状（设置里可切）

- **images**（默认）：`POST /v1/images/generations` `{model,prompt,size,n:1}` → `data[0].b64_json` 或 `data[0].url`。gpt-image 系大多用这个。
- **chat**：`POST /v1/chat/completions` → 兼容三种回法：`message.images[0].image_url.url`（OpenRouter 式）、正文 markdown `![Image](url)`、正文裸 data URL。
- URL 下载在 APK 上走 `nativeStreamFetch`（CapacitorHttp 补丁过的 fetch 对二进制 arrayBuffer 会乱码——和 `fetchImageAsBase64` 同一个坑）；Web 上直接 fetch，图床不给 CORS 就报错（主用户场景是 APK）。

## 重新画一张（只换图、不动话）

长按 AI 消息里带 `gen` 元数据的图 → 「🎨 重新画一张」：

1. 拿 `gen.prompt + gen.size` 原样重跑生图接口
2. 上传新图 → **覆写同一条消息的 attachment**（url/宽高换新，聊天文字、上下文一个字不动）
3. 本地 `applySnapshot` + 远端 `updateRemoteMessageMeta`（messages 表 RLS 是 `for all`，UPDATE 不缺策略）
4. 旧图文件**不删**：可能已被收藏进相册（书签指向原 URL），孤儿图交给 `tidy_images` 自然过期

## 触发与守门

- 工具**只在配置齐全时注入**（`isImageGenConfigured()`：地址+key+模型三样）——没配置时模型不知道自己会画画，不会答应了画不出来。
- 描述给了主动权：她说「画一张…」时用；想哄她开心、想把某个瞬间画下来送她时也可以主动画。
- 尺寸 enum：`1024x1024` / `1536x1024`（横）/ `1024x1536`（竖），没传用设置里的默认。

## 未做 / 边界

- PNG iTXt 嵌 prompt（见上，出生证明改走 attachment.gen + caption 三处冗余）
- 独立画画页（教程的 draw.html）：Nimbus 里用户手动画可以直接在聊天里说「画一张…」；真需要再加
- 图生图 / 参考图（gpt-image 支持 edit 接口，本版只做文生图）
- Web PWA 上 chat 形状返回 URL 且图床无 CORS 时下载失败（APK 不受影响）
