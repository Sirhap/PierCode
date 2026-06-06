// Qwen 上下文压缩模块
// 触发条件: 可配置 tokens 阈值, 摘要限制可配置

import { QwenCompressionConfig, DEFAULT_QWEN_MAX_CONTEXT_TOKENS, DEFAULT_QWEN_MAX_SUMMARY_TOKENS } from './qwen-settings';

const TOKEN_ESTIMATE_RATIO = 4; // 粗略: 1 token ≈ 4 chars (英文/代码)

export interface ConversationContext {
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string; timestamp: number; sourceKey?: string }>;
  totalChars: number;
  lastCompressedAt: number;
}

export interface PierCodeContextPacket {
  attrs: Record<string, string>;
  content: string;
  raw: string;
}

// 渲染卡片用的结构化字段。模型自压缩包带 goal/pending/... ；本地摘要包只有
// context/instruction。缺失字段统一回退为空字符串/空数组，调用方按需隐藏空行。
export interface ContextPacketFields {
  reason: string;
  goal: string;
  current_state: string;
  next_action: string;
  context: string;
  instruction: string;
  completed: string[];
  key_concepts: string[];
  key_files: string[];
  errors_fixes: string[];
  problem_solving: string[];
  user_messages: string[];
  evidence: string[];
  pending: string[];
  constraints: string[];
}

const CONTEXT_PACKET_INNER_JSON_RE = /```(?:json)?\s*\n([\s\S]*?)\n```/i;

const CONTEXT_PACKET_RE = /<piercode_context_packet\b([^>]*)>([\s\S]*?)<\/piercode_context_packet>/i;
const CONTEXT_PACKET_ATTR_RE = /([a-zA-Z_:][\w:.-]*)\s*=\s*"([^"]*)"/g;
const CONTEXT_PACKET_FENCE_RE = /```piercode-context\s*\n([\s\S]*?)\n```/i;

// 简单 token 估算 (基于字符数, 非精确但足够用于阈值判断)
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // 英文/代码: ~4 chars/token, 中文: ~1.5 chars/token, 混合取平均 ~2.5
  const ascii = (text.match(/[\x00-\x7F]/g) || []).length;
  const nonAscii = text.length - ascii;
  return Math.ceil(ascii / TOKEN_ESTIMATE_RATIO + nonAscii / 1.5);
}

export function estimateContextTokens(ctx: ConversationContext): number {
  return ctx.messages.reduce((sum, msg) => sum + estimateTokens(msg.content), 0);
}

export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return trimFixed(n / 1_000_000, 2) + 'm';
  if (n >= 1_000) return trimFixed(n / 1_000, 1) + 'k';
  return String(n);
}

function trimFixed(n: number, digits: number): string {
  return n.toFixed(digits).replace(/\.0+$|(?<=[1-9])0+$/, '');
}

export function parsePierCodeContextPacket(text: string): PierCodeContextPacket | null {
  const fenceMatch = text.match(CONTEXT_PACKET_FENCE_RE);
  if (fenceMatch) {
    const content = fenceMatch[1].trim();
    const attrs: Record<string, string> = {};
    try {
      const packet = JSON.parse(content) as unknown;
      if (!packet || typeof packet !== 'object' || Array.isArray(packet)) return null;
      const packetObj = packet as Record<string, unknown>;
      if (packetObj.version !== undefined) attrs.version = String(packetObj.version);
      if (packetObj.reason !== undefined) attrs.reason = String(packetObj.reason);
    } catch {
      return null;
    }
    return {
      attrs,
      content,
      raw: fenceMatch[0].trim(),
    };
  }

  const match = text.match(CONTEXT_PACKET_RE);
  if (!match) return null;

  const attrs: Record<string, string> = {};
  const rawAttrs = match[1] || '';
  for (const attr of rawAttrs.matchAll(CONTEXT_PACKET_ATTR_RE)) {
    attrs[attr[1]] = attr[2];
  }

  return {
    attrs,
    content: match[2].trim(),
    raw: match[0].trim(),
  };
}

