export class SinglePacketWaiter<T> {
  private resolvePending: ((value: T | null) => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  register(): Promise<T | null> {
    this.cancel();
    return new Promise(resolve => {
      this.resolvePending = resolve;
    });
  }

  startTimeout(timeoutMs: number): void {
    if (!this.resolvePending || this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.cancel();
    }, timeoutMs);
  }

  resolve(value: T): boolean {
    const resolve = this.resolvePending;
    if (!resolve) return false;
    this.clearTimer();
    this.resolvePending = null;
    resolve(value);
    return true;
  }

  cancel(): void {
    const resolve = this.resolvePending;
    this.clearTimer();
    this.resolvePending = null;
    if (resolve) resolve(null);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
