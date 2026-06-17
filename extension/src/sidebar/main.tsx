import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// v1 入口改指浏览器操作 Agent 侧边栏（spec §7）。旧 App.tsx 的 API 聊天 UI 下线，
// 但 App.tsx 仍留在盘上、chat-api.ts 的 API 子 agent 引擎也保留不动（独立子系统）。
import BrowserAgentApp from './BrowserAgentApp'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserAgentApp />
  </StrictMode>
)
