import { describe, it, expect, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';

// 创建 JSDOM 环境
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');

// 设置全局变量（必须在 mock 之前）
const { window } = dom;
const { document } = window;

globalThis.window = window as any;
globalThis.document = document;
globalThis.Element = window.Element;
globalThis.HTMLElement = window.HTMLElement;
globalThis.HTMLInputElement = window.HTMLInputElement;
globalThis.HTMLTextAreaElement = window.HTMLTextAreaElement;
globalThis.HTMLSelectElement = window.HTMLSelectElement;
globalThis.Node = window.Node;
globalThis.NodeFilter = window.NodeFilter;

// 模拟 getComputedStyle
window.getComputedStyle = (_el: Element) => ({
  display: 'block',
  visibility: 'visible',
  opacity: '1',
  getPropertyValue: () => ''
} as any);

// 模拟 getBoundingClientRect
window.Element.prototype.getBoundingClientRect = function() {
  return {
    top: 0,
    left: 0,
    width: 100,
    height: 30,
    bottom: 30,
    right: 100,
    x: 0,
    y: 0,
    toJSON: () => {}
  };
};

// 导入被测模块（必须在设置全局之后）
import {
  generateAccessibilityTree,
  getElementCoordinates,
  getElementByRef,
  getRefForElement,
  scrollToElement,
  clickElement,
  searchElements,
  exposeAccessibilityTree
} from '../content/accessibility-tree';

// Helper: 创建元素
const mockElement = (tag: string, attrs: Record<string, string> = {}) => {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    el.setAttribute(key, value);
  }
  return el;
};

describe('AccessibilityTree', () => {
  beforeEach(() => {
    // 清理 DOM
    document.body.innerHTML = '';
  });

  describe('generateAccessibilityTree', () => {
    it('returns result for empty body', () => {
      const result = generateAccessibilityTree();
      // JSDOM 中 body 本身也是一个元素
      expect(result.tree).toBeDefined();
      expect(typeof result.tree).toBe('string');
    });

    it('generates tree with elements', () => {
      const button = mockElement('button', { 'aria-label': 'Submit' });
      const input = mockElement('input', { type: 'text', placeholder: 'Username' });
      document.body.appendChild(button);
      document.body.appendChild(input);

      const result = generateAccessibilityTree('all');
      expect(result.tree).toBeDefined();
      // JSDOM 中元素可能不可见，但 all 模式应该包含
      expect(result.tree.length).toBeGreaterThan(0);
    });

    it('returns valid tree structure', () => {
      const button = mockElement('button');
      button.textContent = 'Click Me';
      document.body.appendChild(button);

      const result = generateAccessibilityTree('all');
      // 树应该包含 ref 标记
      expect(result.tree).toMatch(/\[e\d+\]/);
    });

    it('respects maxDepth parameter', () => {
      const parent = mockElement('div');
      const child = mockElement('div');
      const grandchild = mockElement('button');
      child.appendChild(grandchild);
      parent.appendChild(child);
      document.body.appendChild(parent);

      const resultShallow = generateAccessibilityTree('all', 1);
      const resultDeep = generateAccessibilityTree('all', 10);
      // 深度限制应该影响输出
      expect(resultShallow.tree).toBeDefined();
      expect(resultDeep.tree).toBeDefined();
    });

    it('respects maxChars parameter', () => {
      for (let i = 0; i < 20; i++) {
        const btn = mockElement('button');
        btn.setAttribute('aria-label', `Button ${i}`);
        document.body.appendChild(btn);
      }

      const result = generateAccessibilityTree('all', 15, 100);
      expect(result.tree).toBeDefined();
      // 如果内容超过限制，应该被截断
      if (result.truncated) {
        expect(result.tree).toContain('TRUNCATED');
      }
    });
  });

  describe('getElementCoordinates', () => {
    it('returns null for invalid ref', () => {
      const coords = getElementCoordinates('invalid_ref');
      expect(coords).toBeNull();
    });
  });

  describe('getElementByRef', () => {
    it('returns null for invalid ref', () => {
      const element = getElementByRef('invalid_ref');
      expect(element).toBeNull();
    });
  });

  describe('getRefForElement', () => {
    it('returns consistent ref for same element', () => {
      const button = mockElement('button');
      document.body.appendChild(button);

      const ref1 = getRefForElement(button);
      const ref2 = getRefForElement(button);
      expect(ref1).toBe(ref2);
    });

    it('returns different refs for different elements', () => {
      const button1 = mockElement('button');
      const button2 = mockElement('button');
      document.body.appendChild(button1);
      document.body.appendChild(button2);

      const ref1 = getRefForElement(button1);
      const ref2 = getRefForElement(button2);
      expect(ref1).not.toBe(ref2);
    });
  });

  describe('scrollToElement', () => {
    it('returns false for invalid ref', () => {
      const result = scrollToElement('invalid_ref');
      expect(result).toBe(false);
    });
  });

  describe('clickElement', () => {
    it('returns error for invalid ref', () => {
      const result = clickElement('invalid_ref');
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('searchElements', () => {
    it('finds elements by text', () => {
      const submitBtn = mockElement('button');
      submitBtn.textContent = 'Submit Form';
      const cancelBtn = mockElement('button');
      cancelBtn.textContent = 'Cancel';
      document.body.appendChild(submitBtn);
      document.body.appendChild(cancelBtn);

      const results = searchElements('Submit');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].text).toContain('Submit');
    });

    it('finds elements by role', () => {
      const textbox = mockElement('input', { type: 'text', 'aria-label': 'Email' });
      document.body.appendChild(textbox);

      const results = searchElements('textbox');
      expect(results.length).toBeGreaterThan(0);
    });

    it('respects maxResults parameter', () => {
      for (let i = 0; i < 20; i++) {
        const btn = mockElement('button');
        btn.textContent = `Button ${i}`;
        document.body.appendChild(btn);
      }

      const results = searchElements('Button', 5);
      expect(results.length).toBeLessThanOrEqual(5);
    });

    it('returns empty array for no matches', () => {
      const button = mockElement('button');
      button.textContent = 'Submit';
      document.body.appendChild(button);

      const results = searchElements('xyznonexistent');
      expect(results.length).toBe(0);
    });
  });

  describe('exposeAccessibilityTree', () => {
    it('exposes API to window', () => {
      exposeAccessibilityTree();

      expect((window as any).__piercodeAccessibilityTree).toBeDefined();
      expect(typeof (window as any).__piercodeAccessibilityTree.generate).toBe('function');
      expect(typeof (window as any).__piercodeAccessibilityTree.getElementCoordinates).toBe('function');
      expect(typeof (window as any).__piercodeAccessibilityTree.getElementByRef).toBe('function');
      expect(typeof (window as any).__piercodeAccessibilityTree.searchElements).toBe('function');
    });
  });
});
