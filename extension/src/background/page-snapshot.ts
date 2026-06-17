/**
 * page-snapshot.ts — 被操作页 → <page-snapshot> 文本（注入 AI 网页 composer）
 *
 * 纯格式器（不直接碰 CDP / chrome.*，全部经传入的 exec 调用），所以可单测。
 * 用真实的 browser_snapshot ref 系统（e0/e1/eN），不是 spec 草案里的 [1][2] 编号。
 * body 行原样来自 internal/browser/snapshot.go writeNode：
 *   - 每层 a11y 树缩进 2 空格（保留，不重新缩进）；
 *   - 可交互/带 ref 节点以 "[e<N>] " 开头，结构性节点以 "- " 开头；
 *   - ref/dash 后是 <role>，命名时跟 ` "<name>"`，value 与 name 不同时 ` value="<v>"`，
 *     再 ` desc="<d>"`，再空格分隔的 flag（disabled/checked/href=... 等）。
 * browser_snapshot 末尾追加的 "\n\nnodeCount=N refCount=N [truncated=true]" 这一行
 * 从 body 里剥掉，抬进 <page-snapshot> 属性（nodeCount/refCount/truncated）。
 */

/** exec 仅需 browser_* 工具的 output/success；故意比 ToolResult 窄，方便测试喂 mock。 */
type SnapshotExec = (
  name: string,
  args: Record<string, unknown>,
) => Promise<{ output: string; success: boolean }>

/** 转义 HTML 属性值（url/title 进 <page-snapshot> 属性，避免引号破坏标签）。 */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** browser_snapshot 尾部 metric 行的解析结果。 */
interface SnapshotMetrics {
  nodeCount: number | null
  refCount: number | null
  truncated: boolean
}

/**
 * 从 browser_snapshot 原始输出里切出 body（去掉尾部 metric 行）+ 解析出的 metric。
 * 尾行形如：`nodeCount=42 refCount=9` 或 `nodeCount=42 refCount=9 truncated=true`，
 * 以一个空行（"\n\n"）与树正文隔开。找不到尾行时整段当 body、metric 全 null。
 */
function splitSnapshotMetrics(raw: string): { body: string; metrics: SnapshotMetrics } {
  const text = raw.replace(/\s+$/, '')
  const metricRe = /nodeCount=(\d+)\s+refCount=(\d+)(?:\s+truncated=(true|false))?\s*$/
  const m = text.match(metricRe)
  if (!m) {
    return { body: text, metrics: { nodeCount: null, refCount: null, truncated: false } }
  }
  // body 是 metric 行之前的部分，去掉两者之间的空行分隔。
  const body = text.slice(0, m.index).replace(/\s+$/, '')
  return {
    body,
    metrics: {
      nodeCount: Number(m[1]),
      refCount: Number(m[2]),
      truncated: m[3] === 'true',
    },
  }
}

/**
 * framePageSnapshot 把 browser_snapshot 的原始输出原样裹进 <page-snapshot> 标签，
 * 并把尾部 "nodeCount=.. refCount=.. [truncated=..]" 抬成标签属性。
 * 纯函数：无 IO，便于单测。
 */
export function framePageSnapshot(
  snapshotToolOutput: string,
  meta: { url: string; title: string },
): string {
  const { body, metrics } = splitSnapshotMetrics(snapshotToolOutput || '')
  const attrs: string[] = [`url="${escapeAttr(meta.url || '')}"`, `title="${escapeAttr(meta.title || '')}"`]
  if (metrics.nodeCount != null) attrs.push(`nodeCount="${metrics.nodeCount}"`)
  if (metrics.refCount != null) attrs.push(`refCount="${metrics.refCount}"`)
  if (metrics.truncated) attrs.push(`truncated="true"`)
  const open = `<page-snapshot ${attrs.join(' ')}>`
  // body 可能为空（空白页）；仍给出闭合标签，AI 据此知道页面无可交互元素。
  return body ? `${open}\n${body}\n</page-snapshot>` : `${open}\n</page-snapshot>`
}

