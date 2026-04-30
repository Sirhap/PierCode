import { useEffect, useState } from 'react'
import { DEFAULT_AUTO_EXECUTE, resolveAutoExecute } from '../settings'

function normalizeAuthUrl(raw: string): { authUrl: URL; baseUrl: string; token: string; port: number } {
  const authUrl = new URL(raw.trim())
  const token = (authUrl.searchParams.get('token') || '').trim()
  const baseUrl = `${authUrl.protocol}//${authUrl.host}`
  const port = Number(authUrl.port || (authUrl.protocol === 'https:' ? 443 : 80))
  return { authUrl, baseUrl, token, port }
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

export default function App() {
  const [status, setStatus] = useState<'checking' | 'connected' | 'disconnected'>('checking')
  const [token, setToken] = useState('')
  const [reconfig, setReconfig] = useState(false)
  const [info, setInfo] = useState('')
  const [loading, setLoading] = useState(false)
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null)
  const [autoSend, setAutoSend] = useState(true)
  const [autoExecute, setAutoExecute] = useState(DEFAULT_AUTO_EXECUTE)
  const [delayMin, setDelayMin] = useState(1)
  const [delayMax, setDelayMax] = useState(4)

  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 3000)
      return () => clearTimeout(timer)
    }
  }, [toast])

  useEffect(() => {
    chrome.storage.local.get(['authToken', 'apiUrl', 'autoSend', 'autoExecute', 'delayMin', 'delayMax'], (result) => {
      if (result.authToken && result.apiUrl) {
        checkConnection(result.apiUrl)
      } else {
        setStatus('disconnected')
        setInfo('请输入认证 Token URL')
      }
      if (result.autoSend !== undefined) setAutoSend(result.autoSend)
      const nextAutoExecute = resolveAutoExecute(result.autoExecute)
      setAutoExecute(nextAutoExecute)
      if (result.autoExecute === undefined) chrome.storage.local.set({ autoExecute: nextAutoExecute })
      if (result.delayMin !== undefined) setDelayMin(result.delayMin)
      if (result.delayMax !== undefined) setDelayMax(result.delayMax)
    })
  }, [])

  const checkConnection = (url: string) => {
    fetch(`${url}/health`)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then(data => { setStatus('connected'); setInfo(`工作目录: ${data.dir || 'unknown'}`) })
      .catch(() => { setStatus('disconnected'); setInfo('服务未运行') })
  }

  const handleConnect = async () => {
    if (!token) return
    setLoading(true)
    setToast(null)
    try {
      const { authUrl, baseUrl, token: tokenValue, port } = normalizeAuthUrl(token)
      if (!tokenValue) {
        setToast({ msg: 'URL 格式错误', type: 'error' })
        setLoading(false)
        return
      }
      const res = await fetch(authUrl.toString(), { method: 'GET' })
      const text = await res.text()
      let data: any = {}
      try {
        data = text ? JSON.parse(text) : {}
      } catch {
        data = {}
      }
      if (res.ok && isValidAuthResponse(data)) {
        chrome.storage.local.set({ authToken: tokenValue, apiUrl: baseUrl, authPort: port })
        setReconfig(false)
        setToast({ msg: '✅ 授权成功！已连接本地服务', type: 'success' })
        checkConnection(baseUrl)
      } else {
        const reason = formatAuthFailure(res, data)
        setToast({ msg: `❌ Token 验证失败：${reason}`, type: 'error' })
      }
    } catch (error) {
      console.error('[OpenLink] auth failed:', error)
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

  const handleDelayChange = (min: number, max: number) => {
    const safeMin = Math.max(0, min)
    const safeMax = Math.max(safeMin, max)
    setDelayMin(safeMin)
    setDelayMax(safeMax)
    chrome.storage.local.set({ delayMin: safeMin, delayMax: safeMax })
  }

  const statusColor = status === 'connected' ? 'bg-emerald-400' : status === 'checking' ? 'bg-yellow-400' : 'bg-red-400'
  const statusText = status === 'checking' ? '检查中...' : status === 'connected' ? '已连接' : '未连接'

  return (
    <div className="w-72 bg-gray-950 text-gray-100 p-4 font-sans">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className="text-lg">🔗</span>
          <span className="font-semibold text-white tracking-wide">OpenLink</span>
        </div>
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${statusColor} ${status === 'checking' ? 'animate-pulse' : ''}`} />
          <span className="text-xs text-gray-400">{statusText}</span>
          {status === 'connected' && (
            <button
              onClick={() => { setReconfig(!reconfig); setToken('') }}
              className="text-xs text-gray-500 hover:text-gray-300 transition-colors cursor-pointer"
            >
              {reconfig ? '取消' : '重新配置'}
            </button>
          )}
        </div>
      </div>

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
        </div>
      )}

      {/* Divider */}
      <div className="border-t border-gray-800 my-3" />

      {/* Auto send toggle */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm text-gray-300">自动执行工具</span>
          <button
            onClick={() => handleAutoExecuteChange(!autoExecute)}
            className={`relative inline-flex w-11 h-6 rounded-full transition-colors duration-200 cursor-pointer flex-shrink-0 ${autoExecute ? 'bg-blue-600' : 'bg-gray-600'}`}
          >
            <span className={`inline-block w-5 h-5 mt-0.5 bg-white rounded-full shadow transition-transform duration-200 ${autoExecute ? 'translate-x-5' : 'translate-x-0.5'}`} />
          </button>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-sm text-gray-300">自动提交</span>
          <button
            onClick={() => handleAutoSendChange(!autoSend)}
            className={`relative inline-flex w-11 h-6 rounded-full transition-colors duration-200 cursor-pointer flex-shrink-0 ${autoSend ? 'bg-blue-600' : 'bg-gray-600'}`}
          >
            <span className={`inline-block w-5 h-5 mt-0.5 bg-white rounded-full shadow transition-transform duration-200 ${autoSend ? 'translate-x-5' : 'translate-x-0.5'}`} />
          </button>
        </div>

        {autoSend && (
          <div className="bg-gray-900 rounded-lg p-3 space-y-2">
            <span className="text-xs text-gray-400">随机延迟（秒）</span>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                value={delayMin}
                onChange={(e) => handleDelayChange(Number(e.target.value), delayMax)}
                className="w-16 bg-gray-800 border border-gray-700 rounded-md px-2 py-1 text-sm text-center text-gray-100 outline-none focus:border-blue-500 transition-colors"
              />
              <span className="text-gray-500 text-sm">~</span>
              <input
                type="number"
                min={0}
                value={delayMax}
                onChange={(e) => handleDelayChange(delayMin, Number(e.target.value))}
                className="w-16 bg-gray-800 border border-gray-700 rounded-md px-2 py-1 text-sm text-center text-gray-100 outline-none focus:border-blue-500 transition-colors"
              />
              <span className="text-xs text-gray-500">秒</span>
            </div>
          </div>
        )}
      </div>

      {/* Info */}
      {info && <div className="mt-3 text-xs text-gray-500 truncate">{info}</div>}

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
