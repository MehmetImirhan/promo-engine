/**
 * Boots the real Express app against TEST_DATABASE_URL on an ephemeral port
 * and returns a tiny fetch wrapper. Redis is created lazily and never
 * connected: no route under test needs it, and /ready is not exercised here.
 */
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/app.js';
import { createRedis } from '../../src/cache/redis.js';
import { env } from '../../src/config/index.js';
import { createDb, createPool, type Db, type Pool } from '../../src/db/index.js';
import { createLogger } from '../../src/shared/logger.js';

export interface JsonResponse<T = unknown> {
  status: number;
  body: T;
}

export interface TestApp {
  pool: Pool;
  db: Db;
  get<T = unknown>(path: string): Promise<JsonResponse<T>>;
  post<T = unknown>(path: string, body?: unknown): Promise<JsonResponse<T>>;
  close(): Promise<void>;
}

export async function startTestApp(): Promise<TestApp> {
  const pool = createPool(env.TEST_DATABASE_URL);
  const db = createDb(pool);
  const redis = createRedis(env.REDIS_URL);
  const logger = createLogger({ level: 'silent', pretty: false });

  const app = createApp({ pool, db, redis, logger });
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  async function request<T>(method: string, path: string, body?: unknown): Promise<JsonResponse<T>> {
    const res = await fetch(baseUrl + path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as T };
  }

  return {
    pool,
    db,
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      redis.disconnect();
      await pool.end();
    },
  };
}