/** 首轮的任务尾注：告诉 AI 用真实 ref 操作、用 piercode-tool/browser_batch 输出、完成给纯文本总结。 */
const FIRST_TURN_FOOTER =
  '请基于上面快照中真实存在的元素 ref（e0/e1/…）操作；用一个 piercode-tool 块输出 browser_* 工具，' +
  '可用 browser_batch 串联多步。完成后输出不含工具块的自然语言总结作为收尾信号。'

/** 后续轮的尾注：基于新快照继续，或完成时输出无工具块的总结。 */
const LATER_TURN_FOOTER = '继续：基于新快照的 ref 操作，或在完成时输出不含工具块的总结。'

/**
 * composeTurnPrompt 拼出实际写进 AI composer 的 BROWSER_AGENT_INJECT.prompt。
 * - 首轮（firstTurn=true）：profilePrefix（browser-agent prompt，只取一次）+ 快照 + "任务：" + 尾注。
 *   body 此时是用户原始任务文本。
 * - 后续轮：快照 + "上一步结果：" + body（formatToolResults 渲染的执行结果）+ 继续尾注。
 * 纯函数。
 */
export function composeTurnPrompt(opts: {
  snapshot: string
  body: string
  firstTurn: boolean
  profilePrefix?: string
}): string {
  const { snapshot, body, firstTurn, profilePrefix } = opts
  if (firstTurn) {
    const parts: string[] = []
    const prefix = (profilePrefix || '').trim()
    if (prefix) parts.push(prefix)
    parts.push(snapshot)
    parts.push(`任务：${body.trim()}\n${FIRST_TURN_FOOTER}`)
    return parts.join('\n\n')
  }
  return [snapshot, `上一步结果：\n${body}`, LATER_TURN_FOOTER].join('\n\n')
}

/**
 * buildPageSnapshot 取被操作 tab 的页面快照，组装成 <page-snapshot> 文本。
 * - text 模式（默认）：调 browser_snapshot（a11y ref 树）。
 * - som 模式：调 browser_screenshot{attach:true}（图传到 composer）+ browser_mark（数字编号），
 *   body 用 browser_mark 的数字索引（"[1] button \"登录\" @ 412,288"），并提示截图已作为附件上传，
 *   点击改用 browser_click {mark:<n>}。
 * 一切经传入的 exec（无直接 CDP），快照失败回 { ok:false, text:<错误信息> } 让上层回报 AI。
 */
export async function buildPageSnapshot(
  exec: SnapshotExec,
  opts: { tabId: number | null; url?: string; title?: string; mode?: 'text' | 'som' },
): Promise<{ ok: boolean; text: string }> {
  const tabArg: Record<string, unknown> = {}
  if (opts.tabId != null) tabArg.tabId = opts.tabId
  const meta = { url: opts.url || '', title: opts.title || '' }

  if (opts.mode === 'som') {
    // 先截图并附到 composer，再叠数字编号。截图失败不阻断（编号文本仍可用）。
    const shot = await exec('browser_screenshot', { ...tabArg, attach: true })
    const mark = await exec('browser_mark', { ...tabArg })
    if (!mark.success) {
      return { ok: false, text: `快照失败（browser_mark）：${mark.output}` }
    }
    const attrs = `url="${escapeAttr(meta.url)}" title="${escapeAttr(meta.title)}" mode="som"`
    const note = shot.success
      ? '（截图已作为附件上传到本对话；点击用 browser_click {mark:<n>}）'
      : '（截图上传失败，仍可按下列编号用 browser_click {mark:<n>}）'
    const body = (mark.output || '').replace(/\s+$/, '')
    return { ok: true, text: `<page-snapshot ${attrs}>\n${body}\n</page-snapshot>\n${note}` }
  }

  const snap = await exec('browser_snapshot', { ...tabArg })
  if (!snap.success) {
    return { ok: false, text: `快照失败（browser_snapshot）：${snap.output}` }
  }
  return { ok: true, text: framePageSnapshot(snap.output, meta) }
}