// 把已解析的 packet 拆成卡片字段。content 可能是裸 JSON（fence 路径）或被
// ```json 围栏包住（旧 XML 路径）。解析失败时返回全空字段而不抛错，让卡片至少
// 能显示 raw 文本兜底。
export function extractContextPacketFields(packet: PierCodeContextPacket): ContextPacketFields {
  const empty: ContextPacketFields = {
    reason: packet.attrs.reason || '',
    goal: '', current_state: '', next_action: '', context: '', instruction: '',
    completed: [], key_concepts: [], key_files: [], errors_fixes: [],
    problem_solving: [], user_messages: [], evidence: [], pending: [], constraints: [],
  };

  let jsonText = packet.content.trim();
  const innerFence = jsonText.match(CONTEXT_PACKET_INNER_JSON_RE);
  if (innerFence) jsonText = innerFence[1].trim();

  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(jsonText) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return empty;
    obj = parsed as Record<string, unknown>;
  } catch {
    return empty;
  }

  const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.map(item => (typeof item === 'string' ? item : JSON.stringify(item))) : [];

  return {
    reason: str(obj.reason) || empty.reason,
    goal: str(obj.goal),
    current_state: str(obj.current_state),
    next_action: str(obj.next_action),
    context: str(obj.context),
    instruction: str(obj.instruction),
    completed: arr(obj.completed),
    key_concepts: arr(obj.key_concepts),
    key_files: arr(obj.key_files),
    errors_fixes: arr(obj.errors_fixes),
    problem_solving: arr(obj.problem_solving),
    user_messages: arr(obj.user_messages),
    evidence: arr(obj.evidence),
    pending: arr(obj.pending),
    constraints: arr(obj.constraints),
  };
}

// NO_TOOLS 首部约束。借鉴 Claude Code：把"只输出文本、不调工具、工具调用会被拒绝"
// 放最前面且明确后果，能显著降低模型压缩时误调工具/写解释的概率。
const NO_TOOLS_PREAMBLE = [
  '【最高优先级】本回合只允许输出文本，不要调用任何工具。',
  '- 不要输出 `piercode-tool`，不要 Read/Bash/Grep/Edit/Write 或任何工具。',
  '- 你已经拥有压缩所需的全部上下文（就在上面的对话里）。',
  '- 工具调用会被拒绝并浪费你唯一的回合，导致任务失败。',
  '- 整个回复必须是纯文本：一个 <analysis> 块，后跟一个 `piercode-context` fenced JSON 块。',
].join('\n');

// NO_TOOLS 尾部约束（三明治结尾）。模型读到提示词末尾时再强化一次。
const NO_TOOLS_TRAILER = [
  '提醒：不要调用任何工具，只输出纯文本——先 <analysis> 块，再 `piercode-context` JSON 块。',
  '工具调用会被拒绝，你会失败。',
].join('\n');

// 逐条分析草稿指令。借鉴 Claude Code <analysis> 思路：让模型先按时间顺序逐条
// 复盘（草稿），再产出结构化包。<analysis> 在 fenced JSON 之外，
// parsePierCodeContextPacket 只取 fence，草稿自动不进新会话上下文。
const ANALYSIS_INSTRUCTION = [
  '先在 <analysis>...</analysis> 里逐条复盘整段对话（这是草稿，不会进入新会话）：',
  '1. 按时间顺序分析每条消息，识别：',
  '   - 用户的明确请求与意图',
  '   - 你的应对方式与关键决策、技术概念、代码模式',
  '   - 具体细节：文件名、完整代码片段、函数签名、文件改动',
  '   - 遇到的错误及修复方式',
  '   - 用户的明确反馈，尤其是要求你换做法的地方',
  '2. 复核技术准确性与完整性。',
].join('\n');

