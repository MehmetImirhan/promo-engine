/**
 * What a handler may know about its own invocation. Shaped after the Lambda
 * context (`getRemainingTimeInMillis`) so the same handler runs unchanged
 * under a BullMQ worker (src/worker.ts builds one from the configured
 * timeout) or a real function runtime.
 */
export interface InvocationContext {
  remainingTimeMs(): number;
}

export function contextWithDeadline(timeoutMs: number, now: () => number = Date.now): InvocationContext {
  const deadline = now() + timeoutMs;
  return { remainingTimeMs: () => Math.max(0, deadline - now()) };
}
