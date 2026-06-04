export type WebAIQueryMessage = {
  type: 'ai_query';
  query_id: string;
  call_id?: string;
  text: string;
  provider?: string;
  client_id?: string;
  timeout_ms?: number;
};

export type WebAIQueryTarget = {
  provider: string;
  clientId: string;
};

export type WebAIResponseCandidate = {
  element: Element;
  text: string;
  isGenerating?: boolean;
};

export type StableWebAIResponse = {
  element: Element;
  text: string;
};

export type StableWebAIResponseOptions = {
  collect: () => WebAIResponseCandidate[];
  initialElements?: Iterable<Element>;
  initialTexts?: Iterable<string>;
  observeRoot?: Node;
  timeoutMs?: number;
  stableMs?: number;
  pollMs?: number;
  isGenerating?: () => boolean;
  ignoreText?: (text: string) => boolean;
  emptyCandidateTimeoutMs?: number;
};

const DEFAULT_RESPONSE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_STABLE_MS = 1500;
const DEFAULT_POLL_MS = 250;

export function normalizeWebAIProvider(provider: string | undefined): string {
  return (provider || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function shouldHandleWebAIQuery(msg: WebAIQueryMessage, target: WebAIQueryTarget): boolean {
  const requestedClient = (msg.client_id || '').trim();
  if (requestedClient) {
    return requestedClient === target.clientId;
  }
  const requestedProvider = normalizeWebAIProvider(msg.provider);
  if (!requestedProvider) return true;
  return requestedProvider === normalizeWebAIProvider(target.provider);
}

export class StableWebAIResponseWaiter {
  private readonly options: Required<Pick<StableWebAIResponseOptions, 'timeoutMs' | 'stableMs' | 'pollMs'>> & StableWebAIResponseOptions;
  private readonly history = new WeakSet<Element>();
  private readonly historyTexts = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private observer: MutationObserver | null = null;
  private lastElement: Element | null = null;
  private lastText = '';
  private lastChangedAt = Date.now();
  private emptyElement: Element | null = null;
  private emptySince = 0;
  private settled = false;
  private resolve: ((value: StableWebAIResponse) => void) | null = null;
  private reject: ((reason?: unknown) => void) | null = null;
  private startedAt = Date.now();

  constructor(options: StableWebAIResponseOptions) {
    this.options = {
      ...options,
      timeoutMs: options.timeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS,
      stableMs: options.stableMs ?? DEFAULT_STABLE_MS,
      pollMs: options.pollMs ?? DEFAULT_POLL_MS,
    };
    for (const element of options.initialElements || []) {
      this.history.add(element);
    }
    for (const text of options.initialTexts || []) {
      const fingerprint = responseTextFingerprint(text);
      if (fingerprint) this.historyTexts.add(fingerprint);
    }
  }

  wait(): Promise<StableWebAIResponse> {
    if (this.resolve || this.reject) {
      throw new Error('StableWebAIResponseWaiter.wait can only be called once');
    }
    return new Promise<StableWebAIResponse>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
      this.observe();
      this.schedule(0);
    });
  }

  cancel(reason = 'cancelled'): void {
    this.fail(new Error(reason));
  }

  private observe(): void {
    if (!this.options.observeRoot) return;
    const ownerWindow = this.options.observeRoot.ownerDocument?.defaultView;
    const Observer = globalThis.MutationObserver || ownerWindow?.MutationObserver;
    if (!Observer) return;
    this.observer = new Observer(() => this.schedule(0));
    this.observer.observe(this.options.observeRoot, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  private schedule(delay = this.options.pollMs): void {
    if (this.settled) return;
    if (this.timer) {
      if (delay > 0) return;
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.check();
    }, delay);
  }

  private check(): void {
    if (this.settled) return;
    const now = Date.now();
    if (now - this.startedAt > this.options.timeoutMs) {
      this.fail(new Error(`timed out waiting for web AI response after ${this.options.timeoutMs}ms`));
      return;
    }

    const candidates = this.options.collect();
    if (this.hasStalledEmptyCandidate(candidates, now)) {
      this.fail(new Error(`web AI assistant turn stalled empty for ${this.options.emptyCandidateTimeoutMs}ms`));
      return;
    }

    const candidate = this.pickLatestCandidate(candidates);
    if (!candidate) {
      this.schedule();
      return;
    }

    const text = candidate.text.trim();
    if (candidate.element !== this.lastElement || text !== this.lastText) {
      this.lastElement = candidate.element;
      this.lastText = text;
      this.lastChangedAt = now;
    }

    const generating = candidate.isGenerating === true || this.options.isGenerating?.() === true;
    if (!generating && now - this.lastChangedAt >= this.options.stableMs) {
      this.succeed({ element: candidate.element, text });
      return;
    }
    this.schedule();
  }

  private hasStalledEmptyCandidate(candidates: WebAIResponseCandidate[], now: number): boolean {
    const timeoutMs = this.options.emptyCandidateTimeoutMs;
    if (!timeoutMs || timeoutMs <= 0) return false;
    const empty = candidates.find(candidate => {
      if (this.history.has(candidate.element)) return false;
      return !candidate.text.trim();
    });
    if (!empty) {
      this.emptyElement = null;
      this.emptySince = 0;
      return false;
    }
    if (empty.element !== this.emptyElement) {
      this.emptyElement = empty.element;
      this.emptySince = now;
      return false;
    }
    return now - this.emptySince >= timeoutMs;
  }

  private pickLatestCandidate(candidates: WebAIResponseCandidate[]): WebAIResponseCandidate | null {
    const filtered = candidates
      .filter(candidate => {
        const text = candidate.text.trim();
        if (!text) return false;
        if (this.history.has(candidate.element)) return false;
        if (this.options.ignoreText?.(text)) return false;
        const fingerprint = responseTextFingerprint(text);
        if (fingerprint && this.historyTexts.has(fingerprint)) return false;
        return true;
      });
    return filtered.length ? filtered[filtered.length - 1] : null;
  }

  private succeed(value: StableWebAIResponse): void {
    if (this.settled) return;
    this.settled = true;
    this.cleanup();
    this.resolve?.(value);
  }

  private fail(error: Error): void {
    if (this.settled) return;
    this.settled = true;
    this.cleanup();
    this.reject?.(error);
  }

  private cleanup(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.observer?.disconnect();
    this.observer = null;
  }
}

export function waitForStableWebAIResponse(options: StableWebAIResponseOptions): Promise<StableWebAIResponse> {
  return new StableWebAIResponseWaiter(options).wait();
}

export function responseTextFingerprint(text: string): string {
  return text.trim().replace(/\s+/g, ' ').slice(0, 4000);
}
