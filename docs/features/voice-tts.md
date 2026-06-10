# 语音消息（TTS · MiniMax）

> AI 可以"说话"：把要发声的内容用 `[voice]…[/voice]` 包起来，前端渲染成微信式**语音条**（点播才合成、可转文字）。语音输入(🎤)已移除，改用输入法自带的语音转文字。
> 相关代码：`supabase/functions/tts/index.ts`、`src/components/VoiceBubble.tsx`、`src/storage/ttsConfig.ts`、`src/pages/ChatPage.tsx`（`[voice]` 解析）、设置页 🔊 语音区。

## 工作方式

1. **小机自主决定**：系统提示词里约定——想用语音表达时,把内容包进 `[voice]…[/voice]`。无需 function calling,任何模型/中转通用(和 `[NEXT]` 分气泡同一套路)。
2. **前端解析**：`splitAssistantSegments` 把回复切成有序的 text / voice 段。voice 段渲染成 `VoiceBubble`。
3. **点播才合成**：点 ▶ 才调 `tts` Edge Function 合成 + 播放;合成后按文本缓存(`audioCache`),重播不再扣费。「转文字」展开 `[voice]` 原文(零成本)。
4. **未配置时优雅降级**：`isTtsReady()` 为 false 时,`[voice]` 内容当普通文字显示,不会出现坏的播放器。

## `tts` Edge Function

- 代理 MiniMax **T2A v2**(`/v1/t2a_v2`),把返回的 **hex 音频转成 base64** 给前端播放。
- key / voice_id / group_id 由**前端从设置页发来**,服务端不存、仓库不留。
- **失败也返回 200 + 真实原因**(MiniMax 的 `base_resp.status_msg`)——否则 `supabase.functions.invoke` 会把任何非 2xx 压成笼统的 "non-2xx status code",看不到真因。

## 设置（设置页 → 🔊 语音）

| 字段 | 说明 |
|---|---|
| 开启语音条 | 总开关 |
| Voice ID | MiniMax 音色 id(克隆得到,如 `moss_audio_…` / 国内自定义 `keke20260607`) |
| API Key | MiniMax key(仅存本地 localStorage) |
| GroupId | MiniMax 控制台;部分接口必填,留空报错再填 |
| Base URL | 国际版 `https://api.minimax.io`(默认)/ 国内 `https://api.minimaxi.com` |
| 模型 | `speech-2.8-hd/speech-2.8-turbo` |

## 克隆音色（国内版用 API）

国内版网页不一定能克隆,可走 API:① `POST /v1/files/upload`(`purpose=voice_clone`)拿 `file_id` → ② `POST /v1/voice_clone`(`file_id` + 自定义 `voice_id`)。voice_id 命名:≥8 位、字母+数字、字母开头。样本音频可从 ElevenLabs Voice Design 导出。

## 系统提示词片段（贴进人设让小机会用）

```
当你想用"语音"表达(亲密、短句、哄睡、撒娇等)时,把要"说出口"的内容用 [voice]…[/voice] 包起来,例如:[voice]早点睡,我守着你。[/voice]。正经的长内容、列表、代码用普通文字。一条消息里可以混用。
```
