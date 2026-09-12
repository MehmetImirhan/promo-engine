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
    });
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
