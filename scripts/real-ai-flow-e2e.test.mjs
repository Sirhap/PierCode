import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildClaudeSettings,
  chooseProviderOrder,
  defaultRealAIPort,
  e2eScenarioNames,
  isUsefulAIAnswer,
  newestTabsFirst,
  parseTabs,
  parseBrowserEvaluateValue,
  providerContentSelectors,
  redactSensitive,
  shouldRecordFallbackAttempt,
} from './real-ai-flow-e2e.mjs';

describe('real AI flow e2e helpers', () => {
  it('parses Chrome tab output and prefers newest Qwen tab', () => {
    const tabs = parseTabs([
      '受控 tab:',
      '- tabId=11 title="about:blank" url="about:blank" controlled=true tracked=true source="created"',
      '',
      '其他可选 tab:',
      '- tabId=21 title="Qwen Studio" url="https://chat.qwen.ai/c/old" controlled=false tracked=false source=""',
      '- tabId=22 title="ChatGPT" url="https://chatgpt.com/c/abc" controlled=false tracked=false source=""',
      '- tabId=23 title="Qwen Studio" url="https://chat.qwen.ai/c/new" controlled=false tracked=false source=""',
    ].join('\n'));

    assert.equal(tabs.length, 4);
    assert.equal(newestTabsFirst(tabs.filter(tab => tab.provider === 'Qwen'))[0].tabId, 23);
    assert.equal(tabs.find(tab => tab.provider === 'ChatGPT').tabId, 22);
  });

  it('orders tabs newest first by numeric tab id before marker verification', () => {
    assert.deepEqual(newestTabsFirst([
      { tabId: 101, provider: 'ChatGPT' },
      { tabId: 99, provider: 'ChatGPT' },
      { tabId: 110, provider: 'ChatGPT' },
    ]).map(tab => tab.tabId), [110, 101, 99]);
  });

  it('checks conversation content before whole page body for ChatGPT marker verification', () => {
    assert.deepEqual(providerContentSelectors('ChatGPT'), [
      'main',
      '[data-testid^="conversation-turn"]',
      'body',
    ]);
  });

  it('extracts a content client id from browser_evaluate output', () => {
    assert.equal(
      parseBrowserEvaluateValue('evaluated in tabId=123 type=string value=content-mpxxdgzg-9cqy8arr'),
      'content-mpxxdgzg-9cqy8arr',
    );
  });

  it('orders Qwen first and ChatGPT as fallback', () => {
    assert.deepEqual(chooseProviderOrder('Qwen'), ['Qwen', 'ChatGPT']);
    assert.deepEqual(chooseProviderOrder('ChatGPT'), ['ChatGPT']);
  });

  it('uses the fixed real E2E backend port by default', () => {
    assert.equal(defaultRealAIPort(), 39527);
  });

  it('declares every real-user scenario required by the acceptance plan', () => {
    assert.deepEqual(e2eScenarioNames(), [
      'risk-analysis',
      'code-review',
      'long-markdown-fidelity',
      'multi-turn-1',
      'multi-turn-2',
      'multi-turn-3',
      'after-tab-refresh',
      'after-backend-restart',
    ]);
  });

  it('records Qwen fallback only when ChatGPT is attempted after Qwen fails', () => {
    assert.equal(shouldRecordFallbackAttempt('Qwen', 'ChatGPT'), true);
    assert.equal(shouldRecordFallbackAttempt('ChatGPT', 'ChatGPT'), false);
    assert.equal(shouldRecordFallbackAttempt('Qwen', 'Qwen'), false);
  });

  it('merges Claude settings without overwriting existing env, hooks, or plugins', () => {
    const existing = {
      env: { ANTHROPIC_MODEL: 'keep-me' },
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo keep' }] }] },
      enabledPlugins: { caveman: true },
      mcpServers: {
        existing: { command: 'old', args: [] },
      },
    };

    const next = buildClaudeSettings(existing, {
      command: '/tmp/piercode-real-mcp',
      apiUrl: 'http://127.0.0.1:39527',
      token: 'piercode-e2e-token',
    });

    assert.equal(next.env.ANTHROPIC_MODEL, 'keep-me');
    assert.deepEqual(next.hooks, existing.hooks);
    assert.deepEqual(next.enabledPlugins, existing.enabledPlugins);
    assert.equal(next.mcpServers.existing.command, 'old');
    assert.deepEqual(next.mcpServers['piercode-web-ai'], {
      command: '/tmp/piercode-real-mcp',
      args: [],
      env: {
        PIERCODE_API_URL: 'http://127.0.0.1:39527',
        PIERCODE_TOKEN: 'piercode-e2e-token',
      },
    });
  });

  it('rejects known status noise as non-useful AI answer', () => {
    assert.equal(isUsefulAIAnswer('当前内容为空，请重新生成。'), false);
    assert.equal(isUsefulAIAnswer('糟糕！连接到 Qwen3.7-Plus 时出现问题。Allocated quota exceeded'), false);
    assert.equal(isUsefulAIAnswer('MCP 工具调用 `ask_web_ai` 失败：no web AI response received within 2m0s'), false);
    assert.equal(isUsefulAIAnswer('WEB_AI_TOOL_ERROR no web AI response received within 2m0s'), false);
    assert.equal(isUsefulAIAnswer('Provider: Qwen\n\n这个功能最容易失败在浏览器连接、页面状态和大文本传输。'), true);
  });

  it('redacts bearer tokens and API keys from reports', () => {
    const text = 'Authorization: Bearer abcdef1234567890 token=super-secret ANTHROPIC_API_KEY=sk-test-1234567890';
    const redacted = redactSensitive(text);

    assert.equal(redacted.includes('abcdef1234567890'), false);
    assert.equal(redacted.includes('super-secret'), false);
    assert.equal(redacted.includes('sk-test-1234567890'), false);
    assert.match(redacted, /Bearer <redacted>/);
  });
});
