/**
 * PierCode 无障碍树模块
 * 借鉴自 QoderWork 的 accessibility-tree 设计
 * 为 AI 提供结构化的页面理解能力，支持 ref 引用系统
 */

interface AccessibilityNode {
  ref: string;
  role: string;
  name: string;
  element: HTMLElement;
  children: AccessibilityNode[];
  depth: number;
  bounds: DOMRect;
  isVisible: boolean;
  isInteractive: boolean;
  states: string[];
}

interface AccessibilityTreeResult {
  tree: string;
  elementCount: number;
  truncated: boolean;
  refMap: Map<string, HTMLElement>;
}

interface ElementCoordinates {
  x: number;
  y: number;
  width: number;
  height: number;
}

const refMap = new Map<string, HTMLElement>();
let refCounter = 1;
let lastCleanupCounter = 0;

// 清理已脱离 DOM 的元素引用。
function cleanupRefMap(): void {
  for (const [ref, element] of refMap.entries()) {
    if (!element.isConnected) {
      refMap.delete(ref);
    }
  }
  lastCleanupCounter = refCounter;
}

// maybeCleanupRefMap triggers cleanup on a counter DELTA (not refCounter % 100,
// which a single call adding many refs can jump past, skipping cleanup forever)
// or when the map grows large — so detached SPA elements don't leak.
function maybeCleanupRefMap(): void {
  if (refCounter - lastCleanupCounter >= 100 || refMap.size > 500) {
    cleanupRefMap();
  }
}

// 获取元素的 ARIA role
function getRole(element: HTMLElement): string {
  const explicitRole = element.getAttribute('role');
  if (explicitRole) return explicitRole;

  const tag = element.tagName.toLowerCase();
  const inputType = (element as HTMLInputElement).type?.toLowerCase();

  switch (tag) {
    case 'a':
      return element.hasAttribute('href') ? 'link' : 'generic';
    case 'button':
      return 'button';
    case 'input':
      switch (inputType) {
        case 'text':
        case 'email':
        case 'password':
        case 'search':
        case 'tel':
        case 'url':
          return 'textbox';
        case 'checkbox':
          return 'checkbox';
        case 'radio':
          return 'radio';
        case 'range':
          return 'slider';
        case 'number':
          return 'spinbutton';
        case 'file':
          return 'button';
        case 'submit':
        case 'reset':
          return 'button';
        default:
          return 'textbox';
      }
    case 'select':
      return 'combobox';
    case 'textarea':
      return 'textbox';
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return 'heading';
    case 'img':
      return 'image';
    case 'ul':
    case 'ol':
      return 'list';
    case 'li':
      return 'listitem';
    case 'table':
      return 'table';
    case 'tr':
      return 'row';
    case 'td':
    case 'th':
      return 'cell';
    case 'form':
      return 'form';
    case 'nav':
      return 'navigation';
    case 'main':
      return 'main';
    case 'article':
      return 'article';
    case 'header':
      return 'header';
    case 'footer':
      return 'footer';
    case 'dialog':
      return 'dialog';
    case 'alert':
      return 'alert';
    case 'status':
      return 'status';
    default:
      // 检查是否有交互事件
      if (element.onclick || element.onmousedown || element.onmouseup) {
        return 'button';
      }
      return '';
  }
}

// 获取元素的可访问名称
function getName(element: HTMLElement): string {
  // aria-label 优先
  const ariaLabel = element.getAttribute('aria-label');
  if (ariaLabel) return ariaLabel.trim();

  // aria-labelledby 是空格分隔的 IDREF 列表：逐个解析再拼接，getElementById
  // 只能匹配单个 id，整串传入会对多 id 形式（"id1 id2"）返回 null 丢失名称。
  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy) {
    const name = labelledBy
      .split(/\s+/)
      .filter(Boolean)
      .map(id => document.getElementById(id)?.textContent?.trim())
      .filter(Boolean)
      .join(' ')
      .trim();
    if (name) return name.slice(0, 100);
  }

  // title 属性
  const title = element.getAttribute('title');
  if (title) return title.trim();

  // placeholder
  const placeholder = (element as HTMLInputElement).placeholder;
  if (placeholder) return placeholder.trim().slice(0, 100);

  // 特定元素的文本内容
  const tag = element.tagName;
  if (tag === 'BUTTON' || tag === 'A' || ['H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(tag)) {
    return element.textContent?.trim().slice(0, 100) || '';
  }

  // label 元素
  if (tag === 'LABEL' && (element as HTMLLabelElement).control) {
    return element.textContent?.trim().slice(0, 100) || '';
  }

  // img 的 alt
  if (tag === 'IMG') {
    return (element as HTMLImageElement).alt?.trim().slice(0, 100) || '';
  }

  // 特定 role 的文本内容
  const role = element.getAttribute('role');
  if (role && ['heading', 'listitem', 'article', 'status', 'alert', 'tooltip'].includes(role)) {
    return element.textContent?.trim().slice(0, 100) || '';
  }

  return '';
}

