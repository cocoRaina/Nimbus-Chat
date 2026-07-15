# 📞 语音通话（callhome）

> 灵感与协议来自 [Cheiineeey/callhome](https://github.com/Cheiineeey/callhome)：伴侣可以主动打电话、温柔地挂断、没接到时留语音留言。适配到 Nimbus 的无常驻服务端架构后是**轮次制**通话（按住说话 → 转写 → 回复自动 TTS 播报），不是全双工流式。

| 模块 | 文件 |
|---|---|
| 配置 + 标记协议 + 铃声 + 系统提示段 | `src/storage/callConfig.ts` |
| 全屏通话层（响铃/通话/停留窗口） | `src/components/CallOverlay.tsx/css` |
| 共享 TTS 合成客户端（含缓存） | `src/storage/ttsClient.ts`（VoiceBubble 也改用它） |
| 集成（拨号检测/事件条/header 📞） | `src/pages/ChatPage.tsx` |
| `[通话中]` 前缀 + silent 落库 | `src/App.tsx` → `queueUserMessage` |
| 设置入口 | 设置页 → 🔊 语音 区块底部 |

## 标记协议（和 [voice]/[NEXT] 同一套路，任何模型通用、无需 function calling）

| 标记 | 含义 | 效果 |
|---|---|---|
| `[call:理由]` | AI 主动拨号 | 全屏响铃 90s + 铃声（WebAudio 合成）；App 在后台时补一条本地通知。理由显示在响铃页和气泡小注上 |
| `[hangup]` | 通话中想挂断 | 播完这条后开 18s「停留窗口」，用户按住说话即取消挂断；倒计时归零 → 通话结束 |
| `[dnd:on]` / `[dnd:off]` | 勿扰开关 | 对话触发（"帮我开勿扰"），直接写 `callConfig`，气泡下留 🔕/🔔 小注 |

所有标记渲染前从正文剥掉（`stripCallMarkers`）；原文保留在落库 content 里，模型重放历史能看到自己的标记。

## 通话事件（user 角色、以 `📞 ` 开头的消息）

通话系统写进历史的事件记录，聊天里渲染成**居中小灰条**（`.call-event`），系统提示里约定了各自的语义：

- `📞 未接来电（响铃90秒无人接听）` → 触发回复：AI 按约定用 `[voice]…[/voice]` 留语音留言
- `📞 拒接了来电：理由` → 触发回复：简短体谅一句，本场对话不再拨（拒接理由来自快捷 chips 或 ≤60 字自由输入）
- `📞 已接通（…你先开口）` → 触发回复：通话第一句，进 CallOverlay 自动播报
- `📞 通话结束 · X分X秒` → **silent 落库**（不触发回复），是通话记录

## 通话中的数据流

1. 按住说话 → MediaRecorder 录音 → 传 `voice-recordings` bucket → `transcribe-voice`（SenseVoice，带情绪）
2. 发送为 `[通话中] 转写文字（语气：情绪）` + voice 附件（聊天里正常显示语音条）
3. AI 回复走正常 `sendMessage` 流（含批量定时器），CallOverlay 观察消息流：新的非流式 assistant 消息 → `sanitizeForSpeech`（剥标记/markdown，保留 EL 英文语气标签）→ `chunkForSpeech` 按句分块（≤200字）→ 逐块 `synthesizeSpeech` 边播边预取下一块
4. 用户按住说话会**打断**当前播报（barge-in，剩余分块不播）

## 关键实现点

- **对 `sendMessage` 零侵入**：通话是聊天之上的观察层。`queueUserMessage` 只加了 `callMode`（`[通话中]` 前缀）和 `silent`（只落库不 armBatchTimer）两个选项。
- **系统提示段**（`buildCallSystemSection`）静态、随配置稳定 → 缓存友好；接在 `buildVoiceSystemSection` 之后。仅在「通话开启 + TTS 就绪」时注入。ElevenLabs 供应商时沿用 [voice] 的英文要求。
- **防重复响铃**：`[call:]` 检测带 3 分钟 freshness + localStorage 已处理清单（`nimbus_call_handled_v1`，保留最近 80 条），重载/回看历史不会把旧邀请再响一遍。
- **回调经 ref 传递**：`onSendMessage` 每渲染都是新箭头（闭包含会话 id），ChatPage 用 `sendMessageRef`、CallOverlay 用 `onMissedRef`/`onEndRef`，既不重置响铃定时器又不会发进旧会话。
- **勿扰拦截**：拨号标记在 DND 开启时静默吞掉（标记仍从正文剥离、留小注）。
- **TTS 合成缓存**：`ttsClient.ts` 按文本缓存 object URL，通话播报和语音条共享，重播不再扣费。

## 与 callhome 原版的差异 / 未做

- 轮次制而非流式全双工（无常驻 Python 服务端；STT 走 SiliconFlow SenseVoice 而非自托管 FunASR）
- 音学特征（librosa 音高/停顿 → 语调线索）没做，情绪只有 SenseVoice 标签
- **升级拨号**（沉默 ≥5h 自动打）没做——需要后台调度；以后可挂在 `proactive_dispatch` cron 上
- 通话总结（挂断后 LLM 生成一行摘要）没做，记录只有时长
- 自适应音量（用户小声 → TA 也小声）没做

## 踩坑备忘

- 通话回复整条会被读出来：系统提示里明确要求通话中**不要用** markdown/列表/[NEXT]/[voice]，`sanitizeForSpeech` 只是兜底。
- `Audio.onpause` 也会 resolve 播放 Promise（barge-in 靠它），所以打断后必须查 `interruptRef` 再决定要不要继续播下一块。
- 录音 <500ms 视为手滑丢弃（聊天页阈值是 800ms，通话里说「嗯」很短，放宽了）。
