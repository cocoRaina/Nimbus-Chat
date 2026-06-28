# 语音消息（用户录音 + AI TTS）

---

## A — 语音消息录入（用户发语音）

| 模块 | 文件 |
|---|---|
| 录音 + 上传 | `src/storage/voiceRecorder.ts` |
| 转录 Edge Function | `supabase/functions/transcribe-voice/index.ts` |
| 录音气泡 UI | `src/components/VoiceRecordBubble.tsx/css` |
| 入口（录音按钮） | `src/pages/ChatPage.tsx`（🔊/⌨️ 切换 + `startRecording`/`stopAndSend`） |
| 附件类型扩展 | `src/types.ts` → `MessageAttachment` union |
| Android 权限 | `android/app/src/main/AndroidManifest.xml` → `RECORD_AUDIO` |

### 流程

1. 用户点左侧 **🔊** 切语音模式 → 出现「按住说话」大条
2. 按住 → `startRecording()` 调 `getUserMedia({ audio: true })` + `MediaRecorder`
3. 松手 → `stopAndSend()` → blob 上传 Supabase Storage `voice-recordings/{userId}/{ts}.webm`
4. 调 `transcribe-voice` Edge Function → SiliconFlow SenseVoiceSmall → 返回 `{ text, emotion }`
5. 直接以 `text || '[语音消息]'` 为内容调 `onSendMessage`，`type:'voice'` 附件一起发出
6. 气泡显示播放键 + 伪波形 + 情绪 emoji，点「转文字」按需展开转录文字

### 气泡渲染（VoiceRecordBubble）

- 播放键（▶/⏸）+ 仿波形（22 根柱子，高度由 URL 作种子确定性生成）+ 时长 + 情绪 emoji
- 「转文字」按钮点击后展开转录文字，再次点击收起
- 播放调 `new Audio(url)`，无需 Edge Function

### 情绪映射（B — SenseVoice → 贪嗔痴念）

SenseVoiceSmall 返回情绪标签（HAPPY / SAD / ANGRY / NEUTRAL / SURPRISED…）。
情绪存在 `meta.attachments[].emotion`，`queueUserMessage` 调用 `voiceEmotionToMoodDeltas()` 映射为增量并 `commitMood()`，自动调整小机心绪。

---

## B — TTS 语音播放（AI 回复）

AI 可以"说话"：把要发声的内容用 `[voice]…[/voice]` 包起来，前端渲染成微信式**语音条**（点播才合成、可转文字）。

| 模块 | 文件 |
|---|---|
| 播放气泡 | `src/components/VoiceBubble.tsx/css` |
| Edge Function | `supabase/functions/tts/index.ts` |
| 配置 | `src/storage/ttsConfig.ts` |

### 工作原理

1. **小机自主决定**：系统提示词里约定——想用语音表达时，把内容包进 `[voice]…[/voice]`。无需 function calling，任何模型/中转通用（和 `[NEXT]` 分气泡同一套路）。
2. **前端解析**：`splitAssistantSegments` 把回复切成有序的 text / voice 段。voice 段渲染成 `VoiceBubble`。
3. **点播才合成**：点 ▶ 才调 `tts` Edge Function 合成 + 播放；合成后按文本缓存（`audioCache`），重播不再扣费。「转文字」展开 `[voice]` 原文（零成本）。
4. **未配置时优雅降级**：`isTtsReady()` 为 false 时，`[voice]` 内容当普通文字显示，不会出现坏的播放器。

## 两家供应商（二选一，配置各自分开保存）

| | MiniMax | ElevenLabs v3 |
|---|---|---|
| 强项 | 中文最稳、按量便宜 | 最拟真、会笑会叹气、支持语气标签 |
| 模型 | `speech-2.8-turbo` / `speech-2.8-hd` | `eleven_v3`（推荐）/ `eleven_multilingual_v2` / `eleven_turbo_v2_5` |
| 音频返回 | hex 字符串 → base64 | mp3 字节 → base64 |
| 特别参数 | GroupId、Base URL | 情绪稳定度（0 Creative / 0.5 Natural / 1 Robust） |

## `tts` Edge Function

- 按请求里的 `provider` 字段分流：`minimax` 走 **T2A v2**（`/v1/t2a_v2`，hex 音频转 base64），`elevenlabs` 走 **`/v1/text-to-speech/{voice_id}`**（mp3 字节转 base64）。
- key / voice_id 等由**前端从设置页发来**，服务端不存、仓库不留。仍校验 JWT（只对已登录用户开放代理）。
- **失败也返回 200 + 真实原因**——否则 `supabase.functions.invoke` 会把任何非 2xx 压成笼统的 "non-2xx status code"，看不到真因。

## 存储（重要：走原生，不走 localStorage）

TTS 配置用**内存缓存 + Capacitor Preferences（原生 SharedPreferences）**持久化，localStorage 仅作可有可无的镜像、写失败被吞掉。`hydrateTtsConfig()` 在 App 启动与设置页挂载时把原生存储灌回内存缓存。

## 设置（设置页 → 🔊 语音）

- **开启语音条**：总开关。
- **供应商**：MiniMax / ElevenLabs。
- MiniMax：Voice ID、API Key、GroupId、Base URL（国际 `https://api.minimax.io` / 国内 `https://api.minimaxi.com`）、模型。
- ElevenLabs：Voice ID、API Key（`sk_…`）、模型、情绪稳定度。
- 改动**即时自动保存**，可点「保存」做显式提交（带存储自检）。

## ElevenLabs v3 语气标签（audio tags）

v3 能识别**写在文本里的方括号标签**，按标签调整语气、加入非语言声音。**前提**：模型选 `eleven_v3`、情绪稳定度选 Creative(0) 或 Natural(0.5)。

- **笑/喘**：`[laughs]` `[giggles]` `[chuckles]` `[snorts]`
- **情绪**：`[sighs]` `[exhales]` `[excited]` `[crying]` `[whispers]`
- **非语言**：`[gasps]` `[clears throat]` `[coughs]`

> 用法示例：`[voice][whispers]别怕…我在呢。[laughs] 你这小笨蛋。[/voice]`

---

## 配置要点

- `SILICONFLOW_API_KEY`：Supabase secrets 里配，Edge Function 读取。SenseVoiceSmall 当前免费，复用向量记忆的同一个 key。
- `voice-recordings` bucket：已创建（public，用户路径 RLS）。
- Android `RECORD_AUDIO` + `MODIFY_AUDIO_SETTINGS` 权限：已在 AndroidManifest 声明。

## 踩坑

- SenseVoice 返回 `<|HAPPY|><|zh|>…实际文字` 或 `HAPPY|实际文字`，Edge Function 里统一剥掉标签再返回 `{ text, emotion }`。
- MediaRecorder 在 Android WebView 支持 `audio/webm;codecs=opus`（首选）或 `audio/ogg;codecs=opus`，`getBestMimeType()` 运行时探测。
- 录音气泡的波形是**伪随机静态**（URL 作 seed），不是真实振幅——避免 Web Audio API 解码开销。