// 判断是否是交互元素
function isInteractive(element: HTMLElement): boolean {
  const role = getRole(element);
  const interactiveRoles = [
    'button', 'link', 'textbox', 'searchbox', 'combobox',
    'checkbox', 'radio', 'slider', 'spinbutton',
    'menuitem', 'menuitemcheckbox', 'menuitemradio',
    'option', 'tab', 'switch', 'scrollbar'
  ];

  if (interactiveRoles.includes(role)) return true;

  // 检查原生交互元素
  const tag = element.tagName.toLowerCase();
  if (['a', 'button', 'input', 'select', 'textarea'].includes(tag)) return true;

  // 检查是否有 tabindex
  const tabIndex = element.getAttribute('tabindex');
  if (tabIndex && parseInt(tabIndex) >= 0) return true;

  // 检查 contenteditable
  if (element.isContentEditable) return true;

  return false;
}

// 判断元素是否可见
function isVisible(element: HTMLElement): boolean {
  const style = window.getComputedStyle(element);

  if (style.display === 'none') return false;
  if (style.visibility === 'hidden') return false;
  if (style.opacity === '0') return false;

  const rect = element.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;

  return true;
}

// 获取元素状态
function getStates(element: HTMLElement): string[] {
  const states: string[] = [];

  if (element.hasAttribute('disabled')) states.push('disabled');
  if (element.hasAttribute('readonly')) states.push('readonly');
  if (element.hasAttribute('required')) states.push('required');

  // checkbox/radio 状态
  if ((element as HTMLInputElement).checked !== undefined) {
    states.push((element as HTMLInputElement).checked ? 'checked' : 'unchecked');
  }

  // 展开/折叠状态
  const expanded = element.getAttribute('aria-expanded');
  if (expanded === 'true') states.push('expanded');
  else if (expanded === 'false') states.push('collapsed');

  // 选中状态
  const selected = element.getAttribute('aria-selected');
  if (selected === 'true') states.push('selected');

  // 当前状态
  const current = element.getAttribute('aria-current');
  if (current) states.push(`current-${current}`);

  return states;
}

// 为元素分配 ref
function assignRef(element: HTMLElement): string {
  // 检查是否已有 ref
  for (const [ref, existing] of refMap.entries()) {
    if (existing === element) return ref;
  }

  const ref = `e${refCounter++}`;
  refMap.set(ref, element);
  return ref;
}

// 构建无障碍树
function buildTree(
  element: HTMLElement,
  depth: number,
  maxDepth: number,
  filter: 'interactive' | 'all'
): AccessibilityNode | null {
  if (depth > maxDepth) return null;
  if (!isVisible(element) && filter !== 'all') return null;

  const role = getRole(element);
  const name = getName(element);
  const interactive = isInteractive(element);
  const states = getStates(element);
  const bounds = element.getBoundingClientRect();

  // 如果是 interactive 模式，只保留交互元素和有意义的元素
  if (filter === 'interactive' && !interactive && !role && !name) {
    return null;
  }

  const ref = assignRef(element);

  const children: AccessibilityNode[] = [];
  for (const child of Array.from(element.children)) {
    const childNode = buildTree(child as HTMLElement, depth + 1, maxDepth, filter);
    if (childNode) children.push(childNode);
  }

  // 如果是 interactive 模式且没有子节点，且自身不是交互元素，跳过
  if (filter === 'interactive' && children.length === 0 && !interactive && !name) {
    return null;
  }

  return {
    ref,
    role,
    name,
    element,
    children,
    depth,
    bounds,
    isVisible: isVisible(element),
    isInteractive: interactive,
    states
  };
}

// 格式化树为文本
function formatTree(node: AccessibilityNode, indent: number = 0): string {
  const prefix = '  '.repeat(Math.min(indent, 10));
  let line = `[${node.ref}]`;

  if (node.role) line += ` ${node.role}`;
  if (node.name) line += ` "${node.name}"`;

  const stateStr = node.states.join(', ');
  if (stateStr) line += ` (${stateStr})`;

  const parts = [`${prefix}${line}`];

  for (const child of node.children) {
    parts.push(formatTree(child, indent + 1));
  }

  return parts.join('\n');
}

