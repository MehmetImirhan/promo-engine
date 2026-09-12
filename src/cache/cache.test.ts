import { describe, expect, it } from 'vitest';
import { createLogger } from '../shared/logger.js';
import { Cache, type CacheRedis } from './cache.js';
import { ALL_SCOPE, CategoryVersions, type VersionRedis } from './category-versions.js';

const logger = createLogger({ level: 'silent', pretty: false });

type FakeRedis = CacheRedis & VersionRedis & { store: Map<string, string>; calls: string[] };

/** A Map-backed Redis for the commands the cache uses. */
function fakeRedis(): FakeRedis {
  const store = new Map<string, string>();
  const calls: string[] = [];
  return {
    store,
    calls,
    get: async (key: string) => {
      calls.push(`get ${key}`);
      return store.get(key) ?? null;
    },
    set: (async (key: string, value: string) => {
      calls.push(`set ${key}`);
      store.set(key, value);
      return 'OK';
    }) as CacheRedis['set'],
    incr: async (key: string) => {
      calls.push(`incr ${key}`);
      const n = Number(store.get(key) ?? '0') + 1;
      store.set(key, String(n));
      return n;
    },
  };
}

/** Every command rejects, as ioredis does with enableOfflineQueue: false and no connection. */
function deadRedis(): CacheRedis & VersionRedis {
  const down = async () => {
    throw new Error("Stream isn't writeable and enableOfflineQueue options is false");
  };
  return { get: down, set: down as unknown as CacheRedis['set'], incr: down };
}

function build(redis: CacheRedis & VersionRedis, options = {}) {
  const versions = new CategoryVersions(redis, logger);
  return { cache: new Cache(redis, versions, logger, options), versions };
}

describe('Cache.getOrCompute', () => {
  it('computes on miss, stores with a TTL, and serves the stored value on the next call', async () => {
    const redis = fakeRedis();
    const { cache } = build(redis);
    let computed = 0;
    const fn = async () => ({ n: ++computed });

    expect(await cache.getOrCompute('k', 30, fn)).toEqual({ n: 1 });
    expect(await cache.getOrCompute('k', 30, fn)).toEqual({ n: 1 });
    expect(computed).toBe(1);
    expect(redis.calls).toEqual(['get k', 'set k', 'get k']);
  });

  it('fails open: returns the computed value when GET and SET throw', async () => {
    const { cache } = build(deadRedis());
    await expect(cache.getOrCompute('k', 30, async () => 'from-postgres')).resolves.toBe('from-postgres');
  });

  it('single-flight: concurrent misses run fn once', async () => {
    const redis = fakeRedis();
    const { cache } = build(redis);
    let computed = 0;
    const fn = async () => ++computed;
    const results = await Promise.all(Array.from({ length: 10 }, () => cache.getOrCompute('k', 30, fn)));
    expect(results).toEqual(Array(10).fill(1));
    expect(computed).toBe(1);
  });

  it('single-flight still coalesces while Redis is down', async () => {
    const { cache } = build(deadRedis());
    let computed = 0;
    const fn = async () => ++computed;
    await Promise.all(Array.from({ length: 10 }, () => cache.getOrCompute('k', 30, fn)));
    expect(computed).toBe(1);
  });

  it('disabled: never touches Redis', async () => {
    const redis = fakeRedis();
    const { cache } = build(redis, { enabled: false });
    expect(await cache.getOrCompute('k', 30, async () => 1)).toBe(1);
    expect(redis.calls).toEqual([]);
  });
});

describe('Cache.getOrComputeVersioned', () => {
  it('reads the version once and uses the same key for GET and SET', async () => {
    const redis = fakeRedis();
    const { cache } = build(redis);
    await cache.getOrComputeVersioned('cat-1', 'product:p1', 30, async () => 'v');
    expect(redis.calls).toEqual(['get catver:cat-1', 'get product:p1:vcat-1.0', 'set product:p1:vcat-1.0']);
  });

  it('a bump makes the old key unreachable and the next call recomputes', async () => {
    const redis = fakeRedis();
    const { cache, versions } = build(redis);
    let computed = 0;
    const fn = async () => ++computed;

    expect(await cache.getOrComputeVersioned('cat-1', 'p', 30, fn)).toBe(1);
    expect(await cache.getOrComputeVersioned('cat-1', 'p', 30, fn)).toBe(1);
    await versions.bump(['cat-1']);
    expect(await cache.getOrComputeVersioned('cat-1', 'p', 30, fn)).toBe(2);
    expect(redis.store.has('p:vcat-1.0')).toBe(true); // orphaned, expires by TTL
    expect(redis.store.has('p:vcat-1.1')).toBe(true);
  });

  it('bump increments each distinct category once plus _all', async () => {
    const redis = fakeRedis();
    const { versions } = build(redis);
    await versions.bump(['a', 'b', 'a']);
    expect(redis.calls).toEqual(['incr catver:a', 'incr catver:b', `incr catver:${ALL_SCOPE}`]);
    await versions.bump([]);
    expect(redis.calls).toHaveLength(3);
  });

  it('fails open when the version read throws: computes without Redis and never 500s', async () => {
    const { cache, versions } = build(deadRedis());
    expect(await versions.current('cat-1')).toBeNull();
    await expect(cache.getOrComputeVersioned('cat-1', 'p', 30, async () => 'from-postgres')).resolves.toBe(
      'from-postgres',
    );
    await expect(versions.bump(['cat-1'])).resolves.toBeUndefined();
  });
});
