import { useEffect, useState, type ReactNode } from 'react'
import { DEFAULT_AUTO_APPROVE_BROWSER_ACTIONS, DEFAULT_AUTO_EXECUTE, DEFAULT_BATCH_QUIET_MS, DEFAULT_PERMISSION_MODE, DEFAULT_PLATFORM_THRESHOLDS, DEFAULT_STEALTH_MODE, MAX_BATCH_QUIET_MS, MIN_BATCH_QUIET_MS, type ContextCompressionConfig, type PermissionMode, resolveAutoApproveBrowserActions, resolveAutoExecute, resolveBatchQuietMs, resolveContextCompressionConfig, resolvePermissionMode, resolveStealthMode } from '../settings'

const DEFAULT_PORT = 39527

// 当前启用上下文压缩的平台（与 content/index.ts 的 COMPRESSION_PLATFORMS 对齐）。
const COMPRESSION_PLATFORM_LABELS: Array<{ key: string; label: string }> = [
  { key: 'qwen', label: 'Qwen' },
  { key: 'chatgpt', label: 'ChatGPT' },
]

// thresholdOf 取某平台阈值：优先用户配置，否则全局默认。
function thresholdOf(cfg: ContextCompressionConfig, platform: string): number {
  const t = cfg.perPlatformThresholds[platform]
  return typeof t === 'number' && t > 0 ? t : cfg.defaultMaxContextTokens
}

function formatTokenThresholdInput(tokens: number): string {
  if (tokens >= 1_000) return trimFixed(tokens / 1_000, 1)
  return String(Math.round(tokens))
}

function parseTokenThresholdInput(raw: string, fallback: number): number {
  const text = raw.trim().toLowerCase()
  if (!text) return fallback
  const match = text.match(/^(\d+(?:\.\d+)?)$/)
  if (!match) return fallback
  const value = Number(match[1])
  if (!Number.isFinite(value) || value <= 0) return fallback
  return Math.round(value * 1_000)
}

function trimFixed(n: number, digits: number): string {
  return n.toFixed(digits).replace(/\.0+$|(?<=[1-9])0+$/, '')
}

export function normalizeAuthUrl(raw: string): { baseUrl: string; token: string; port: number } {
  const trimmed = raw.trim()
  // 容错：用户可能只粘了 token（64 位 hex），而非完整认证 URL。
  // 此时默认连本机 39527，省去手动拼 URL。
  if (/^[0-9a-fA-F]{16,128}$/.test(trimmed)) {
    return { baseUrl: `http://127.0.0.1:${DEFAULT_PORT}`, token: trimmed, port: DEFAULT_PORT }
  }
  const authUrl = new URL(trimmed)
  const token = (authUrl.searchParams.get('token') || '').trim()
  const baseUrl = `${authUrl.protocol}//${authUrl.host}`
  const port = Number(authUrl.port || (authUrl.protocol === 'https:' ? 443 : 80))
  return { baseUrl, token, port }
}

function isValidAuthResponse(data: any): boolean {
  return data?.valid === true || data?.valid === 'true' || data?.status === 'ok'
}

function formatAuthFailure(res: Response, data: any): string {
  if (!res.ok) return `HTTP ${res.status}`
  if (data?.reason === 'missing_token') return 'URL 中没有 token 参数'
  const actualLength = Number(data?.actual_length)
  const expectedLength = Number(data?.expected_length)
  if (Number.isFinite(actualLength) && Number.isFinite(expectedLength) && expectedLength > 0) {
    if (actualLength < expectedLength) {
      return `Token 复制不完整（当前 ${actualLength}/${expectedLength} 位）`
    }
    if (actualLength !== expectedLength) {
      return `Token 长度不匹配（当前 ${actualLength}/${expectedLength} 位）`
    }
    return 'Token 内容不匹配'
  }
  return 'Token 不匹配，请确认使用的是当前 TUI 显示的认证 URL'
}

type EnsureContentResult = {
  tabs?: number
  injected?: number
  loaded?: number
  wsConnected?: number
  failed?: number
}

type BridgeStatusResult = {
  tabs?: number
  loaded?: number
  wsConnected?: number
  failed?: number
}

