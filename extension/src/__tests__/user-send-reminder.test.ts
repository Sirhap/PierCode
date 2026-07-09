import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { installUserSendReminder, markProgrammaticSend, isSystemReminderEnabled, setSystemReminderEnabled, type UserSendReminderDeps } from '../content/user-send-reminder';

const REMINDER = '\n\n[系统提示] 测试提醒文本 piercode-tool tool_help';

function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

describe('user-send-reminder', () => {
  let dom: JSDOM;
  let textarea: HTMLTextAreaElement;
  let sendBtn: HTMLButtonElement;
  let storageData: Record<string, unknown>;
  let workerId: string | null;

  function makeDeps(overrides: Partial<UserSendReminderDeps> = {}): UserSendReminderDeps {
    return {
      getSiteConfig: () => ({ editor: 'textarea.editor', sendBtn: 'button.send-button', fillMethod: 'value' }),
      querySelectorFirst: (sel: string) => dom.window.document.querySelector(sel.split(',')[0]) as HTMLElement | null,
      findEditorFromTarget: (t) => (t && t.matches('textarea.editor') ? t : null),
      getEditorText: (el) => (el as HTMLTextAreaElement).value,
      effectiveFillMethod: () => 'value',
      getNativeSetter: () => null,
      workerAgentId: () => workerId,
      checkContext: () => true,
      fetchReminderText: async () => REMINDER,
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    dom = new JSDOM('<textarea class="editor"></textarea><button class="send-button"><span class="icon"></span></button>');
    (globalThis as any).document = dom.window.document;
    (globalThis as any).window = dom.window;
    (globalThis as any).Event = dom.window.Event;
    (globalThis as any).MouseEvent = dom.window.MouseEvent;
    (globalThis as any).KeyboardEvent = dom.window.KeyboardEvent;
    textarea = dom.window.document.querySelector('textarea.editor')!;
    sendBtn = dom.window.document.querySelector('button.send-button')!;
    storageData = {};
    workerId = null;
    // 模块状态跨用例共享：清掉上个用例可能留下的程序化发送抑制窗口。
    markProgrammaticSend(-1000);
    (globalThis as any).chrome = {
      storage: {
        local: { get: vi.fn(async () => storageData) },
        onChanged: { addListener: vi.fn() },
      },
    };
  });

  afterEach(() => {
    delete (globalThis as any).document;
    delete (globalThis as any).window;
    delete (globalThis as any).chrome;
  });

  function pressSend(target: Element = sendBtn) {
    target.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
  }

  it('appends reminder to user text on send-button mousedown', async () => {
    installUserSendReminder(makeDeps());
    await flush();
    textarea.value = '你好';
    // 点击命中按钮内部的子元素也应通过 closest 命中。
    pressSend(sendBtn.querySelector('.icon')!);
    expect(textarea.value).toBe('你好' + REMINDER);
  });

  it('does not append twice when mousedown and click both fire', async () => {
    installUserSendReminder(makeDeps());
    await flush();
    textarea.value = '消息';
    pressSend();
    sendBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    expect(textarea.value).toBe('消息' + REMINDER);
  });

  it('skips empty editor and non-send targets', async () => {
    installUserSendReminder(makeDeps());
    await flush();
    pressSend();
    expect(textarea.value).toBe('');
    textarea.value = '文本';
    dom.window.document.body.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
    expect(textarea.value).toBe('文本');
  });

  it('suppresses append after markProgrammaticSend', async () => {
    installUserSendReminder(makeDeps());
    await flush();
    textarea.value = '工具结果回填';
    markProgrammaticSend();
    pressSend();
    expect(textarea.value).toBe('工具结果回填');
  });

  it('skips worker pages', async () => {
    workerId = 'agent-1';
    installUserSendReminder(makeDeps());
    await flush();
    textarea.value = '任务';
    pressSend();
    expect(textarea.value).toBe('任务');
  });

  it('master switch off disables append and reports via isSystemReminderEnabled', async () => {
    storageData = { systemReminderEnabled: false };
    installUserSendReminder(makeDeps());
    await flush();
    expect(isSystemReminderEnabled()).toBe(false);
    textarea.value = '消息';
    pressSend();
    expect(textarea.value).toBe('消息');
  });

  it('legacy appendUserSendReminder key is ignored (merged into systemReminderEnabled)', async () => {
    storageData = { appendUserSendReminder: false };
    installUserSendReminder(makeDeps());
    await flush();
    expect(isSystemReminderEnabled()).toBe(true);
    textarea.value = '消息';
    pressSend();
    expect(textarea.value).toBe('消息' + REMINDER);
  });

  it('extensionEnabled=false (插件总开关) disables append too', async () => {
    storageData = { extensionEnabled: false };
    installUserSendReminder(makeDeps());
    await flush();
    expect(isSystemReminderEnabled()).toBe(false);
    textarea.value = '消息';
    pressSend();
    expect(textarea.value).toBe('消息');
  });

  it('setSystemReminderEnabled(false) synchronously suppresses append after a runtime master-switch off', async () => {
    // Install with the switch ON so the reminder text is loaded and append works.
    storageData = {};
    installUserSendReminder(makeDeps());
    await flush();
    textarea.value = '消息一';
    pressSend();
    expect(textarea.value).toBe('消息一' + REMINDER);
    expect(isSystemReminderEnabled()).toBe(true);

    // Master switch flips off at runtime → bootstrapGate calls this synchronously.
    // A send-press right after (no await for the async storage refresh) must NOT
    // append — this is the leak the sync override closes.
    setSystemReminderEnabled(false);
    expect(isSystemReminderEnabled()).toBe(false);
    textarea.value = '消息二';
    pressSend();
    expect(textarea.value).toBe('消息二');

    // Back on → append resumes.
    setSystemReminderEnabled(true);
    expect(isSystemReminderEnabled()).toBe(true);
    textarea.value = '消息三';
    pressSend();
    expect(textarea.value).toBe('消息三' + REMINDER);
  });

  it('appends on Enter keydown in editor, not on Shift+Enter', async () => {
    storageData = {};
    installUserSendReminder(makeDeps());
    await flush();
    textarea.value = '回车发送';
    textarea.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    expect(textarea.value).toBe('回车发送');
    textarea.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(textarea.value).toBe('回车发送' + REMINDER);
  });

  it('does not re-append when text already contains the marker', async () => {
    installUserSendReminder(makeDeps());
    await flush();
    textarea.value = '已带' + REMINDER;
    pressSend();
    expect(textarea.value).toBe('已带' + REMINDER);
  });
});