export function formatPierCodeContextPacketPrompt(ctx: ConversationContext, config: QwenCompressionConfig): string {
  const messageCount = ctx.messages.length;
  const estimatedTokens = estimateContextTokens(ctx);

  return [
    NO_TOOLS_PREAMBLE,
    '',
    'PierCode 上下文即将达到上限。请创建当前会话的详细压缩摘要，用于无缝迁移到一个全新的会话。',
    '务必详尽捕获技术细节、代码模式、架构决策，确保新会话不丢上下文即可继续开发。',
    '',
    ANALYSIS_INSTRUCTION,
    '',
    '然后只输出一个 `piercode-context` fenced JSON（不要解释、寒暄、Markdown 标题）。',
    'JSON 必须覆盖以下 9 段（映射到对应字段）：',
    '1. 主要请求与意图 → goal：用户所有明确请求和意图',
    '2. 关键技术概念 → key_concepts：涉及的技术、框架、概念',
    '3. 文件与代码 → key_files：检查/修改/创建的文件，含完整关键代码片段与为何重要',
    '4. 错误与修复 → errors_fixes：遇到的错误及修复方式，含用户相关反馈',
    '5. 问题求解 → problem_solving：已解决的问题与进行中的排查',
    '6. 全部用户消息 → user_messages：列出所有非工具结果的用户消息（理解意图变化的关键）',
    '7. 待办 → pending：被明确要求做的待办',
    '8. 当前工作 → current_state + completed：紧接本次压缩前在做什么、已完成且有证据的事项',
    '9. 下一步 → next_action：与用户最近明确请求一致的下一步，并引用最近对话原文防止偏移',
    '',
    '保留关键路径、错误信息、测试结果、用户明确偏好；删除重复日志和冗长工具输出。',
    '',
    `当前 PierCode 估算：${formatTokenCount(estimatedTokens)} tokens / 阈值 ${formatTokenCount(config.maxContextTokens)} tokens，消息数 ${messageCount}。`,
    '',
    '输出格式必须是：',
    '<analysis>',
    '（你的逐条复盘草稿，覆盖上述各点）',
    '</analysis>',
    '```piercode-context',
    '{',
    '  "version": 1,',
    '  "reason": "piercode_requested",',
    '  "goal": "用户所有明确请求和意图（成功标准）",',
    '  "key_concepts": ["关键技术概念/框架"],',
    '  "key_files": ["文件路径 + 为何重要 + 关键代码片段"],',
    '  "errors_fixes": ["错误描述 + 修复方式 + 用户反馈"],',
    '  "problem_solving": ["已解决的问题 + 进行中的排查"],',
    '  "user_messages": ["所有非工具结果的用户消息"],',
    '  "completed": ["已经完成且有证据的事项"],',
    '  "current_state": "当前会话/代码/浏览器状态",',
    '  "pending": ["下一步待办"],',
    '  "constraints": ["用户偏好、安全约束、不能丢的上下文"],',
    '  "next_action": "新会话接手后的第一步（引用最近对话原文）"',
    '}',
    '```',
    '',
    NO_TOOLS_TRAILER,
  ].filter(Boolean).join('\n');
}

// Packet handoff: 模型已输出成型的 ```piercode-context 围栏块，原样转发，
// 不再二次套壳（避免把结构化字段压成 context 字段里的转义字符串）。
// 仅用于"模型自压缩"路径；纯文本本地摘要走 formatQwenCompressedContextPrompt。
// 新会话 handoff 开场白。带 init 时强调分两段，避免把初始化和压缩上下文混成一团；
// 没有 init 时不提"运行说明"，免得空指引。
function handoffIntro(hasInit: boolean): string {
  return hasInit
    ? '这是一个由 PierCode 压缩并迁移过来的新会话。下面分两段：先是本会话的运行说明（初始化），再是上次会话的压缩上下文。请先读懂运行说明（工具协议/约束），再按压缩上下文里的 next_action / pending 继续执行。'
    : '这是一个由 PierCode 压缩并迁移过来的新会话。请从下面的压缩上下文继续，按其中的 next_action / pending 接续执行。';
}