type BrowserRelayStatus = {
  state?: string
  controlledTabId?: number | null
  lastError?: string
  updatedAt?: number
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function clearStoredAuth(): Promise<void> {
  return new Promise(resolve => {
    chrome.storage.local.remove(['authToken', 'apiUrl', 'authPort'], () => resolve())
  })
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(fallback), ms)
    promise
      .then(value => {
        clearTimeout(timer)
        resolve(value)
      })
      .catch(() => {
        clearTimeout(timer)
        resolve(fallback)
      })
  })
}

// ── 复用 UI 原子组件 ──────────────────────────────────────────────────────────

// 开关行。risk=true 时用琥珀色表示"打开会降低安全/审批保护"。
function Toggle({
  label, checked, onChange, risk = false, desc,
}: {
  label: string; checked: boolean; onChange: (v: boolean) => void; risk?: boolean; desc?: string;
}) {
  const onColor = risk ? 'bg-amber-500' : 'bg-blue-600'
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <span className="text-sm text-gray-200">{label}</span>
        {desc && <div className="text-[11px] leading-snug text-gray-500 mt-0.5">{desc}</div>}
      </div>
      <button
        onClick={() => onChange(!checked)}
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className={`relative inline-flex w-11 h-6 rounded-full transition-colors duration-200 cursor-pointer flex-shrink-0 mt-0.5 ${checked ? onColor : 'bg-gray-600'}`}
      >
        <span className={`inline-block w-5 h-5 mt-0.5 bg-white rounded-full shadow transition-transform duration-200 ${checked ? 'translate-x-5' : 'translate-x-0.5'}`} />
      </button>
    </div>
  )
}

// 分组容器：标题 + 卡片化内容。把零散设置归类，降低认知负担。
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="text-[11px] font-medium uppercase tracking-wider text-gray-500">{title}</div>
      <div className="space-y-3 rounded-lg border border-gray-800 bg-gray-900/50 p-3">
        {children}
      </div>
    </div>
  )
}

// 风险提示条（琥珀=注意，红=危险）。仅在对应高风险项开启时出现。
function RiskNote({ tone = 'warn', children }: { tone?: 'warn' | 'danger'; children: ReactNode }) {
  const cls = tone === 'danger'
    ? 'border-red-500/40 bg-red-500/10 text-red-200'
    : 'border-amber-500/30 bg-amber-500/10 text-amber-100'
  return <div className={`rounded-md border px-3 py-2 text-[11px] leading-snug ${cls}`}>{children}</div>
}

