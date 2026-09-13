import { Redis } from 'ioredis';

/**
 * Redis client factory. Client creation only; cache logic arrives in a later
 * session.
 *
 * - `lazyConnect`: the caller decides when to connect (server.ts), so a
 *   Redis outage at boot does not prevent the API from starting.
 * - `enableOfflineQueue: false`: commands fail immediately while disconnected
 *   instead of queueing. That is what lets cache reads fail open and lets
 *   /ready report "down" promptly rather than hanging.
 * - `commandTimeout`: a connected but unresponsive Redis fails open as well.
 */
export function createRedis(url: string): Redis {
  return new Redis(url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    // A Redis that accepts connections but stalls must fail open too; 500 ms
    // is far above a healthy round trip and well inside a request budget.
    commandTimeout: 500,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
  });
}

export type { Redis };
