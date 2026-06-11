// Borrow-once cache for qwen's baxia bx-ua / bx-umidtoken signature headers.
//
// completions sits behind Aliyun baxia risk control: a clean SW fetch lacking
// bx-ua hits RGV587 (滑块 punish). bx-ua can only be produced by baxia running
// in a real qwen page, BUT (verified empirically) it is reusable across
// requests. So: borrow it once from a qwen tab, cache it, replay on every
// direct SW fetch; on RGV587, invalidate() and re-borrow once.
//
// This module owns only the cache + in-flight dedup. The actual borrow (port
// round-trip to the page) is injected so it can be unit-tested in isolation.

export interface BxUaCreds {
  bxUa: string;
  umid: string;
}

export type BorrowFn = () => Promise<BxUaCreds | null>;

export interface BxUaBroker {
  /** Cached creds, or borrow if empty. null = borrow failed (no tab / punish). */
  getBxUa(): Promise<BxUaCreds | null>;
  /** Drop the cache so the next getBxUa re-borrows (call on RGV587). */
  invalidate(): void;
}

export function createBxUaBroker(borrow: BorrowFn): BxUaBroker {
  let cached: BxUaCreds | null = null;
  let inFlight: Promise<BxUaCreds | null> | null = null;

  return {
    async getBxUa() {
      if (cached) return cached;
      if (inFlight) return inFlight;
      inFlight = (async () => {
        try {
          const creds = await borrow();
          if (creds) cached = creds; // never cache a null/failure
          return creds;
        } finally {
          inFlight = null;
        }
      })();
      return inFlight;
    },
    invalidate() {
      cached = null;
    },
  };
}
