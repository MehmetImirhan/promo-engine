/**
 * Per-category cache versions (ADR §6, "invalidation without a 50k-key delete").
 *
 *   catver:{categoryId}  — bumped by every write that can change a price in
 *                          that category; embedded in every key for it
 *   catver:_all          — bumped alongside every category bump; the version
 *                          the unfiltered GET /products listing keys on
 *
 * A version token is `{scope}.{n}`, not the bare counter: counters are per
 * category, so two categories can be at the same number, and a product that
 * ingest moved from one category to another must not find a key written
 * under the other category's identical number.
 *
 * Every method fails open. `current` returns null when Redis cannot answer
 * (the caller then bypasses the cache); `bump` logs and returns. The TTLs on
 * the cached values bound the staleness a lost bump can cause.
 */
import type { Redis } from './redis.js';
import type { Logger } from '../shared/logger.js';

export const ALL_SCOPE = '_all';

export type VersionRedis = Pick<Redis, 'get' | 'incr'>;

export function versionKey(scope: string): string {
  return `catver:${scope}`;
}

export function versionToken(scope: string, n: string): string {
  return `${scope}.${n}`;
}

export class CategoryVersions {
  constructor(
    private readonly redis: VersionRedis,
    private readonly logger: Logger,
  ) {}

  /** Current token for a category id or ALL_SCOPE; "0" before the first bump; null when Redis is unavailable. */
  async current(scope: string): Promise<string | null> {
    try {
      const n = await this.redis.get(versionKey(scope));
      return versionToken(scope, n ?? '0');
    } catch (err) {
      this.logger.warn({ err: errorMessage(err), scope }, 'cache: version read failed; bypassing cache');
      return null;
    }
  }

  /**
   * One INCR per distinct category plus one for ALL_SCOPE. The commands are
   * issued in the same tick, so ioredis writes them back to back on the
   * socket (pipelined) and the cost is one round trip. O(1) in the number of
   * products; this is the entire invalidation of a 50k-product campaign.
   */
  async bump(categoryIds: readonly string[]): Promise<void> {
    const scopes = [...new Set(categoryIds)];
    if (scopes.length === 0) return;
    scopes.push(ALL_SCOPE);
    try {
      await Promise.all(scopes.map((scope) => this.redis.incr(versionKey(scope))));
      this.logger.debug({ scopes }, 'cache: versions bumped');
    } catch (err) {
      this.logger.warn({ err: errorMessage(err), scopes }, 'cache: version bump failed; entries expire by TTL');
    }
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
