/**
 * Boots the real Express app against TEST_DATABASE_URL and TEST_REDIS_URL on
 * an ephemeral port and returns a tiny fetch wrapper. Ingest runs on a temp
 * LocalStorage and in-memory queues the test can drain. `redisUrl` can point
 * at an unreachable address to exercise the fail-open path.
 */
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/app.js';
import { Cache, CategoryVersions, createRedis, type Redis } from '../../src/cache/index.js';
import { env } from '../../src/config/index.js';
import { createDb, createPool, type Db, type Pool } from '../../src/db/index.js';
import { createLogger } from '../../src/shared/logger.js';
import { ingestFixture, type IngestFixture } from './ingest.js';

export interface JsonResponse<T = unknown> {
  status: number;
  body: T;
}

export interface MultipartBody {
  fields?: Record<string, string>;
  file?: { name: string; content: string };
}

export interface TestAppOptions {
  redisUrl?: string;
}

export interface TestApp {
  pool: Pool;
  db: Db;
  redis: Redis;
  cache: Cache;
  ingest: IngestFixture;
  get<T = unknown>(path: string): Promise<JsonResponse<T>>;
  post<T = unknown>(path: string, body?: unknown): Promise<JsonResponse<T>>;
  upload<T = unknown>(path: string, body: MultipartBody): Promise<JsonResponse<T>>;
  close(): Promise<void>;
}

export async function startTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const pool = createPool(env.TEST_DATABASE_URL);
  const db = createDb(pool);
  const logger = createLogger({ level: 'silent', pretty: false });
  const redis = createRedis(options.redisUrl ?? env.TEST_REDIS_URL);
  redis.on('error', () => undefined); // fail-open paths are exercised on purpose; ioredis must not emit unhandled errors
  await redis.connect().catch(() => undefined);
  const cache = new Cache(redis, new CategoryVersions(redis, logger), logger);

  const ingest = await ingestFixture(db, env.INGEST_MAX_ATTEMPTS, cache.versions);
  const app = createApp({
    pool,
    db,
    redis,
    cache,
    logger,
    storage: ingest.storage,
    queues: { split: ingest.splitQueue, processChunk: ingest.chunkQueue, deadLetter: ingest.dlq },
    ingest: { staleAfterMs: env.INGEST_INVOCATION_TIMEOUT_MS },
  });
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

  async function upload<T>(path: string, body: MultipartBody): Promise<JsonResponse<T>> {
    const form = new FormData();
    for (const [k, v] of Object.entries(body.fields ?? {})) form.append(k, v);
    if (body.file) form.append('file', new Blob([body.file.content], { type: 'text/csv' }), body.file.name);
    const res = await fetch(baseUrl + path, { method: 'POST', body: form });
    return { status: res.status, body: (await res.json()) as T };
  }

  return {
    pool,
    db,
    redis,
    cache,
    ingest,
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
    upload,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      redis.disconnect();
      await ingest.cleanup();
      await pool.end();
    },
  };
}
