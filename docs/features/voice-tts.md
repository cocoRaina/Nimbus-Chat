# 语音功能（TTS 输出 + 语音消息输入）

---

## A — 语音消息录入（用户发语音）

| 模块 | 文件 |
|---|---|
| 录音 + 上传 | `src/storage/voiceRecorder.ts` |
| 转录 Edge Function | `supabase/functions/transcribe-voice/index.ts` |
| 录音气泡 UI | `src/components/VoiceRecordBubble.tsx/css` |
| 入口（录音按钮） | `src/pages/ChatPage.tsx`（🎤 按钮 + `startRecording`/`stopRecording`） |
| 附件类型扩展 | `src/types.ts` → `MessageAttachment` union |
| Android 权限 | `android/app/src/main/AndroidManifest.xml` → `RECORD_AUDIO` |

### 流程

1. 用户点 **🎤** → `startRecording()` 调 `getUserMedia({ audio: true })` + `MediaRecorder`
2. Composer 文本框换成红色「录音中」指示条（时间计数）
3. 再次点 ⏹ → `stopRecording()` → blob 上传 Supabase Storage `voice-recordings/{userId}/{ts}.webm`
4. 调 `transcribe-voice` Edge Function → SiliconFlow SenseVoiceSmall → 返回 `{ text, emotion }`
5. 转录文字填入 Composer 让用户复查，同时 `pendingVoice` 存下 `{url, durationMs, transcription, emotion}`
6. 用户点发送 → `submitDraft` 把 `type:'voice'` 附件塞进 `allAttachments`，一起发出

### 气泡渲染（VoiceRecordBubble）

- 播放键（▶/⏸）+ 仿波形（22 根柱子，高度由 URL 作种子确定性生成）+ 时长 + 情绪 emoji
- 转录文字作副标题
- 播放调 `new Audio(url)`，无需 Edge Function

### 情绪映射（B — SenseVoice → 贪嗔痴念）

SenseVoiceSmall 返回情绪标签（HAPPY / SAD / ANGRY / NEUTRAL / SURPRISED…）。
目前情绪存在 `meta.attachments[].emotion`，**情绪→心情系统** 的 delta 注入留在
App.tsx `queueUserMessage` 注释里（`voiceEmotion` 参数已透传），
等合并 `main`（有 `moodSystem.ts`）后取消注释即可激活。

---

## B — TTS 语音播放（AI 回复）

AI 可以"说话"：把要发声的内容用 `[voice]…[/voice]` 包起来，前端渲染成微信式**语音条**（点播才合成、可转文字）。

| 模块 | 文件 |
|---|---|
| 播放气泡 | `src/components/VoiceBubble.tsx/css` |
| Edge Function | `supabase/functions/tts/index.ts` |
| 配置 | `src/storage/ttsConfig.ts` |

AI 回复里 `[voice]…[/voice]` 标记 → `splitAssistantSegments()` → `VoiceBubble`（点击合成+播放）。
支持 MiniMax T2A v2 或 ElevenLabs，key 由用户在设置里填，不落服务端。

---

## 配置要点

- `SILICONFLOW_API_KEY`：Supabase secrets 里配，Edge Function 读取。SenseVoiceSmall 当前免费。
- `voice-recordings` bucket：已创建（public，用户路径 RLS）。
- Android `RECORD_AUDIO` + `MODIFY_AUDIO_SETTINGS` 权限：已在 AndroidManifest 声明。

## 踩坑

- SenseVoice 返回 `<|HAPPY|><|zh|>…实际文字` 或 `HAPPY|实际文字`，Edge Function 里统一剥掉标签再返回 `{ text, emotion }`。
- MediaRecorder 在 Android WebView 支持 `audio/webm;codecs=opus`（首选）或 `audio/ogg;codecs=opus`，`getBestMimeType()` 运行时探测。
- 录音气泡的波形是**伪随机静态**（URL 作 seed），不是真实振幅——避免 Web Audio API 解码开销。
