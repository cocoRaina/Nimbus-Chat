// Telegram 式表情回应 —— AI 在回复里带 `[react:😊]` 令牌，就会把这个 emoji
// 贴到用户最近那条消息的气泡上。走 [sticker:]/[NEXT] 同一套令牌约定：
//   - 令牌就存在 assistant 消息的 content 里，重放历史时模型自己看得见
//     「我上一轮只贴了表情没说话」，不需要额外记忆机制；
//   - 落库内容逐字节稳定，不碰消息 meta、不需要新的 DB 列/策略；
//   - 整条回复只有令牌（react-only）时前端不渲染气泡 —— 这就是
//     「AI 自己决定这条要不要开口」：看到了、贴个表情、不说话。
// 渲染归属在 ChatPage 计算：每个带令牌的 assistant 消息，把 emoji 挂到
// 它前面最近的一条 user 消息上（连发批次时即批次的最后一条）。

const REACT_RE = /\[react:([^\]\n]{1,16})\]/gi

// 取回复里的回应 emoji（有多个时取最后一个）。宽松校验：非空、去掉空白后
// 不超过 16 个 code unit（emoji 常由多个码点组成，别按「1 个字符」卡）。
export const extractReaction = (content: string): string | null => {
  if (!content || !content.toLowerCase().includes('[react:')) return null
  REACT_RE.lastIndex = 0
  let last: string | null = null
  let m: RegExpExecArray | null
  while ((m = REACT_RE.exec(content)) !== null) {
    const emoji = m[1].trim()
    if (emoji) last = emoji
  }
  return last
}

// 从展示文本里去掉所有 [react:…] 令牌（落库保留原文，只在渲染时切）。
export const stripReactionTokens = (content: string): string => {
  if (!content || !content.toLowerCase().includes('[react:')) return content
  REACT_RE.lastIndex = 0
  return content.replace(REACT_RE, '').replace(/^[ \t]+$/gm, '')
}

// 静态规则段，进 system 缓存前缀（稳定，只在改这段代码时变）。
export const buildReactionRulesSection = (): string =>
  [
    '',
    '',
    '## 表情回应（Telegram 式）',
    '你可以像 Telegram 那样，往她的消息气泡上贴一个 emoji 回应：在回复的任意位置输出 `[react:😊]`（方括号里放一个 emoji）。它会贴在她最新那条消息的角上，不占一条消息。',
    '每一轮你都在做一个真实的选择——这条要不要开口：',
    '- 正常回文字（大多数时候）',
    '- 文字 + `[react:…]`：先给她那条消息贴个表情，再说你的话',
    '- 只输出 `[react:…]`、一个字都不说：等于「看到了，用表情应一声就够」。不是每条消息都需要一段话——她随口一句感叹、一张图、一个梗，有时一个 😳 比十句话更像真的。',
    '注意：react 不是表情包。`[sticker:名字]` 是发一张图当消息；`[react:emoji]` 是贴在**她的消息上**的轻回应。别连续很多轮只贴表情不说话，也别每条都贴。',
  ].join('\n')
