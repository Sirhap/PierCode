import { aiStudioAdapter } from './platform-adapters/aistudio';
import { chatGPTAdapter } from './platform-adapters/chatgpt';
import { chatZAdapter } from './platform-adapters/chatz';
import { claudeAdapter } from './platform-adapters/claude';
import { defaultAdapter } from './platform-adapters/default';
import { geminiAdapter } from './platform-adapters/gemini';
import { kimiAdapter } from './platform-adapters/kimi';
import { mimoAdapter } from './platform-adapters/mimo';
import { qwenAdapter } from './platform-adapters/qwen';
import type { PlatformAdapter } from './platform-adapters/types';

export type { ExtractedCodeText, PlatformAdapter } from './platform-adapters/types';
export { getAdapterProfileName, getAdapterNewSessionUrl } from './platform-adapters/types';
export { extractCodeMirror6Text, extractMonacoText } from './platform-adapters/shared';
export { aiStudioAdapter } from './platform-adapters/aistudio';
export { chatGPTAdapter } from './platform-adapters/chatgpt';
export { chatZAdapter } from './platform-adapters/chatz';
export { claudeAdapter } from './platform-adapters/claude';
export { defaultAdapter } from './platform-adapters/default';
export { geminiAdapter } from './platform-adapters/gemini';
export { kimiAdapter } from './platform-adapters/kimi';
export { mimoAdapter } from './platform-adapters/mimo';
export { findQwenToolBody, qwenAdapter } from './platform-adapters/qwen';

// 按优先级排序的适配器列表；default 必须最后匹配。
export const platformAdapters: PlatformAdapter[] = [
  kimiAdapter,
  qwenAdapter,
  chatZAdapter,
  claudeAdapter,
  chatGPTAdapter,
  geminiAdapter,
  aiStudioAdapter,
  mimoAdapter,
  defaultAdapter
];

export function getPlatformAdapter(): PlatformAdapter {
  for (const adapter of platformAdapters) {
    if (adapter.match()) {
      console.log(`[PierCode] 使用 ${adapter.name} 平台适配器`);
      return adapter;
    }
  }
  return defaultAdapter;
}