// 把注入新会话的历史 packet 围栏语言名从 piercode-context 改成
// piercode-context-archived。防无限环：新会话若复读/回显该围栏，
// parsePierCodeContextPacket 只认 piercode-context，archived 不会被当成新压缩
// 信号，从而不会触发"再开新会话"。模型仍能读懂 archived 块内容。
export function archiveContextFence(text: string): string {
  return text.replace(/```piercode-context(?=\s*\n)/g, '```piercode-context-archived');
}

export function formatPacketHandoffPrompt(packetRaw: string, initPrompt = ''): string {
  const init = initPrompt.trim();
  // Init (tool protocol / run instructions) must come BEFORE the compressed
  // context: the model needs the operating contract loaded first, then the
  // task state to resume. Putting context first left the model without the
  // tool protocol when it tried to act on next_action.
  const parts: string[] = [handoffIntro(Boolean(init))];
  if (init) {
    parts.push(
      '',
      '===== 本会话运行说明（初始化）=====',
      init,
    );
  }
  parts.push(
    '',
    '===== 上次会话压缩上下文（按其中的 next_action / pending 接续执行）=====',
    archiveContextFence(packetRaw.trim()),
  );
  return parts.join('\n');
}

// 本地摘要兜底 handoff：摘要是给模型读的纯文本，直接原样发，不套 piercode-context
// JSON。早先套 JSON 会把摘要里的真换行经 JSON.stringify 转义成字面 "\n"，注入
// 新会话后人看到一坨 \n。纯文本直发保留真换行，可读。
export function formatQwenCompressedContextPrompt(summary: string, initPrompt = ''): string {
  const init = initPrompt.trim();
  // Same ordering rule as the packet handoff: init first, context after.
  const parts: string[] = [handoffIntro(Boolean(init))];
  if (init) {
    parts.push(
      '',
      '===== 本会话运行说明（初始化）=====',
      init,
    );
  }
  parts.push(
    '',
    '===== 上次会话压缩上下文 =====',
    summary.trim(),
  );
  return parts.join('\n');
}

// 生成摘要: 保留系统提示和最近上下文, 输出顺序保持原会话顺序。
export function generateSummary(ctx: ConversationContext, targetTokens = DEFAULT_QWEN_MAX_SUMMARY_TOKENS): string {
  if (ctx.messages.length === 0) return '';

  const parts: string[] = [];
  let accumulatedTokens = 0;

  const systemMsg = ctx.messages.find(m => m.role === 'system');
  if (systemMsg) {
    const truncated = truncateToTokens(systemMsg.content, Math.floor(targetTokens * 0.1));
    parts.push(`[系统] ${truncated}`);
    accumulatedTokens += estimateTokens(truncated);
  }

  const recentMessages = ctx.messages.filter(m => m.role !== 'system');
  const selected: string[] = [];
  for (let i = recentMessages.length - 1; i >= 0; i--) {
    if (accumulatedTokens >= targetTokens * 0.85) break;
    const msg = recentMessages[i];
    const remaining = Math.max(0, Math.floor(targetTokens * 0.9) - accumulatedTokens);
    if (remaining <= 0) break;
    const msgBudget = Math.max(128, Math.min(remaining, Math.floor(targetTokens * 0.2)));
    const part = `[${msg.role}] ${truncateToTokens(msg.content, msgBudget)}`;
    const partTokens = estimateTokens(part);
    if (partTokens > remaining && selected.length > 0) break;
    selected.unshift(part);
    accumulatedTokens += partTokens;
  }
  parts.push(...selected);

  const toolCalls = ctx.messages.filter(m => m.content.includes('piercode-tool'));
  if (toolCalls.length > 0) {
    const summary = `[工具调用摘要: ${toolCalls.length} 次, 最近: ${extractLastToolCall(toolCalls)}]`;
    if (accumulatedTokens + estimateTokens(summary) <= targetTokens) {
      parts.push(summary);
    }
  }

  return truncateToTokens(parts.join('\n\n'), targetTokens);
}

export function truncateToTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return '';
  if (estimateTokens(text) <= maxTokens) return text;

  const suffix = '... [已截断]';
  const suffixTokens = estimateTokens(suffix);
  const contentBudget = Math.max(1, maxTokens - suffixTokens);
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTokens(text.slice(0, mid)) <= contentBudget) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return text.slice(0, low) + suffix;
}

function extractLastToolCall(toolCalls: Array<{ content: string }>): string {
  if (toolCalls.length === 0) return '无';
  const last = toolCalls[toolCalls.length - 1].content;
  // 提取工具名
  const match = last.match(/"name"\s*:\s*"([^"]+)"/);
  return match ? match[1] : 'unknown';
}

