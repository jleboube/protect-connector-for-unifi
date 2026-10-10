/**
 * Small sliding-window limiter, used to stay under the Site Manager cloud
 * connector's documented limit of 100 requests per minute per console.
 * In-memory only; it is per-process (stdio) or per-isolate (Worker).
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records a hit if allowed. Returns 0 when allowed, else ms until a slot frees up. */
  take(key: string): number {
    const t = this.now();
    const arr = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (arr.length >= this.limit) {
      this.hits.set(key, arr);
      return this.windowMs - (t - arr[0]);
    }
    arr.push(t);
    this.hits.set(key, arr);
    // Opportunistic cleanup so long-lived processes don't grow unbounded.
    if (this.hits.size > 1000) {
      for (const [k, v] of this.hits) if (v.every((x) => t - x >= this.windowMs)) this.hits.delete(k);
    }
    return 0;
  }
}
