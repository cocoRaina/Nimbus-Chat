import { isValidElement, memo, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import ArtifactFrame from './ArtifactFrame'
import './MarkdownRenderer.css'

type MarkdownRendererProps = {
  content: string
  // 🧸 Artifact：```html 代码块渲染成可玩的沙箱 iframe。流式生成中传 false
  // ——半成品代码每个 chunk 都重灌 iframe 会疯狂闪烁重载，先显示占位，
  // 消息落定后（meta.streaming=false）再真正渲染。默认 true，所以朋友圈
  // 等静态场景（内容永远是完整的）不用传。
  artifactsLive?: boolean
}

// 从 <pre> 的 children 里抠出 language-html 代码块的源码；不是 html
// 块返回 null（走普通代码块渲染）。react-markdown 的 pre 子元素是
// <code className="language-xxx">，源码在它的 children 里。
const extractHtmlArtifact = (children: ReactNode): string | null => {
  const child = Array.isArray(children) ? children[0] : children
  if (!isValidElement(child)) return null
  const props = child.props as { className?: string; children?: ReactNode }
  if (!props.className || !/\blanguage-html\b/.test(props.className)) return null
  const raw = props.children
  const text =
    typeof raw === 'string'
      ? raw
      : Array.isArray(raw)
        ? raw.filter((part): part is string => typeof part === 'string').join('')
        : null
  if (!text || text.trim().length === 0) return null
  return text
}

// Pull the plain source text out of a <pre>'s <code> child, for copying.
const getCodeText = (children: ReactNode): string => {
  const child = Array.isArray(children) ? children[0] : children
  if (!isValidElement(child)) return typeof children === 'string' ? children : ''
  const raw = (child.props as { children?: ReactNode }).children
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw)) return raw.filter((p): p is string => typeof p === 'string').join('')
  return ''
}

// Copy that works in the Android WebView too (clipboard API can be blocked on
// non-secure origins → fall back to a hidden textarea + execCommand).
const copyText = async (text: string): Promise<boolean> => {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true }
  } catch { /* fall through */ }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch { return false }
}

// A code block with a copy button (block code only; inline code is untouched).
const CodeBlock = ({ children, ...rest }: { children?: ReactNode }) => {
  const [copied, setCopied] = useState(false)
  const onCopy = async () => {
    const ok = await copyText(getCodeText(children))
    if (ok) { setCopied(true); window.setTimeout(() => setCopied(false), 1500) }
  }
  return (
    <div className="md-code">
      <button type="button" className="md-code-copy" onClick={onCopy} aria-label="复制代码">
        {copied ? '已复制 ✓' : '复制'}
      </button>
      <pre {...rest}>{children}</pre>
    </div>
  )
}

const MarkdownRenderer = memo(
  ({ content, artifactsLive = true }: MarkdownRendererProps) => (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        pre: ({ node, children, ...rest }) => {
          const artifactCode = extractHtmlArtifact(children)
          if (artifactCode) {
            return artifactsLive ? (
              <ArtifactFrame code={artifactCode} />
            ) : (
              <div className="artifact-building">🧸 小玩具制作中…写完就能玩</div>
            )
          }
          return <CodeBlock {...rest}>{children}</CodeBlock>
        },
      }}
    >
      {content}
    </ReactMarkdown>
  ),
  // Markdown parsing is the dominant cost on each keystroke when many
  // assistant messages are on screen. Skip re-render unless the content
  // actually changed.
  (prev, next) => prev.content === next.content && prev.artifactsLive === next.artifactsLive,
)

export default MarkdownRenderer