// 检查是否需要压缩 (使用默认阈值, 实际调用方应传入配置)
export function shouldCompress(ctx: ConversationContext, maxTokens = DEFAULT_QWEN_MAX_CONTEXT_TOKENS): boolean {
  const tokens = estimateContextTokens(ctx);
  return tokens >= maxTokens;
}

// 执行压缩并返回新会话内容
export async function compressAndPrepareNewSession(
  ctx: ConversationContext,
  onSummaryGenerated: (summary: string) => void,
  config: QwenCompressionConfig = {
    enabled: true,
    maxContextTokens: DEFAULT_QWEN_MAX_CONTEXT_TOKENS,
    maxSummaryTokens: DEFAULT_QWEN_MAX_SUMMARY_TOKENS
  }
): Promise<{ summary: string; newContext: ConversationContext }> {
  if (!config.enabled) {
    return { summary: '', newContext: ctx };
  }

  const summary = generateSummary(ctx, config.maxSummaryTokens);
  onSummaryGenerated(summary);

  // 新会话以摘要开头, 保留最近少量消息作为上下文衔接
  const recentCount = Math.min(3, ctx.messages.filter(m => m.role !== 'system').length);
  const recentMessages = [...ctx.messages]
    .filter(m => m.role !== 'system')
    .slice(-recentCount)
    .map(m => ({ ...m, content: truncateToTokens(m.content, 2000) })); // 每条限制 2000 chars

  const newContext: ConversationContext = {
    messages: [
      { role: 'system', content: `[上下文已压缩] 摘要:\n\n${summary}`, timestamp: Date.now() },
      ...recentMessages
    ],
    totalChars: summary.length + recentMessages.reduce((s, m) => s + m.content.length, 0),
    lastCompressedAt: Date.now()
  };

  return { summary, newContext };
}

// 工具输出压缩: 用于回填到聊天界面的长结果截断
export function compactToolOutputForChat(output: string, maxChars = 100_000): { text: string; compacted: boolean } {
  if (output.length <= maxChars) return { text: output, compacted: false };

  const sections = splitToolSections(output);
  const budgetPerSection = Math.max(
    4_000,
    Math.floor((maxChars - 2_000) / Math.max(1, sections.length))
  );
  const compactedSections = sections.map(section => compactSection(section, budgetPerSection));
  const text = [
    `[PierCode] 工具结果过长，已自动压缩后回填。原始长度 ${output.length} 字符，压缩后保留每段开头、结尾和截断说明。`,
    '',
    ...compactedSections
  ].join('\n\n');

  if (text.length <= maxChars) return { text, compacted: true };
  return {
    text: text.slice(0, maxChars - 80) + `\n\n... [压缩结果仍过长，已截断 ${text.length - maxChars + 80} 字符]`,
    compacted: true
  };
}

function splitToolSections(output: string): string[] {
  const marker = /^### .+ #.+$/gm;
  const matches = Array.from(output.matchAll(marker));
  if (matches.length === 0) return [output];

  const sections: string[] = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index ?? 0;
    const end = i + 1 < matches.length ? matches[i + 1].index ?? output.length : output.length;
    sections.push(output.slice(start, end).trim());
  }
  return sections.filter(Boolean);
}

function compactSection(section: string, budget: number): string {
  if (section.length <= budget) return section;

  const lines = section.split('\n');
  const heading = lines[0]?.startsWith('### ') ? lines[0] : '';
  const body = heading ? lines.slice(1).join('\n') : section;
  const bodyBudget = Math.max(1_000, budget - heading.length - 200);
  const headChars = Math.min(8_000, Math.floor(bodyBudget * 0.75));
  const tailChars = Math.min(2_000, Math.max(500, bodyBudget - headChars));
  const omitted = Math.max(0, body.length - headChars - tailChars);
  const compactedBody = [
    body.slice(0, headChars).trimEnd(),
    `\n... [已省略 ${omitted} 字符，原始工具结果过长] ...\n`,
    body.slice(Math.max(headChars, body.length - tailChars)).trimStart()
  ].join('');

  return heading ? `${heading}\n${compactedBody}` : compactedBody;
}
