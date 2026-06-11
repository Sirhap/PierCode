declare module 'jsdom' {
  export interface JSDOMOptions {
    runScripts?: 'dangerously' | 'outside-only';
    url?: string;
  }
  export class JSDOM {
    constructor(html?: string, options?: JSDOMOptions);
    window: Window & typeof globalThis & { eval(code: string): unknown; close(): void };
  }
}
