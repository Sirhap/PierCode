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
}

export interface ExtractedCodeText {
  text: string;
  hasOverflow: boolean;
}

export function getAdapterProfileName(adapter: Pick<PlatformAdapter, 'name' | 'profile'>): string {
  const profile = adapter.profile?.trim();
  return profile || adapter.name;
}
