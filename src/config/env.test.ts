import { describe, expect, it } from 'vitest';
import { ConfigError, loadEnv } from './env.js';

describe('loadEnv', () => {
  it('applies defaults when nothing is set', () => {
    const env = loadEnv({});
    expect(env).toEqual({
      NODE_ENV: 'development',
      PORT: 3000,
      LOG_LEVEL: 'info',
      DATABASE_URL: 'postgres://promo:promo@localhost:5432/promo',
      REDIS_URL: 'redis://localhost:6379',
      TEST_DATABASE_URL: 'postgres://promo:promo@localhost:5432/promo_test',
      STORAGE_DIR: './data',
      INGEST_CHUNK_SIZE: 1000,
      INGEST_WORKER_CONCURRENCY: 4,
      INGEST_MAX_ATTEMPTS: 3,
      INGEST_INVOCATION_TIMEOUT_MS: 60_000,
      INGEST_SPLIT_RESERVE_MS: 2000,
    });
  });

  it('caps the chunk size (it is a memory bound, not a SQL parameter limit)', () => {
    expect(() => loadEnv({ INGEST_CHUNK_SIZE: '10001' })).toThrow(ConfigError);
    expect(loadEnv({ INGEST_CHUNK_SIZE: '10000' }).INGEST_CHUNK_SIZE).toBe(10_000);
  });

  it('rejects a split reserve that is not below the invocation timeout', () => {
    let caught: unknown;
    try {
      loadEnv({ INGEST_INVOCATION_TIMEOUT_MS: '2000', INGEST_SPLIT_RESERVE_MS: '2000' });
    } catch (err) {
      caught = err;
    }
    expect((caught as ConfigError).keys).toEqual(['INGEST_SPLIT_RESERVE_MS']);
  });

  it('coerces numeric strings', () => {
    expect(loadEnv({ PORT: '8080' }).PORT).toBe(8080);
  });

  it('reports every invalid key at once', () => {
    let caught: unknown;
    try {
      loadEnv({
        PORT: 'abc',
        LOG_LEVEL: 'loud',
        DATABASE_URL: 'mysql://nope',
        REDIS_URL: 'redis://ok:6379',
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ConfigError);
    const error = caught as ConfigError;
    expect(error.keys).toEqual(['DATABASE_URL', 'LOG_LEVEL', 'PORT']);
    expect(error.message).toContain('PORT');
    expect(error.message).toContain('LOG_LEVEL');
    expect(error.message).toContain('DATABASE_URL');
  });
});
