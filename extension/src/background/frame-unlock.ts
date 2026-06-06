// frame-unlock: lets the Hub page embed AI sites in iframes.
//
// AI sites send `X-Frame-Options: SAMEORIGIN` (and CSP `frame-ancestors`), which
// blocks them from loading in a cross-origin iframe. We use declarativeNetRequest
// to, for requests INITIATED BY THE EXTENSION PAGE ONLY:
//   - remove X-Frame-Options and Content-Security-Policy response headers, and
//   - set Sec-Fetch-Dest=document / Sec-Fetch-Site=same-origin so the site's own
//     frame / Cloudflare checks see a normal top-level navigation.
//
// The `initiatorDomains: [extension hostname]` scope is the security-critical
// invariant: a user browsing the AI site in a normal tab keeps full XFO/CSP —
// only the Hub's own iframe loads are unlocked. Mirrors the shipping Simple Chat
// Hub extension's verified mechanism.

// Bare hostnames of the AI sites the Hub can embed. Kept in sync with the
// manifest host_permissions / content_scripts matches (bare host form, no
// scheme/path/wildcard so DNR `requestDomains` accepts them; a bare domain also
// matches its subdomains in DNR).
export const AI_FRAME_HOSTS: string[] = [
  'gemini.google.com',
  'aistudio.google.com',
  'qwen.ai',
  'chat.qwen.ai',
  'qwenlm.ai',
  'chat.z.ai',
  'kimi.com',
  'claude.ai',
  'free.easychat.top',
  'aistudio.xiaomimimo.com',
  'chatgpt.com',
  'chat.openai.com',
];

// A subset of chrome.declarativeNetRequest.Rule shaped for what we build, kept
// local so the pure builder is testable without the chrome types at runtime.
export interface FrameUnlockRule {
  id: number;
  priority: number;
  action: {
    type: 'modifyHeaders';
    requestHeaders?: { header: string; operation: 'set' | 'remove'; value?: string }[];
    responseHeaders?: { header: string; operation: 'set' | 'remove'; value?: string }[];
  };
  condition: {
    initiatorDomains: string[];
    requestDomains: string[];
    resourceTypes: string[];
    domains?: string[]; // Firefox legacy (<101) initiator field
  };
}

// buildFrameUnlockRules produces the DNR dynamic rules. One rule per host keeps
// requestDomains/ids simple and lets a single bad host be diagnosed in isolation.
// uaMajor is the browser major version; Firefox below 101 used `condition.domains`
// for the initiator instead of `initiatorDomains`.
export function buildFrameUnlockRules(
  aiHosts: string[],
  extensionHostname: string,
  uaMajor: number,
): FrameUnlockRule[] {
  const useLegacyDomains = uaMajor !== 0 && uaMajor < 101;
  return aiHosts.map((host, i) => {
    const condition: FrameUnlockRule['condition'] = {
      initiatorDomains: [extensionHostname],
      requestDomains: [host],
      resourceTypes: ['sub_frame'],
    };
    if (useLegacyDomains) condition.domains = [extensionHostname];
    return {
      id: i + 1,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Sec-Fetch-Dest', operation: 'set', value: 'document' },
          { header: 'Sec-Fetch-Site', operation: 'set', value: 'same-origin' },
        ],
        responseHeaders: [
          { header: 'X-Frame-Options', operation: 'remove' },
          { header: 'Content-Security-Policy', operation: 'remove' },
          { header: 'Content-Security-Policy-Report-Only', operation: 'remove' },
        ],
      },
      condition,
    };
  });
}

// browserMajorVersion parses the major version from a UA string. 0 = unknown
// (callers treat that as "modern", so the legacy Firefox path is opt-in only).
export function browserMajorVersion(ua: string): number {
  const m = ua.match(/(?:Firefox|Chrome|Edg)\/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

// extensionHostname returns this extension's own hostname (the id), used as the
// DNR initiator scope. Thin chrome.* wrapper kept out of the pure builder.
export function extensionHostname(): string {
  try {
    return new URL(chrome.runtime.getURL('')).hostname;
  } catch {
    return '';
  }
}

// applyFrameUnlock installs the dynamic DNR rules (replacing any prior ones) and
// registers page-bridge + content.js into the AI frames so the Hub's iframes
// behave exactly like a normal controlled tab. Idempotent: clears its own old
// rules/scripts first. No-op when the chrome APIs are unavailable (tests).
export async function applyFrameUnlock(aiHosts: string[] = AI_FRAME_HOSTS): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.declarativeNetRequest) return;
  const host = extensionHostname();
  if (!host) return;
  const uaMajor = browserMajorVersion(typeof navigator !== 'undefined' ? navigator.userAgent : '');
  const rules = buildFrameUnlockRules(aiHosts, host, uaMajor) as unknown as chrome.declarativeNetRequest.Rule[];

  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map(r => r.id),
    addRules: rules,
  });

  // Inject the existing operating scripts into the embedded AI frames. page-bridge
  // runs in MAIN world at document_start (the early visibility/editor shim);
  // content.js runs in the isolated world at document_idle (the operator).
  const matches = aiHosts.map(h => `*://*.${h}/*`).concat(aiHosts.map(h => `*://${h}/*`));
  try {
    const old = await chrome.scripting.getRegisteredContentScripts({ ids: ['piercode-hub-bridge', 'piercode-hub-content'] });
    if (old.length) await chrome.scripting.unregisterContentScripts({ ids: old.map(s => s.id) });
  } catch { /* none registered yet */ }
  await chrome.scripting.registerContentScripts([
    { id: 'piercode-hub-bridge', matches, js: ['page-bridge.js'], allFrames: true, runAt: 'document_start', world: 'MAIN' },
    { id: 'piercode-hub-content', matches, js: ['content.js'], allFrames: true, runAt: 'document_idle' },
  ]);
}