export default function App() {
  const [status, setStatus] = useState<'checking' | 'connected' | 'disconnected'>('checking')
  const [token, setToken] = useState('')
  const [reconfig, setReconfig] = useState(false)
  const [info, setInfo] = useState('')
  const [loading, setLoading] = useState(false)
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null)
  const [autoSend, setAutoSend] = useState(true)
  const [autoExecute, setAutoExecute] = useState(DEFAULT_AUTO_EXECUTE)
  const [autoApproveBrowserActions, setAutoApproveBrowserActions] = useState(DEFAULT_AUTO_APPROVE_BROWSER_ACTIONS)
  const [batchQuietMs, setBatchQuietMs] = useState(DEFAULT_BATCH_QUIET_MS)
  const [browserRelay, setBrowserRelay] = useState<BrowserRelayStatus>({})
  const [hasStoredAuth, setHasStoredAuth] = useState(false)
  const [stealthMode, setStealthMode] = useState(DEFAULT_STEALTH_MODE)
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(DEFAULT_PERMISSION_MODE)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [compression, setCompression] = useState<ContextCompressionConfig>(() => resolveContextCompressionConfig(undefined))
  const [draftThresholds, setDraftThresholds] = useState<Record<string, string>>({})
  // 运行时状态（从后端拉取，非用户设置）
  const [version, setVersion] = useState('')
  const [rootDir, setRootDir] = useState('')
  const [browserProviders, setBrowserProviders] = useState<Record<string, number>>({})
  const [tasksRunning, setTasksRunning] = useState(0)
  const [tasksTotal, setTasksTotal] = useState(0)

  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 3000)
      return () => clearTimeout(timer)
    }
  }, [toast])

  useEffect(() => {
    chrome.storage.local.get(['authToken', 'apiUrl', 'authPort', 'autoSend', 'autoExecute', 'autoApproveBrowserActions', 'batchQuietMs', 'stealthMode', 'contextCompressionConfig', 'qwenCompressionConfig'], (result) => {
      const savedUrl = result.apiUrl || (result.authPort ? `http://127.0.0.1:${result.authPort}` : '')
      if (result.authToken && savedUrl) {
        setHasStoredAuth(true)
        setStatus('checking')
        setInfo('正在检查本地服务')
        checkConnection(savedUrl, result.authToken)
      } else {
        setHasStoredAuth(false)
        setStatus('disconnected')
        setInfo('请输入认证 Token URL')
      }
      if (result.autoSend !== undefined) setAutoSend(result.autoSend)
      const nextAutoExecute = resolveAutoExecute(result.autoExecute)
      setAutoExecute(nextAutoExecute)
      if (result.autoExecute === undefined) chrome.storage.local.set({ autoExecute: nextAutoExecute })
      const nextAutoApproveBrowserActions = resolveAutoApproveBrowserActions(result.autoApproveBrowserActions)
      setAutoApproveBrowserActions(nextAutoApproveBrowserActions)
      if (result.autoApproveBrowserActions === undefined) chrome.storage.local.set({ autoApproveBrowserActions: nextAutoApproveBrowserActions })
      const nextBatchQuietMs = resolveBatchQuietMs(result.batchQuietMs)
      setBatchQuietMs(nextBatchQuietMs)
      if (result.batchQuietMs === undefined) chrome.storage.local.set({ batchQuietMs: nextBatchQuietMs })
      const nextStealthMode = resolveStealthMode(result.stealthMode)
      setStealthMode(nextStealthMode)
      if (result.stealthMode === undefined) chrome.storage.local.set({ stealthMode: nextStealthMode })
      // 上下文压缩配置：新键缺失时从旧 qwenCompressionConfig 迁移。
      setCompression(resolveContextCompressionConfig(result.contextCompressionConfig, result.qwenCompressionConfig))
    })
  }, [])

  // 轮询：popup 打开期间每 4s 复检一次本地服务状态，这样用户在 popup 开着时
  // 启停服务也能即时反映，无需手动关开 popup。reconfig 表单展开或正在连接时跳过，
  // 避免打断输入或与手动连接竞态。
  useEffect(() => {
    const timer = setInterval(() => {
      if (reconfig || loading) return
      chrome.storage.local.get(['authToken', 'apiUrl', 'authPort'], (result) => {
        const savedUrl = result.apiUrl || (result.authPort ? `http://127.0.0.1:${result.authPort}` : '')
        if (result.authToken && savedUrl) {
          checkConnection(savedUrl, result.authToken, { keepConnected: status === 'connected' })
        }
      })
    }, 4000)
    return () => clearInterval(timer)
  }, [reconfig, loading, status])

  const recheckNow = () => {
    chrome.storage.local.get(['authToken', 'apiUrl', 'authPort'], (result) => {
      const savedUrl = result.apiUrl || (result.authPort ? `http://127.0.0.1:${result.authPort}` : '')
      if (result.authToken && savedUrl) {
        setStatus('checking')
        setInfo('正在检查本地服务')
        checkConnection(savedUrl, result.authToken)
      } else {
        setReconfig(true)
        setInfo('请输入认证 Token URL')
      }
    })
  }

  const ensureContentScripts = (): Promise<EnsureContentResult> => {
    return new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'ENSURE_CONTENT_SCRIPTS' }, (result: EnsureContentResult) => {
        if (chrome.runtime.lastError) {
          console.warn('[PierCode] ensure content scripts failed:', chrome.runtime.lastError.message)
          resolve({})
          return
        }
        resolve(result || {})
      })
    })
  }

  const getBridgeStatus = (): Promise<BridgeStatusResult> => {
    return new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'GET_BRIDGE_STATUS' }, (result: BridgeStatusResult) => {
        if (chrome.runtime.lastError) {
          console.warn('[PierCode] get bridge status failed:', chrome.runtime.lastError.message)
          resolve({})
          return
        }
        resolve(result || {})
      })
    })
  }

  const getBrowserRelayStatus = (): Promise<BrowserRelayStatus> => {
    return new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'GET_BROWSER_RELAY_STATUS' }, (result: BrowserRelayStatus) => {
        if (chrome.runtime.lastError) {
          console.warn('[PierCode] get browser relay status failed:', chrome.runtime.lastError.message)
          resolve({})
          return
        }
        resolve(result || {})
      })
    })
  }

  const checkConnection = (url: string, authToken?: string, options?: { keepConnected?: boolean }) => {
    if (!options?.keepConnected) setStatus('checking')
    fetch(`${url}/health`)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then(async (health) => {
        setVersion(health?.version || '')
        const headers: Record<string, string> = {}
        if (authToken) headers.Authorization = `Bearer ${authToken}`
        const configRes = await fetch(`${url}/config`, { headers })
        if (configRes.status === 401) throw new Error('unauthorized')
        if (configRes.ok) {
          const config = await configRes.json()
          setPermissionMode(resolvePermissionMode(config?.permissionMode))
          setRootDir(config?.rootDir || '')
        }

        const statsRes = await fetch(`${url}/stats`, { headers })
        if (statsRes.status === 401) throw new Error('unauthorized')
        if (!statsRes.ok) throw new Error(`stats HTTP ${statsRes.status}`)
        const stats = await statsRes.json()
        const backendClients = Math.max(0, Number(stats.browser_clients || 0) - Number(stats.browser_relays || 0))
        setBrowserProviders(stats?.browser_providers || {})
        setTasksRunning(Number(stats?.tasks_running || 0))
        setTasksTotal(Number(stats?.tasks_total || 0))

        setStatus('connected')
        setInfo('本地服务已连接，正在检查 AI 页面')

        const result = await withTimeout(ensureContentScripts(), 3500, {})
        await wait(600)
        const bridge = await withTimeout(getBridgeStatus(), 2500, {})
        const relay = await withTimeout(getBrowserRelayStatus(), 1500, {})
        setBrowserRelay(relay)

        const tabs = Number(bridge.tabs ?? result.tabs ?? 0)
        const loaded = Number(bridge.loaded ?? result.loaded ?? 0)
        const wsConnected = Number(bridge.wsConnected ?? result.wsConnected ?? 0)
        const failed = Number((bridge.failed || 0) + (result.failed || 0))
        const suffix = backendClients > 0
          ? `桥接已连接 ${backendClients} 个 AI 页面`
          : wsConnected > 0
            ? `AI 页面 WebSocket 已打开，等待后端统计刷新 (${wsConnected})`
            : loaded > 0
              ? `已唤醒 ${loaded} 个 AI 页面，等待 WebSocket 连接`
              : failed > 0
                ? 'AI 页面注入失败，请刷新页面'
                : tabs > 0
                  ? '已发现 AI 页面，等待插件脚本加载'
                  : '未发现已打开的 AI 页面'
        setInfo(suffix)
      })
      .catch((error) => {
        setStatus('disconnected')
        setRootDir('')
        setBrowserProviders({})
        setTasksRunning(0)
        setTasksTotal(0)
        if (error instanceof Error && error.message === 'unauthorized') {
          clearStoredAuth()
          setHasStoredAuth(false)
          setReconfig(true)
          setInfo('Token 已失效，请重新输入当前 TUI 显示的认证 URL')
        } else {
          setInfo('本地服务未运行，请启动后端（go run ./cmd/server）')
        }
      })
  }

  const handleConnect = async () => {
    if (!token) return
    setLoading(true)
    setToast(null)
    try {
      const { baseUrl, token: tokenValue, port } = normalizeAuthUrl(token)
      if (!tokenValue) {
        setToast({ msg: 'URL 格式错误', type: 'error' })
        setLoading(false)
        return
      }
      // 服务端只接受 POST /auth + JSON body。GET ?token=... 已移除：
      // 长期凭据进浏览器历史 / 反向代理日志是泄露面。
      const res = await fetch(`${baseUrl}/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: tokenValue }),
      })
      const text = await res.text()
      let data: any = {}
      try {
        data = text ? JSON.parse(text) : {}
      } catch {
        data = {}
      }
      if (res.ok && isValidAuthResponse(data)) {
        await new Promise<void>(resolve => {
          chrome.storage.local.set({ authToken: tokenValue, apiUrl: baseUrl, authPort: port }, () => resolve())
        })
        setHasStoredAuth(true)
        setReconfig(false)
        setStatus('connected')
        setInfo('授权成功，正在检查 AI 页面')
        setToast({ msg: '✅ 授权成功，正在唤醒 AI 页面', type: 'success' })
        checkConnection(baseUrl, tokenValue, { keepConnected: true })
      } else {
        const reason = formatAuthFailure(res, data)
        setToast({ msg: `❌ Token 验证失败：${reason}`, type: 'error' })
      }
    } catch (error) {
      console.error('[PierCode] auth failed:', error)
      setToast({ msg: '❌ 连接失败，请检查服务是否运行', type: 'error' })
    } finally {
      setLoading(false)
    }
  }

  const handleAutoSendChange = (val: boolean) => {
    setAutoSend(val)
    chrome.storage.local.set({ autoSend: val })
  }

  const handleAutoExecuteChange = (val: boolean) => {
    setAutoExecute(val)
    chrome.storage.local.set({ autoExecute: val })
  }

  const handleAutoApproveBrowserActionsChange = (val: boolean) => {
    setAutoApproveBrowserActions(val)
    chrome.storage.local.set({ autoApproveBrowserActions: val })
  }

  const handleBatchQuietMsChange = (ms: number) => {
    const safe = resolveBatchQuietMs(ms)
    setBatchQuietMs(safe)
    chrome.storage.local.set({ batchQuietMs: safe })
  }

  const handleStealthModeChange = (val: boolean) => {
    setStealthMode(val)
    chrome.storage.local.set({ stealthMode: val })
  }

  // 持久化压缩配置：写回后 content 侧的 storage.onChanged 监听会失效缓存并按新值重算。
  const persistCompression = (next: ContextCompressionConfig) => {
    setCompression(next)
    chrome.storage.local.set({ contextCompressionConfig: next })
  }

  const handleCompressionEnabledChange = (enabled: boolean) => {
    persistCompression({ ...compression, enabled })
  }

  const handleCompressionTriggerModeChange = (confirm: boolean) => {
    persistCompression({ ...compression, triggerMode: confirm ? 'confirm' : 'auto' })
  }

  const handleCompressionHandoffModeChange = (manual: boolean) => {
    persistCompression({ ...compression, handoffMode: manual ? 'manual' : 'auto' })
  }

  // 阈值输入框以 k tokens 为单位，存储层仍保存完整 token 数。
  const handlePlatformThresholdChange = (platform: string, raw: string) => {
    const fallback = DEFAULT_PLATFORM_THRESHOLDS[platform] ?? compression.defaultMaxContextTokens
    const tokens = parseTokenThresholdInput(raw, fallback)
    persistCompression({
      ...compression,
      perPlatformThresholds: { ...compression.perPlatformThresholds, [platform]: tokens },
    })
  }

  const getDraftThreshold = (key: string) =>
    draftThresholds[key] ?? formatTokenThresholdInput(thresholdOf(compression, key))

  const handleDraftThresholdChange = (key: string, val: string) =>
    setDraftThresholds((prev) => ({ ...prev, [key]: val }))

  const commitDraftThreshold = (key: string) => {
    const raw = draftThresholds[key]
    if (raw !== undefined) {
      handlePlatformThresholdChange(key, raw)
      setDraftThresholds((prev) => {
        const next = { ...prev }
        delete next[key]
        return next
      })
    }
  }

  const handlePermissionModeChange = (mode: PermissionMode) => {
    setPermissionMode(mode)
    chrome.storage.local.get(['authToken', 'apiUrl', 'authPort'], async result => {
      const savedUrl = result.apiUrl || (result.authPort ? `http://127.0.0.1:${result.authPort}` : '')
      if (!result.authToken || !savedUrl) return
      try {
        const res = await fetch(`${savedUrl}/config`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${result.authToken}`,
          },
          body: JSON.stringify({ permissionMode: mode }),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        setToast({ msg: '权限模式已更新', type: 'success' })
      } catch (error) {
        console.error('[PierCode] update permission mode failed:', error)
        setToast({ msg: '权限模式更新失败', type: 'error' })
      }
    })
  }

  const statusColor = status === 'connected' ? 'bg-emerald-400' : status === 'checking' ? 'bg-yellow-400' : 'bg-red-400'
  const statusText = status === 'checking' ? '检查中...' : status === 'connected' ? '本地服务已连接' : '未连接'

  return (
    <div className="w-72 bg-gray-950 text-gray-100 p-4 font-sans">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className="text-lg">🔗</span>
          <span className="font-semibold text-white tracking-wide">PierCode</span>
          {version && <span className="text-[10px] text-gray-600">v{version}</span>}
        </div>
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${statusColor} ${status === 'checking' ? 'animate-pulse' : ''}`} />
          <span className="text-xs text-gray-400">{statusText}</span>
          {status === 'connected' && (
            <button
              onClick={() => {
                if (!reconfig) {
                  clearStoredAuth()
                  setHasStoredAuth(false)
                  setStatus('disconnected')
                  setInfo('请输入认证 Token URL')
                }
                setReconfig(!reconfig)
                setToken('')
              }}
              className="text-xs text-gray-500 hover:text-gray-300 transition-colors cursor-pointer"
            >
              {reconfig ? '取消' : '重新配置'}
            </button>
          )}
        </div>
      </div>

      {/* Multi-AI Hub: opens a page that embeds several AI sites side by side so
          they all run in the foreground at once (workers no longer throttle in
          background tabs). */}
      <button
        onClick={() => chrome.runtime.sendMessage({ type: 'OPEN_HUB' })}
        className="w-full mb-4 rounded-md border border-indigo-700 bg-indigo-900/40 px-3 py-2 text-sm text-indigo-100 hover:bg-indigo-800/60 transition-colors cursor-pointer"
      >
        🗂️ 打开多 AI 工作台
      </button>

      {/* 运行时状态摘要（仅连接后展示） */}
      {status === 'connected' && (
        <div className="mb-4 space-y-2 rounded-lg border border-gray-800 bg-gray-900/50 p-3 text-xs">
          {/* 工作区 */}
          {rootDir && (
            <div className="flex items-center gap-1.5 text-gray-400">
              <span className="text-gray-600">📁</span>
              <span className="truncate" title={rootDir}>{rootDir}</span>
            </div>
          )}
          {/* 已连接 AI 平台 */}
          {Object.keys(browserProviders).length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-gray-600">🌐</span>
              {Object.entries(browserProviders).map(([name, count]) => (
                <span key={name} className="inline-flex items-center gap-1 rounded-full bg-emerald-900/40 border border-emerald-700/40 px-2 py-0.5 text-emerald-300">
                  {name}{count > 1 ? `×${count}` : ''}
                </span>
              ))}
            </div>
          )}
          {/* 后台任务 */}
          {tasksTotal > 0 && (
            <div className="flex items-center gap-1.5 text-gray-400">
              <span className="text-gray-600">⚡</span>
              <span>
                {tasksRunning > 0
                  ? <span className="text-amber-300">{tasksRunning} 个任务运行中</span>
                  : <span>共 {tasksTotal} 个任务已完成</span>
                }
              </span>
            </div>
          )}
        </div>
      )}

      {/* Connect form */}
      {(status !== 'connected' || reconfig) && (
        <div className="mb-4 space-y-2">
          <input
            type="password"
            placeholder="粘贴 Token URL"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !loading && handleConnect()}
            disabled={loading}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500 outline-none focus:border-blue-500 transition-colors disabled:opacity-50"
          />
          <button
            onClick={handleConnect}
            disabled={loading}
            className="w-full bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white text-sm font-medium rounded-lg py-2 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {loading ? (
              <>
                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                连接中...
              </>
            ) : '连接'}
          </button>
          <p className="text-[11px] leading-snug text-gray-500">
            粘贴 TUI 显示的认证 URL（或直接粘 token）。授权一次后 token 会持久化，服务重启无需重连。
          </p>
        </div>
      )}

      {/* 服务掉线但已有授权：给一键重连，省得用户重开 popup 或重新粘贴 */}
      {status === 'disconnected' && hasStoredAuth && !reconfig && (
        <button
          onClick={recheckNow}
          className="w-full mb-4 bg-gray-800 hover:bg-gray-700 active:bg-gray-900 text-gray-200 text-sm font-medium rounded-lg py-2 transition-colors cursor-pointer flex items-center justify-center gap-2"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4 4v5h5M20 20v-5h-5M5.5 9a7 7 0 0111.9-2.5M18.5 15a7 7 0 01-11.9 2.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          重新连接服务
        </button>
      )}

      {/* Divider */}
      <div className="border-t border-gray-800 my-3" />

      {/* 设置区：按"自动化/审批"与"沙箱/安全"两类分组，高风险项加警示 */}
      <div className="space-y-4">
        {/* ── 自动化 / 审批 ── 决定"要不要手动确认" ── */}
        <Section title="自动化 / 审批">
          <Toggle
            label="自动执行工具"
            desc="工具调用卡片自动执行，无需手动点"
            checked={autoExecute}
            onChange={handleAutoExecuteChange}
            risk
          />
          {autoExecute && (
            <div className="flex items-center gap-2 pl-0.5">
              <span className="text-[11px] text-gray-400 flex-shrink-0">静默窗口</span>
              <input
                type="number"
                min={MIN_BATCH_QUIET_MS}
                max={MAX_BATCH_QUIET_MS}
                step={50}
                value={batchQuietMs}
                onChange={(e) => handleBatchQuietMsChange(Number(e.target.value))}
                className="w-16 bg-gray-800 border border-gray-700 rounded-md px-2 py-1 text-xs text-center text-gray-100 outline-none focus:border-blue-500 transition-colors"
              />
              <span className="text-[11px] text-gray-500">ms · 0 = 流停即执行</span>
            </div>
          )}

          <Toggle
            label="自动提交"
            desc="工具结果回填后自动发送给 AI"
            checked={autoSend}
            onChange={handleAutoSendChange}
          />

          <Toggle
            label="自动审批浏览器操作"
            desc="点击 / 输入 / 导航等审批自动允许"
            checked={autoApproveBrowserActions}
            onChange={handleAutoApproveBrowserActionsChange}
            risk
          />
          {autoApproveBrowserActions && (
            <RiskNote>浏览器操作将自动允许、不再弹审批。请只在可信页面使用。</RiskNote>
          )}
        </Section>

        {/* 高级选项（默认折叠，减少首屏干扰） */}
        <button
          onClick={() => setAdvancedOpen(!advancedOpen)}
          className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 transition-colors cursor-pointer"
        >
          <svg
            className={`h-3 w-3 transition-transform duration-200 ${advancedOpen ? 'rotate-90' : ''}`}
            viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          >
            <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          高级选项
        </button>

        {/* ── 沙箱 / 安全 ── 决定"能访问到哪、页面留不留痕" ── */}
        {advancedOpen && (
          <Section title="沙箱 / 安全">
            <Toggle
              label="限制在工作区"
              desc={permissionMode === 'unrestricted' ? '已关闭：工具可访问本机任意路径' : '工具只能访问工作区与手动追加的目录'}
              checked={permissionMode !== 'unrestricted'}
              onChange={(on) => handlePermissionModeChange(on ? 'default' : 'unrestricted')}
            />
            {permissionMode === 'unrestricted' && (
              <RiskNote tone="danger">
                沙箱已关闭：工具可读写本机任意目录。请只在完全可信的任务中使用。
              </RiskNote>
            )}

            <Toggle
              label="隐身模式"
              desc="仅留角落迷你圆点，注入元素 id 随机化"
              checked={stealthMode}
              onChange={handleStealthModeChange}
            />
            {stealthMode && (
              <div className="rounded-md border border-indigo-500/30 bg-indigo-500/10 px-3 py-2 text-[11px] leading-snug text-indigo-100">
                页面上仅保留右下角迷你圆点（点击可停止），关闭脉冲边框与大块徽章。
              </div>
            )}
          </Section>
        )}

        {/* ── 上下文压缩 ── 会话 token 到阈值时让模型压缩并迁移到新会话 ── */}
        {advancedOpen && (
          <Section title="上下文压缩">
            <Toggle
              label="启用上下文压缩"
              desc="会话 token 接近阈值时，自动让模型压缩并迁移到新会话（目前 Qwen / ChatGPT）"
              checked={compression.enabled}
              onChange={handleCompressionEnabledChange}
            />
            {compression.enabled && (
              <Toggle
                label="到阈值先确认"
                desc="到阈值时弹卡让你选「压缩」或「跳过继续执行」；关闭则直接自动压缩"
                checked={compression.triggerMode === 'confirm'}
                onChange={handleCompressionTriggerModeChange}
              />
            )}
            {compression.enabled && (
              <Toggle
                label="手动迁移（仅复制）"
                desc="压缩出包后只复制到剪贴板，由你自己打开新会话粘贴；关闭则自动开新标签并发送"
                checked={compression.handoffMode === 'manual'}
                onChange={handleCompressionHandoffModeChange}
              />
            )}
            {compression.enabled && (
              <div className="space-y-1.5">
                {COMPRESSION_PLATFORM_LABELS.map(({ key, label }) => (
                  <div key={key} className="flex items-center gap-2 pl-0.5">
                    <span className="text-[11px] text-gray-400 w-16 flex-shrink-0">{label}</span>
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={getDraftThreshold(key)}
                      onChange={(e) => handleDraftThresholdChange(key, e.target.value)}
                      onBlur={() => commitDraftThreshold(key)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                      }}
                      className="w-24 bg-gray-800 border border-gray-700 rounded-md px-2 py-1 text-xs text-center text-gray-100 outline-none focus:border-blue-500 transition-colors"
                    />
                    <span className="text-[11px] text-gray-500">k</span>
                  </div>
                ))}
                <div className="text-[11px] leading-snug text-gray-500 pl-0.5">
                  到阈值后请模型输出 piercode-context 包，失败回退本地摘要，并在新标签接续会话。
                </div>
              </div>
            )}
          </Section>
        )}
      </div>

      {/* Info：状态详情，最多两行，不截断关键信息 */}
      {info && (
        <div
          className="mt-3 text-xs leading-snug text-gray-500 line-clamp-2"
          title={info}
        >
          {info}
        </div>
      )}

      <div className="mt-3 rounded-lg border border-gray-800 bg-gray-900 p-3 text-xs text-gray-400">
        <div className="flex items-center justify-between">
          <span className="font-medium text-gray-300">浏览器控制</span>
          <span className={`inline-flex items-center gap-1.5 ${browserRelay.state === 'open' ? 'text-emerald-300' : 'text-gray-500'}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${browserRelay.state === 'open' ? 'bg-emerald-400' : 'bg-gray-600'}`} />
            {browserRelay.state === 'open' ? '已连接' : '未连接'}
          </span>
        </div>
        {browserRelay.controlledTabId ? (
          <div className="mt-1 text-gray-500">已接管标签页 #{browserRelay.controlledTabId}</div>
        ) : (
          <div className="mt-1 text-gray-500">尚未接管任何标签页（AI 触发浏览器操作时自动接管）</div>
        )}
        {browserRelay.lastError && <div className="mt-1 truncate text-red-300">{browserRelay.lastError}</div>}
      </div>

      {/* Toast Notification */}
      {toast && (
        <div className={`fixed top-4 left-1/2 -translate-x-1/2 px-4 py-2 rounded-lg shadow-lg text-sm font-medium z-50 transition-all duration-300 animate-fade-in-down ${
          toast.type === 'success' ? 'bg-emerald-600 text-white' : 'bg-red-600 text-white'
        }`}>
          {toast.msg}
        </div>
      )}
    </div>
  )
}
