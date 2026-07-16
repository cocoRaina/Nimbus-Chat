import { memo, useState } from 'react'
import { createPortal } from 'react-dom'
import './ArtifactFrame.css'

// 🧸 Artifact 小玩具：小机在 ```html 代码块里写的自包含 HTML，渲染成
// 可以玩的沙箱 iframe（Claude App artifact 的聊天气泡版）。
//
// 安全模型：sandbox="allow-scripts"（不带 allow-same-origin）——srcdoc
// 内容跑在不透明源（opaque origin）里，拿不到 localStorage / cookies /
// supabase session，也发不了同源请求；小机的代码再怎么写都碰不到 App
// 本体的数据。工具素材全内联（系统提示里要求），所以断网也能玩。
//
// 全屏用第二个 iframe（portal 到 body）：srcdoc 一样但状态重开——
// 对小玩具来说「全屏=重新开一局」符合直觉，也省掉搬移 iframe 不重载
// 的复杂度（DOM 里移动 iframe 必然重载，浏览器规范如此）。

type ArtifactFrameProps = {
  code: string
}

const ArtifactFrame = memo(
  ({ code }: ArtifactFrameProps) => {
    const [showCode, setShowCode] = useState(false)
    const [fullscreen, setFullscreen] = useState(false)

    return (
      <div className="artifact-card">
        <div className="artifact-bar">
          <span className="artifact-title">🧸 小玩具</span>
          <div className="artifact-actions">
            <button type="button" onClick={() => setShowCode((v) => !v)}>
              {showCode ? '▶ 玩' : '</> 代码'}
            </button>
            <button type="button" onClick={() => setFullscreen(true)}>
              ⛶ 全屏
            </button>
          </div>
        </div>
        {showCode ? (
          <pre className="artifact-code">
            <code>{code}</code>
          </pre>
        ) : (
          <iframe
            className="artifact-iframe"
            sandbox="allow-scripts"
            srcDoc={code}
            title="小玩具"
            loading="lazy"
          />
        )}
        {fullscreen
          ? createPortal(
              <div className="artifact-fullscreen">
                <div className="artifact-fullscreen-bar">
                  <span className="artifact-title">🧸 小玩具</span>
                  <button type="button" onClick={() => setFullscreen(false)}>
                    ✕ 关闭
                  </button>
                </div>
                <iframe
                  className="artifact-fullscreen-iframe"
                  sandbox="allow-scripts"
                  srcDoc={code}
                  title="小玩具（全屏）"
                />
              </div>,
              document.body,
            )
          : null}
      </div>
    )
  },
  (prev, next) => prev.code === next.code,
)

export default ArtifactFrame
