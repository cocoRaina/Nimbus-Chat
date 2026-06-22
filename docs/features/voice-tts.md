# 语音消息（TTS · MiniMax / ElevenLabs）

> AI 可以"说话"：把要发声的内容用 `[voice]…[/voice]` 包起来，前端渲染成微信式**语音条**（点播才合成、可转文字）。语音输入(🎤)已移除，改用输入法自带的语音转文字。
> 相关代码：`supabase/functions/tts/index.ts`、`src/components/VoiceBubble.tsx`、`src/storage/ttsConfig.ts`、`src/pages/ChatPage.tsx`（`[voice]` 解析）、设置页 🔊 语音区。

## 工作方式

1. **小机自主决定**：系统提示词里约定——想用语音表达时,把内容包进 `[voice]…[/voice]`。无需 function calling,任何模型/中转通用(和 `[NEXT]` 分气泡同一套路)。
2. **前端解析**：`splitAssistantSegments` 把回复切成有序的 text / voice 段。voice 段渲染成 `VoiceBubble`。
3. **点播才合成**：点 ▶ 才调 `tts` Edge Function 合成 + 播放;合成后按文本缓存(`audioCache`),重播不再扣费。「转文字」展开 `[voice]` 原文(零成本)。
4. **未配置时优雅降级**：`isTtsReady()` 为 false 时,`[voice]` 内容当普通文字显示,不会出现坏的播放器。

## 两家供应商（二选一，配置各自分开保存）

| | MiniMax | ElevenLabs v3 |
|---|---|---|
| 强项 | 中文最稳、按量便宜 | 最拟真、会笑会叹气、支持语气标签 |
| 模型 | `speech-2.8-turbo` / `speech-2.8-hd` | `eleven_v3`（推荐）/ `eleven_multilingual_v2` / `eleven_turbo_v2_5` |
| 音频返回 | hex 字符串 → base64 | mp3 字节 → base64 |
| 特别参数 | GroupId、Base URL | 情绪稳定度（0 Creative / 0.5 Natural / 1 Robust） |

## `tts` Edge Function

- 按请求里的 `provider` 字段分流：`minimax` 走 **T2A v2**(`/v1/t2a_v2`，hex 音频转 base64)，`elevenlabs` 走 **`/v1/text-to-speech/{voice_id}`**（mp3 字节转 base64）。
- key / voice_id 等由**前端从设置页发来**,服务端不存、仓库不留。仍校验 JWT(只对已登录用户开放代理)。
- **失败也返回 200 + 真实原因**——否则 `supabase.functions.invoke` 会把任何非 2xx 压成笼统的 "non-2xx status code",看不到真因。

## 存储（重要：走原生，不走 localStorage）

TTS 配置用 **内存缓存 + Capacitor Preferences（原生 SharedPreferences）** 持久化，localStorage 仅作可有可无的镜像、写失败被吞掉。原因：Capacitor 安卓 WebView 的 localStorage ①后台被杀时"新写入"可能没刷盘就丢、②容量满了(QuotaExceededError)会让 `setItem` 直接抛错。早先 TTS 只写 localStorage，又把它放在原生写入之前，结果 quota 报错把整个保存中断——key 怎么都存不住。现在写入顺序与容错都修了，和 `supabase/authStorage.ts` 同思路。`hydrateTtsConfig()` 在 App 启动与设置页挂载时把原生存储灌回内存缓存。

## 设置（设置页 → 🔊 语音）

- **开启语音条**：总开关。
- **供应商**：MiniMax / ElevenLabs。
- MiniMax：Voice ID(克隆得到,如 `moss_audio_…`)、API Key、GroupId(部分接口必填)、Base URL(国际 `https://api.minimax.io` / 国内 `https://api.minimaxi.com`)、模型。
- ElevenLabs：Voice ID(从语音库复制,如 `21m00Tcm…`)、API Key(`sk_…`)、模型、情绪稳定度。
- 改动**即时自动保存**，也可点「保存」做一次等待落盘的显式提交（带存储自检：回读原生存储里 Voice ID / API Key 的位数，0 位=写入失败）。

## ElevenLabs v3 语气标签（audio tags）

v3 能识别**写在文本里的方括号标签**，按标签调整语气、加入非语言声音。**前提**：模型选 `eleven_v3`、情绪稳定度选 **Creative(0) 或 Natural(0.5)**（Robust 几乎不触发），且音色本身要"演得动"。效果随音色而变，建议多试。

- **笑/喘**：`[laughs]` `[laughs harder]` `[starts laughing]` `[giggles]` `[chuckles]` `[wheezing]` `[snorts]`
- **情绪**：`[sighs]` `[exhales]` `[excited]` `[happy]` `[sad]` `[crying]` `[nervously]` `[mischievously]` `[sarcastic]` `[curious]`
- **非语言声音**：`[gasps]` `[clears throat]` `[coughs]` `[sniffs]` `[gulps]` `[swallows]`
- **语气/节奏**：`[whispers]` `[shouts]` `[stammers]` `[hesitates]` `[pauses]`
- **大写 + 标点也算"语气"**：全大写=强调/喊，`…` `—` 制造停顿，`!?` 影响语调。

> 用法示例：`[voice][whispers]别怕…我在呢。[laughs] 你这小笨蛋。[/voice]`
> 注意：标签是**英文**的，但被"读"的正文可以是中文；标签本身不会被念出来，只影响表演。

## 克隆音色

- **MiniMax 国内版**走 API：① `POST /v1/files/upload`(`purpose=voice_clone`)拿 `file_id` → ② `POST /v1/voice_clone`(`file_id` + 自定义 `voice_id`)。voice_id 命名:≥8 位、字母+数字、字母开头。
- **ElevenLabs**：网页 Voice Design 生成/克隆音色后，复制 Voice ID 填进设置即可。

## 系统提示词片段（贴进人设让小机会用）

```
当你想用"语音"表达(亲密、短句、哄睡、撒娇等)时,把要"说出口"的内容用 [voice]…[/voice] 包起来,例如:[voice]早点睡,我守着你。[/voice]。正经的长内容、列表、代码用普通文字。一条消息里可以混用。
（若用 ElevenLabs v3 音色,可在 [voice] 里写英文语气标签来表演:[laughs] 笑、[sighs] 叹气、[whispers] 耳语 等,自然地用,别每句都加。）
```
