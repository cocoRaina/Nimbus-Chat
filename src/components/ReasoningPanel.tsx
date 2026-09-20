import { memo, useState } from 'react'
import './ReasoningPanel.css'

type ReasoningPanelProps = {
  reasoning: string
}

const ReasoningPanel = memo(({ reasoning }: ReasoningPanelProps) => {
  const [isOpen, setIsOpen] = useState(false)

  return (
    <div className="reasoning-panel">
      <button
        type="button"
        className={`reasoning-panel__toggle ${isOpen ? 'is-open' : ''}`}
        aria-expanded={isOpen}
        aria-label="查看思考链"
        onClick={() => setIsOpen((current) => !current)}
      >
        <span className="reasoning-panel__caption">{isOpen ? '思考' : '思考中…'}</span>
        <span className="reasoning-panel__chev" aria-hidden="true">›</span>
      </button>
      <div className={`reasoning-panel__content ${isOpen ? 'is-open' : ''}`}>
        <div className="reasoning-panel__body reasoning-content">{reasoning}</div>
      </div>
    </div>
  )
})

export default ReasoningPanel
