import { describe, expect, it } from 'vitest';

declare const require: any;

const fs = require('node:fs');
const path = require('node:path');

const extensionRoot = path.resolve(new URL('../..', import.meta.url).pathname);
const distFile = (p: string) => path.join(extensionRoot, 'dist', p);

// Guards the offscreen-fetch wiring (qwen bx-ua via a hidden chat.qwen.ai iframe;
// see qwen-offscreen-fetch.ts + memory qwen-bxua-needs-page-env). Assumes a prior
// `npm run build` has populated dist/ (content-build.test.ts triggers one; CI runs
// build before tests). Skips gracefully if dist is absent.
describe('offscreen qwen-fetch wiring', () => {
  const hasDist = fs.existsSync(distFile('manifest.json'));
  const maybe = hasDist ? it : it.skip;

  maybe('manifest declares offscreen + DNR + all_frames + WAR', () => {
    const m = JSON.parse(fs.readFileSync(distFile('manifest.json'), 'utf8'));
    expect(m.permissions).toContain('offscreen');
    expect(m.permissions).toContain('declarativeNetRequest');
    expect(m.declarative_net_request?.rule_resources?.[0]?.path).toBe('dnr-offscreen.json');
    expect(m.content_scripts?.[0]?.all_frames).toBe(true);
    expect(m.web_accessible_resources?.[0]?.resources).toContain('offscreen.html');
    expect(m.web_accessible_resources?.[0]?.resources).toContain('offscreen.js');
  });

  maybe('emits offscreen.html + offscreen.js + dnr file', () => {
    expect(fs.existsSync(distFile('offscreen.html'))).toBe(true);
    expect(fs.existsSync(distFile('offscreen.js'))).toBe(true);
    expect(fs.existsSync(distFile('dnr-offscreen.json'))).toBe(true);
  });

  maybe('DNR strips frame-blocking headers for qwen sub_frame', () => {
    const rules = JSON.parse(fs.readFileSync(distFile('dnr-offscreen.json'), 'utf8'));
    const rule = rules[0];
    expect(rule.condition.resourceTypes).toContain('sub_frame');
    expect(rule.condition.urlFilter).toContain('qwen.ai');
    const removed = rule.action.responseHeaders
      .filter((h: { operation: string }) => h.operation === 'remove')
      .map((h: { header: string }) => h.header);
    expect(removed).toContain('x-frame-options');
    expect(removed).toContain('content-security-policy');
  });

  maybe('offscreen.js hosts a chat.qwen.ai iframe', () => {
    const js = fs.readFileSync(distFile('offscreen.js'), 'utf8');
    expect(js).toContain('chat.qwen.ai');
    expect(js).toContain('iframe');
  });
});
