// 🧸 从消息正文里抠出 artifact 小玩具的源码（第一个 ```html 代码块）。
// ChatPage 长按菜单（收藏小玩具）用它判断"这条消息里有没有玩具"并取代码；
// 渲染路径不走这里（MarkdownRenderer 在 React 元素树上做同样的检测）。
export const extractArtifactCode = (content: string): string | null => {
  const m = /```html\s*\n([\s\S]*?)```/.exec(content)
  const code = m?.[1]?.trim()
  return code && code.length > 0 ? code : null
}
