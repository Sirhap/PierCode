import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

declare const require: any;

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const JSDOMWithOptions: any = JSDOM;

const extensionRoot = path.resolve(new URL('../..', import.meta.url).pathname);
const configureHTMLPath = path.join(extensionRoot, 'public/configure.html');
const configureScriptPath = path.join(extensionRoot, 'public/configure.js');

describe('extension configure page', () => {
  it('uses an external script so Manifest V3 CSP permits it', () => {
    const html = fs.readFileSync(configureHTMLPath, 'utf8');
    const dom = new JSDOM(html);
    const scripts = [...dom.window.document.querySelectorAll('script')];

    expect(scripts).toHaveLength(1);
    expect(scripts[0].getAttribute('src')).toBe('configure.js');
    expect(scripts[0].textContent?.trim()).toBe('');
  });

  it('stores api url and token from realistic extension configuration link', () => {
    const script = fs.readFileSync(configureScriptPath, 'utf8');
    const dom = new JSDOMWithOptions('<!doctype html><div id="status">Configuring...</div>', {
      url: 'chrome-extension://piercode/configure.html?apiUrl=http%3A%2F%2F127.0.0.1%3A39527&token=dev-token'
    });
    const set: any = vi.fn((_values: unknown, callback: () => void) => callback());

    Object.assign(dom.window, {
      chrome: {
        storage: {
          local: { set }
        }
      }
    });

    vm.createContext(dom.window);
    vm.runInContext(script, dom.window);

    expect(set).toHaveBeenCalledWith(
      { apiUrl: 'http://127.0.0.1:39527', authToken: 'dev-token' },
      expect.any(Function)
    );
    expect(dom.window.document.getElementById('status')?.textContent).toBe('Configured: http://127.0.0.1:39527');
    expect((dom.window as any).__PIERCODE_CONFIG_DONE__).toBe(true);
  });

  it('shows a clear status when the configuration link is incomplete', () => {
    const script = fs.readFileSync(configureScriptPath, 'utf8');
    const dom = new JSDOMWithOptions('<!doctype html><div id="status">Configuring...</div>', {
      url: 'chrome-extension://piercode/configure.html?apiUrl=http%3A%2F%2F127.0.0.1%3A39527'
    });

    Object.assign(dom.window, {
      chrome: {
        storage: {
          local: { set: vi.fn() }
        }
      }
    });

    vm.createContext(dom.window);
    vm.runInContext(script, dom.window);

    expect(dom.window.document.getElementById('status')?.textContent).toBe('Missing params');
    expect((dom.window as any).__PIERCODE_CONFIG_DONE__).toBe('error');
  });
});
