/**
 * In-process request coalescing (ADR §6, "stampede protection" #1).
 *
 * While a promise for `key` is in flight, every further `run(key, fn)` call
 * awaits that same promise instead of invoking `fn` again. When it settles
 * (either way) the entry is dropped, so the next call runs `fn` afresh. A
 * rejection therefore reaches every waiter and is never cached.
 *
 * This coalesces per replica only. The cross-instance `SET NX` lock in the
 * ADR is a deliberate follow-up, gated on the measurements in scripts/load.
 *
 * `enabled: false` turns the helper into a plain `fn()` call; the load script
 * uses it to produce the "without single-flight" comparison line in ADR §6.
 */
export class SingleFlight {
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(readonly enabled: boolean = true) {}

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (!this.enabled) return fn();

    const existing = this.inflight.get(key);
    if (existing !== undefined) return existing as Promise<T>;

    // fn starts synchronously so the first caller's query is already running
    // when the next caller arrives; a synchronous throw becomes a rejection.
    let promise: Promise<T>;
    try {
      promise = fn();
    } catch (err) {
      return Promise.reject(err);
    }
    this.inflight.set(key, promise);
    promise.then(this.forget(key), this.forget(key));
    return promise;
  }

  /** Number of keys currently in flight; exposed for tests and metrics. */
  get size(): number {
    return this.inflight.size;
  }

  private forget(key: string): () => void {
    return () => {
      this.inflight.delete(key);
    };
  }
}
