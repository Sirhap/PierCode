export interface PlatformAdapter {
  name: string;
  // 检测当前页面是否匹配该平台。
  match: () => boolean;
  // 从 DOM 元素中提取文本，处理平台特定的代码块渲染。
  extractText: (el: Element, buf: string[]) => boolean;
  // 获取响应容器的选择器。
  responseSelector: string;
  // 服务端提示词/tools/skills profile。未配置时使用适配器名，服务端未知则回退 default。
  profile?: string;
  // 该平台"新建对话"的 URL，用于压缩后把上下文迁移到新会话。
  // 未实现时回退 host 根路径（见 getAdapterNewSessionUrl）。
  newSessionUrl?: () => string;
}

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
