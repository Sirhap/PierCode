// AiFrame — 单个常驻 AI <iframe> 容器。
//
// 每个平台挂载一次且永不卸载（对话保留），靠 active prop 切 display 显隐。
// src 带 ?piercode_browser_agent=<platform> 哨兵，content/index.ts 的
// isBrowserAgentFrame() 据此只在该 iframe 内跑 browser-agent-bridge。
//
// DNR 规则（manifest dnr-offscreen.json）剥掉 chatgpt.com / chat.qwen.ai 的
// X-Frame-Options + CSP，iframe 才能嵌入。

export function AiFrame(props: { platform: string; src: string; active: boolean }): JSX.Element {
  const { platform, src, active } = props
  return (
    <iframe
      title={`piercode-ai-${platform}`}
      src={src}
      // 非活跃 display:none：不销毁 iframe，网页 AI 对话与登录态都保留。
      style={{
        display: active ? 'block' : 'none',
        width: '100%',
        height: '100%',
        border: 0,
        background: 'var(--bg)',
      }}
      // 允许网页 AI 正常运行（脚本、表单、剪贴板、同源弹窗）。
      allow="clipboard-read; clipboard-write"
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads allow-popups-to-escape-sandbox"
    />
  )
}
