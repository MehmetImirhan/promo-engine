/**
 * Cache-aside over Redis (ADR §6).
 *
 * getOrCompute(key, ttl, fn):
 *   single-flight(key) { GET key → hit: parse; miss: fn() → SET key EX ttl }
 *
 * getOrComputeVersioned(scope, prefix, ttl, fn):
 *   read the category version ONCE, build ONE key `{prefix}:v{token}`, and
 *   use that key for both the GET and the SET. Reading the version twice
 *   would let a bump land between the reads and produce a key no reader
 *   can find.
 *
 * Fail-open, at every Redis touch: a failed version read, GET or SET is
 * logged and the request is served from Postgres. Single-flight still
 * applies while Redis is down, so a Redis outage during a flash sale does
 * not turn into a Postgres stampede either.
 *
 * Values are JSON; whatever `fn` returns must survive a JSON round trip.
 */
import { ALL_SCOPE, CategoryVersions, errorMessage } from './category-versions.js';
import type { Redis } from './redis.js';
import { SingleFlight } from './single-flight.js';
import type { Logger } from '../shared/logger.js';

export type CacheRedis = Pick<Redis, 'get' | 'set'>;

export interface CacheOptions {
  /** false: never touch Redis; every call runs fn (through single-flight). */
  enabled?: boolean;
  singleFlight?: boolean;
}

export class Cache {
  readonly enabled: boolean;
  private readonly flight: SingleFlight;
  /** Logged once per transition so a Redis outage does not log per request. */
  private degraded = false;

  constructor(
    private readonly redis: CacheRedis,
    readonly versions: CategoryVersions,
    private readonly logger: Logger,
    options: CacheOptions = {},
  ) {
    this.enabled = options.enabled ?? true;
    this.flight = new SingleFlight(options.singleFlight ?? true);
  }

  async getOrCompute<T>(key: string, ttlSeconds: number, fn: () => Promise<T>): Promise<T> {
    if (!this.enabled) return this.flight.run(key, fn);
    return this.flight.run(key, () => this.readThrough(key, ttlSeconds, fn));
  }

  /**
   * `scope` is a category id or ALL_SCOPE. When the version cannot be read
   * the value is computed without Redis, coalesced on the unversioned prefix.
   */
  async getOrComputeVersioned<T>(scope: string, prefix: string, ttlSeconds: number, fn: () => Promise<T>): Promise<T> {
    if (!this.enabled) return this.flight.run(prefix, fn);
    const token = await this.versions.current(scope);
    if (token === null) return this.flight.run(prefix, fn);
    return this.getOrCompute(`${prefix}:v${token}`, ttlSeconds, fn);
  }

  private async readThrough<T>(key: string, ttlSeconds: number, fn: () => Promise<T>): Promise<T> {
    const hit = await this.get<T>(key);
    if (hit !== undefined) return hit;
    const value = await fn();
    await this.put(key, ttlSeconds, value);
    return value;
  }

  private async get<T>(key: string): Promise<T | undefined> {
    let raw: string | null;
    try {
      raw = await this.redis.get(key);
    } catch (err) {
      this.noteFailure('get', key, err);
      return undefined;
    }
    this.noteRecovery();
    if (raw === null) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch (err) {
      // A corrupt or foreign-shaped entry is a miss, not a 500; the fresh value overwrites it.
      this.logger.warn({ key, err: errorMessage(err) }, 'cache: unparseable entry; treating as a miss');
      return undefined;
    }
  }

  /** Unconditional write; used to correct a derived entry the read path found to be wrong. Fail-open. */
  async put(key: string, ttlSeconds: number, value: unknown): Promise<void> {
    try {
      await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (err) {
      this.noteFailure('set', key, err);
    }
  }

  private noteFailure(op: string, key: string, err: unknown): void {
    if (this.degraded) {
      this.logger.debug({ op, key, err: errorMessage(err) }, 'cache: redis error; serving from postgres');
      return;
    }
    this.degraded = true;
    this.logger.warn({ op, key, err: errorMessage(err) }, 'cache: redis unavailable; serving from postgres until it returns');
  }

  private noteRecovery(): void {
    if (!this.degraded) return;
    this.degraded = false;
    this.logger.info('cache: redis reachable again');
  }
}

export { ALL_SCOPE };
