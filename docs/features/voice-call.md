# 📞 语音通话（callhome）

> 灵感与协议来自 [Cheiineeey/callhome](https://github.com/Cheiineeey/callhome)：伴侣可以主动打电话、温柔地挂断、没接到时留语音留言。适配到 Nimbus 的无常驻服务端架构后是**轮次制**通话（按住说话 → 转写 → 回复自动 TTS 播报），不是全双工流式。

| 模块 | 文件 |
|---|---|
| 配置 + 标记协议 + 铃声 + 系统提示段 + 服务端同步 | `src/storage/callConfig.ts` |
| 全屏通话层（响铃/通话/免提 VAD/停留窗口） | `src/components/CallOverlay.tsx/css` |
| 共享 TTS 合成客户端（含缓存） | `src/storage/ttsClient.ts`（VoiceBubble 也改用它） |
| 集成（拨号检测/邀请轮询/事件条/header 📞） | `src/pages/ChatPage.tsx` |
| `[通话中]` 前缀 + silent 落库 | `src/App.tsx` → `queueUserMessage` |
| 服务端表（call_state / call_invites） | `supabase/migrations/20260715120000_add_call_state_and_invites.sql` |
| 升级拨号（cron） | `supabase/functions/proactive_dispatch/index.ts` 末段 |
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
5. **实时字幕流**（callhome ui-concept 式）：通话页中段渲染本次通话的消息——你的转写（右侧气泡 + 语气小标签）、TA 的回复（左侧气泡，**流式时文字实时长出来**）、系统小字（"接通了 · 直接说话就行"）。顶部渐隐 mask、新内容贴底滚动。字幕只是通话的影子，完整记录仍在聊天页
6. **语调三件套**（librosa 音学特征的 JS 简化版，PTT 和免提都生效，PTT 录音时挂独立 analyser 采样）：
   - **轻声** = 有声帧（norm≥10）平均 RMS < 22 → 语气标签带「轻声」+ TA 播报音量 0.5× + 字幕插「轻声模式」系统小字
   - **停顿多** = 有声时长占比 < 45%（总时长 ≥3s 才评；免提尾部 1.2s 判停静默不计入）
   - **语速慢** = 转写字数 ÷ 有声秒数 < 2.8（有声 ≥2s 才评；字数按 CJK+字母数字计）
   标签拼进语气标注（如「难过·轻声·停顿多」），系统提示里教了 TA 怎么读这些线索（"嘴上说没事但又轻又停顿多，你该听得出来"）。没做的只剩音高检测（JS 自相关又贵又容易翻车）
7. **波形线**：头像下的装饰正弦线（svg 宽 200% 平移循环，无缝），说话/收音时提速提亮、安静时慢而淡

## 🎙 免提（VAD 自动收音）

通话页右下 🎙/✋ 切换（偏好存 localStorage）。免提时常驻一条 mic 流（`echoCancellation` + `noiseSuppression` 抑制外放回声），每 100ms 采一次 RMS（与聊天页波形同一标定 rms×2.2 → 0-100）：

- **空闲 → 开录**：音量连续 2 拍（200ms）≥ 阈值 16；TA 播报中用更高的 barge-in 阈值 30（残余回声不至于误打断）
- **录音中 → 停录发送**：< 10 持续 1.2s，或录满 60s；< 500ms 视为误触发丢弃
- 触发即打断播报 + 取消停留窗口（开口 = 留住）
- 无 mic 权限 / 无 WebAudio 时自动退回按住说话

## ☎️ 服务端邀请 + 升级拨号（沉默 ≥5h 自动打）

**表**：`call_state`（每用户一行：enabled/dnd/时区偏移/last_escalation_at，客户端在开关变化和进聊天页时 upsert）+ `call_invites`（邀请状态机 `pending → ringing → accepted/declined/missed`，RLS `auth.uid()=user_id`，INSERT 只有服务端做）。

**服务端**（`proactive_dispatch`，pg_cron 每分钟）：enabled 且非 dnd 的用户，若「最近一条用户消息 5h~7天 之前 + 本地时间 12-23 点（按 tz_offset_minutes 折算，getUTC* 读）+ 今天没升级过（本地日历日）+ 没有存活邀请」→ 写一条 pending 邀请（90s 过期，理由从三句模板随机），并记 last_escalation_at。纯 DB 写入，不调模型。

**客户端**（ChatPage 8s 轮询，与 callhome 同参数）：
- pending 未过期 → 原子抢占成 ringing（`UPDATE … WHERE status='pending'`，防多开互踩）→ 全屏响铃
- pending/ringing 已过期（App 关着没接到）→ 认领成 missed → 发未接事件 → AI 留语音留言
- 接听/拒接/响铃超时 → 邀请行写 accepted/declined/missed

### 预约拨号的来电通知（schedule_call，App 在后台/关闭时）

`schedule_call` 到点时,除了 App 内轮询响铃,还弹一条**来电通知**(`createScheduledCallInvite` 里 `LocalNotifications.schedule` 排在 `fire_at`):
- 专用高优先级渠道 `incoming_call`(importance 5 → heads-up 弹出 + 响铃),`ongoing:true` + `autoCancel:false` → **常驻、划不走**,像真来电
- 通知上带 **「接听 / 挂断」按钮**(`registerActionTypes` 的 `INCOMING_CALL`,在 `main.tsx` 注册),`extra.inviteId` 带上邀请 id
- 按钮点击 → `App.tsx` 的 `localNotificationActionPerformed` → `handleCallNotificationAction`:撤通知 + 接听打 `nimbus_call_autoanswer_v1` 本地标记 / 挂断认领邀请 `declined`
- 「接听」进 App 后:ChatPage 轮询捞到这条邀请、`consumeAutoAnswer()` 命中 → 直接认领 `accepted` 进**接通态**(跳过响铃页),不用再点一次
- **无原生插件**:纯 Capacitor LocalNotifications(动作按钮 + ongoing + 高优先级渠道)。不是锁屏整屏 intent(那要 FCM/原生),但满足"弹窗常驻 + 通知上直接接听/挂断"。需真机验证(通知行为在这个环境无法跑)

**App 关着时收不到实时来电**：没有可用的推送通道（线上的 `send_proactive_push`/FCM 是废弃实验，`fcm_tokens` 表已不存在），所以关着 App 时邀请会过期，下次打开转成「未接来电 + 语音留言」——这本身就是 callhome 设计里有意义的失败路径。

## 关键实现点

- **对 `sendMessage` 零侵入**：通话是聊天之上的观察层。`queueUserMessage` 只加了 `callMode`（`[通话中]` 前缀）和 `silent`（只落库不 armBatchTimer）两个选项。
- **系统提示段**（`buildCallSystemSection`）静态、随配置稳定 → 缓存友好；接在 `buildVoiceSystemSection` 之后。仅在「通话开启 + TTS 就绪」时注入。ElevenLabs 供应商时沿用 [voice] 的英文要求。
- **防重复响铃**：`[call:]` 检测带 3 分钟 freshness + localStorage 已处理清单（`nimbus_call_handled_v1`，保留最近 80 条），重载/回看历史不会把旧邀请再响一遍。
- **回调经 ref 传递**：`onSendMessage` 每渲染都是新箭头（闭包含会话 id），ChatPage 用 `sendMessageRef`、CallOverlay 用 `onMissedRef`/`onEndRef`，既不重置响铃定时器又不会发进旧会话。
- **勿扰拦截**：拨号标记在 DND 开启时静默吞掉（标记仍从正文剥离、留小注）。
- **TTS 合成缓存**：`ttsClient.ts` 按文本缓存 object URL，通话播报和语音条共享，重播不再扣费。

## 与 callhome 原版的差异 / 未做

- 轮次制而非流式全双工（无常驻 Python 服务端；STT 走 SiliconFlow SenseVoice 而非自托管 FunASR）
- 音学特征只做了 JS 简化版（轻声/停顿多/语速慢），音高起伏没做
- 通话总结（挂断后 LLM 生成一行摘要）**决定不做**：对话原文都在聊天记录里，总结只是翻记录好看，不值一次模型调用
- App 关着时的实时来电推送没做（无 FCM 等可用推送通道，见上）

## 踩坑备忘

- 通话回复整条会被读出来：系统提示里明确要求通话中**不要用** markdown/列表/[NEXT]/[voice]，`sanitizeForSpeech` 只是兜底。
- `Audio.onpause` 也会 resolve 播放 Promise（barge-in 靠它），所以打断后必须查 `interruptRef` 再决定要不要继续播下一块。
- 录音 <500ms 视为手滑丢弃（聊天页阈值是 800ms，通话里说「嗯」很短，放宽了）。