// 主函数：生成无障碍树
export function generateAccessibilityTree(
  filter: 'interactive' | 'all' = 'interactive',
  maxDepth: number = 15,
  maxChars: number = 50000,
  refId?: string
): AccessibilityTreeResult {
  // 定期清理 refMap（按计数增量/容量触发，避免跳过 100 的倍数后永不清理）
  maybeCleanupRefMap();

  let rootElement: HTMLElement;

  if (refId) {
    rootElement = refMap.get(refId) || document.body;
  } else {
    rootElement = document.body;
  }

  if (!rootElement) {
    return { tree: '(empty page)', elementCount: 0, truncated: false, refMap };
  }

  const rootNode = buildTree(rootElement, 0, maxDepth, filter);

  if (!rootNode) {
    return { tree: '(no elements found)', elementCount: 0, truncated: false, refMap };
  }

  let treeText = formatTree(rootNode);
  let truncated = false;

  if (treeText.length > maxChars) {
    treeText = treeText.slice(0, maxChars) + '\n[TRUNCATED: output limit reached]';
    truncated = true;
  }

  return {
    tree: treeText,
    elementCount: refMap.size,
    truncated,
    refMap
  };
}

// 获取元素坐标（中心点）
export function getElementCoordinates(ref: string): ElementCoordinates | null {
  const element = refMap.get(ref);

  if (!element) return null;

  const rect = element.getBoundingClientRect();
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    width: rect.width,
    height: rect.height
  };
}

// 通过 ref 获取元素
export function getElementByRef(ref: string): HTMLElement | null {
  return refMap.get(ref) || null;
}

// 为现有元素获取或创建 ref
export function getRefForElement(element: HTMLElement): string {
  return assignRef(element);
}

// 滚动元素到视图
export function scrollToElement(ref: string): boolean {
  const element = getElementByRef(ref);
  if (!element) return false;

  element.scrollIntoView({
    behavior: 'smooth',
    block: 'center',
    inline: 'nearest'
  });

  return true;
}

// 点击元素
export function clickElement(ref: string): { success: boolean; error?: string } {
  const element = getElementByRef(ref);
  if (!element) {
    return { success: false, error: `Element not found: ${ref}` };
  }

  try {
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    element.click();
    return { success: true };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

// 获取元素的边界框
export function getElementBounds(ref: string): { x: number; y: number; width: number; height: number } | null {
  const element = getElementByRef(ref);
  if (!element) return null;

  const rect = element.getBoundingClientRect();
  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height
  };
}

// 搜索元素
export function searchElements(query: string, maxResults: number = 20): Array<{
  ref: string;
  role: string;
  text: string;
  score: number;
}> {
  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 0);
  const results: Array<{ ref: string; role: string; text: string; score: number }> = [];

  // document.body 可能尚不存在（document_start / 无 body 的文档），createTreeWalker(null)
  // 会抛 TypeError；提前返回空结果（与 generateAccessibilityTree 的守卫一致）。
  if (!document.body) return results;
  // 此路径独立于 generateAccessibilityTree，也要触发 refMap 清理，避免泄漏。
  maybeCleanupRefMap();

  // 遍历所有元素
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_ELEMENT,
    null
  );

  let node: Node | null;
  while ((node = walker.nextNode())) {
    const element = node as HTMLElement;
    const role = getRole(element);
    const name = getName(element) || element.textContent?.trim().slice(0, 100) || '';

    let score = 0;
    const lowerName = name.toLowerCase();
    const lowerRole = role.toLowerCase();

    for (const term of terms) {
      if (lowerName.includes(term)) score += 3;
      if (lowerRole.includes(term)) score += 2;
      if ((element.textContent?.toLowerCase() || '').includes(term)) score += 1;
    }

    if (score > 0) {
      const ref = getRefForElement(element);
      results.push({ ref, role, text: name || role, score });
    }
  }

  // 按分数排序，取前 N 个
  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}

// 暴露到全局供 content script 调用
export function exposeAccessibilityTree(): void {
  (window as any).__piercodeAccessibilityTree = {
    generate: generateAccessibilityTree,
    getElementCoordinates,
    getElementByRef,
    getRefForElement,
    scrollToElement,
    clickElement,
    getElementBounds,
    searchElements,
    refMap,
    get elementCount() {
      return refMap.size;
    }
  };
}
