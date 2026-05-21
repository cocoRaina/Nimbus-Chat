import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

type MarkdownRendererProps = {
  content: string
}

const MarkdownRenderer = memo(
  ({ content }: MarkdownRendererProps) => (
    <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
  ),
  // Markdown parsing is the dominant cost on each keystroke when many
  // assistant messages are on screen. Skip re-render unless the content
  // actually changed.
  (prev, next) => prev.content === next.content,
)

export default MarkdownRenderer
