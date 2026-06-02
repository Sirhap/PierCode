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

export interface QwenCompressedContextHandoff {
  version: number;
  reason: 'compressed_context_handoff';
  context: string;
  instruction: string;
}

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

export function formatPierCodeContextPacketPrompt(ctx: ConversationContext, config: QwenCompressionConfig): string {
  const messageCount = ctx.messages.length;
  const estimatedTokens = estimateContextTokens(ctx);
  const lastUser = [...ctx.messages].reverse().find(m => m.role === 'user')?.content.trim();

  return [
    'PierCode 上下文即将达到上限。请压缩当前会话上下文，用于迁移到新的 Qwen 会话。',
    '',
    '必须严格遵守：',
    '1. 只输出一个 Markdown fenced JSON block，语言名必须是 `piercode-context`；不要输出解释、寒暄或 Markdown 标题。',
    '2. 不要输出 `piercode-tool`，不要调用任何工具，不要继续执行原任务。',
    '3. JSON 内容要足够让新会话无缝继续：version、reason、目标、已完成、当前状态、关键文件/命令/测试、待办、约束、下一步。',
    '4. 保留关键路径、错误信息、测试结果、用户明确偏好；删除重复日志和冗长工具输出。',
    '',
    `当前 PierCode 估算：${estimatedTokens} tokens / 阈值 ${config.maxContextTokens} tokens，消息数 ${messageCount}。`,
    lastUser ? `最近用户输入摘要：${truncateToTokens(lastUser, 512)}` : '',
    '',
    '输出格式必须是：',
    '```piercode-context',
    '{',
    '  "version": 1,',
    '  "reason": "piercode_requested",',
    '  "goal": "当前用户目标和成功标准",',
    '  "completed": ["已经完成且有证据的事项"],',
    '  "current_state": "当前会话/代码/浏览器状态",',
    '  "key_files": ["关键文件绝对路径或仓库相对路径"],',
    '  "evidence": ["关键命令、测试结果、浏览器观察结果"],',
    '  "pending": ["下一步待办"],',
    '  "constraints": ["用户偏好、安全约束、不能丢的上下文"],',
    '  "next_action": "新会话接手后的第一步"',
    '}',
    '```',
  ].filter(Boolean).join('\n');
}

// Packet handoff: 模型已输出成型的 ```piercode-context 围栏块，原样转发，
// 不再二次套壳（避免把结构化字段压成 context 字段里的转义字符串）。
// 仅用于"模型自压缩"路径；纯文本本地摘要走 formatQwenCompressedContextPrompt。
export function formatPacketHandoffPrompt(packetRaw: string, initPrompt = ''): string {
  return [
    '请从下面的 PierCode 压缩上下文继续当前会话，按其中的 next_action / pending 接续执行。',
    '',
    packetRaw.trim(),
    initPrompt.trim() ? '\n\n---\n' : '',
    initPrompt.trim(),
  ].filter(part => part !== '').join('\n');
}

export function formatQwenCompressedContextPrompt(summary: string, initPrompt = ''): string {
  const contextPayload: QwenCompressedContextHandoff = {
    version: 1,
    reason: 'compressed_context_handoff',
    context: summary.trim(),
    instruction: '继续执行用户后续任务。'
  };
  return [
    '请从下面的 PierCode 压缩上下文继续当前会话。',
    '',
    '```piercode-context',
    JSON.stringify(contextPayload, null, 2),
    '```',
    initPrompt.trim() ? '\n\n---\n' : '',
    initPrompt.trim(),
  ].filter(part => part !== '').join('\n');
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
