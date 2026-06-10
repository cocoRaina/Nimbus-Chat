# 聊天界面交互（LINE 风格）

- **Header**：左 `←` 返回首页、Claude 的圆头像（同步 `/syzygy` 朋友圈头像）、可改名称（默认"哥哥"，✏️ 修改名称写到 localStorage `nimbus_assistant_name`，主动消息通知 title 也跟着用新名字）；右 `⚙️` + `≡`（会话抽屉）
- **`⚙️` 齿轮菜单**：🧠 思考链开关 / 🤖 **模型选择**（per-session override，选默认值=清除 override） / 📦 手动压缩对话 / ✏️ 修改名称。模型选择从输入栏挪到这里，输入栏更清爽
- **正在输入指示器**：流式期间在 header 名称下方副标题显示「正在输入…」+ 三跳动点，不再在消息流尾巴留空气泡
- **输入栏**：单行 `[+] [输入框 pill] [➤ 发送 / ■ 停止]`，底部是白色 footer 面板。`+` 点开浮出小菜单 `📷 拍照 / 🖼 从相册`（分别走 `<input capture="environment">` 直接相机和 `<input multiple>` 相册）。流式时变红停止。（内置 🎤 语音输入已移除——`@capacitor-community/speech-recognition` 在 Android 11+ 因缺 RecognitionService `<queries>` 静默失效，且和输入法自带语音转文字重复，改用输入法的）
- **复制**：长按菜单「复制」走原生 `@capacitor/clipboard`（WebView 的 `navigator.clipboard` 会静默失效），带 navigator 兜底
- **📡 离线条**：`@capacitor/network` 监听网络，断网时在输入栏上方显示黄色「📡 已离线」横条（发送照常排队，网络恢复自动重试）
- **📳 震动反馈**：`@capacitor/haptics` 在长按菜单弹出 / 发送按钮 / 麦克风停止 时触发轻震，体感反馈用
- **气泡分组**：同人 1 分钟内连发紧贴（3px），换人或间隔大拉开（12px）
- **居中时间分隔**：间隔 >5 分钟才显示
- **一条消息 = 一个气泡**：用 `[NEXT]` 显式拆成短句串
- **懒加载**：进入只渲染最近 30 条，"加载更早" 按钮分页
- **工具调用卡片**：每条助手消息上方显示本轮调了哪些工具，可折叠查看详情
- **入场动画**：新消息从下方滑入 + 淡入（0.25s）
- **长按菜单**：复制 / 引用 / 分享（`@capacitor/share` 调系统分享面板） / 重新生成 / 编辑 / 删除。菜单**自动翻转**：如果气泡靠近屏幕底部、菜单展开会被输入框压住，`useLayoutEffect` 量完菜单高度后改成出现在气泡**上方**；水平方向也会贴边裁剪。触摸屏下气泡 `user-select: none` + `-webkit-touch-callout: none`，长按不会触发系统蓝色选字（桌面鼠标仍可选，用 `@media (hover:none) and (pointer:coarse)` 隔离）
- **连发（批量回复）**：composer 发送改走 `queueUserMessage`——只落用户消息 + 起 2.5 秒 debounce 定时器（`App.tsx` `BATCH_REPLY_MS`，`armBatchTimer`），期间再发就重置；定时器到了用 `sendMessage(skipUser)` 一次性生成回复，让 AI 看这一批。连发期间没流式，所以不被停止键挡。
  - **打字也推后定时器（防抢答）**：光靠"两次发送之间重置"不够——人打下一条字常常超过窗口，AI 就抢着回复、随后流式锁住输入框，导致连发不了几条。所以输入框 `onChange` 会调 `onComposerActivity`（→ `App.tsx` `notifyComposerActivity`），**只在定时器已经在跑时**重置它（平时打字不受影响），把窗口放宽到 2.5 秒，只有真正停顿才自动回复。
  - **表情包也走这条**：点贴纸 = `onSendMessage('[sticker:名字]')` = `queueUserMessage`，所以连发表情包、文字+表情混发都会批到一起。
- **表情包（`[sticker:名字]`）**：你和 AI 共用一套贴纸（`storage/stickers.ts`，压缩成小 PNG 存 localStorage）。`+ → 🧷 表情` 面板导入/发送/删除；发送即发 `[sticker:名字]` 文本，前端解析成图片（用户和 AI 都解析）。可用贴纸列表注入进聊天 system prompt（`buildStickerSystemSection`），AI 据此自己发。
