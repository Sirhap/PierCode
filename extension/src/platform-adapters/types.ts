import type { CompletionObservation } from './completion';

export interface PlatformAdapter {
  name: string;
  // 检测当前页面是否匹配该平台。
  match: () => boolean;
  // 从 DOM 元素中提取文本，处理平台特定的代码块渲染。
  extractText: (el: Element, buf: string[]) => boolean;
  // 获取响应容器的选择器。
  responseSelector: string;
  // 用户消息容器选择器，供面板扫描会话计 token。未配置时只算 assistant 响应。
  userSelector?: string;
  // 服务端提示词/tools/skills profile。未配置时使用适配器名，服务端未知则回退 default。
  profile?: string;
  // 该平台"新建对话"的 URL，用于压缩后把上下文迁移到新会话。
  // 未实现时回退 host 根路径（见 getAdapterNewSessionUrl）。
  newSessionUrl?: () => string;
  // #15 完成检测（可选）。仅在历史上误判流式结束的平台上挂载（qwen/chatgpt/
  // mimo/aistudio/chatz 等 stop 态歧义站点）。调用方传入它已知的 stopVisible
  // （来自 content 的 PLATFORM_SELECTORS stop 选择器），本方法只负责"stop 消失 +
  // 文本沉降 + 签名去重"的时序判定，返回本次观察是否使该回合刚好判为完成。
  // 各 adapter 保留自己的选择器知识；时序逻辑集中在 ./completion 共享状态机。
  detectComplete?: (obs: CompletionObservation, now?: number) => boolean;
  // 重置完成检测状态（如会话切换）。挂了 detectComplete 的 adapter 才会提供。
  resetCompletion?: () => void;
}

// CompletionObservation re-exported via the adapter type so callers (content) can
// import a single module. Defined in ./completion (the pure timing state machine).
export type { CompletionObservation } from './completion';

export interface ExtractedCodeText {
  text: string;
  hasOverflow: boolean;
}

export function getAdapterProfileName(adapter: Pick<PlatformAdapter, 'name' | 'profile'>): string {
  const profile = adapter.profile?.trim();
  return profile || adapter.name;
}

// getAdapterNewSessionUrl 返回平台新会话 URL。适配器未实现时回退 host 根路径
// （多数 SPA 站点根路径即新对话）。
export function getAdapterNewSessionUrl(adapter: Pick<PlatformAdapter, 'newSessionUrl'>): string {
  if (adapter.newSessionUrl) {
    try {
      const url = adapter.newSessionUrl().trim();
      if (url) return url;
    } catch {
      // 落到默认
    }
  }
  return `${location.protocol}//${location.host}/`;
}
