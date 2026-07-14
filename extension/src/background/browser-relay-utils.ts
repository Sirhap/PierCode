const AI_PAGE_HOSTS = [
  'gemini.google.com',
  'aistudio.google.com',
  'qwen.ai',
  'qwenlm.ai',
  'chat.z.ai',
  'kimi.com',
  'claude.ai',
  'free.easychat.top',
  'aistudio.xiaomimimo.com',
  'chatgpt.com',
  'chat.openai.com',
  'ultraspeed.xiaomimimo.com',
];

export function browserRelayWsUrl(apiUrl: string, token: string): string | null {
  try {
    const url = new URL(apiUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/ws';
    url.searchParams.set('token', token);
    url.searchParams.set('client', 'background');
    url.searchParams.set('role', 'browser-relay');
    url.searchParams.set('provider', 'Extension');
    return url.toString();
  } catch {
    return null;
  }
}

export function isAiPageUrl(raw: string): boolean {
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return AI_PAGE_HOSTS.some(aiHost => host === aiHost || host.endsWith(`.${aiHost}`));
  } catch {
    return false;
  }
}
