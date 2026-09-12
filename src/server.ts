import type { Server } from 'node:http';
import { createApp } from './app.js';
import { Cache, CategoryVersions, createRedis } from './cache/index.js';
import { ConfigError } from './config/env.js';
import { createDb, createPool } from './db/index.js';
import { createIngestQueues, createQueueConnection } from './queue/index.js';
import { createLogger } from './shared/logger.js';
import { LocalStorage } from './storage/index.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  // Imported lazily so a ConfigError is logged, not thrown as an uncaught import error.
  const { env } = await import('./config/index.js');
  const logger = createLogger({ level: env.LOG_LEVEL, pretty: env.NODE_ENV === 'development' });

  const pool = createPool(env.DATABASE_URL);
  pool.on('error', (err) => logger.error({ err }, 'idle postgres client error'));
  const db = createDb(pool);

  const redis = createRedis(env.REDIS_URL);
  redis.on('error', (err) => logger.warn({ err: err.message }, 'redis connection error'));
  // Fail open: the API starts even if Redis is down; ioredis keeps retrying in the background.
  redis.connect().catch((err: Error) => logger.warn({ err: err.message }, 'redis unavailable at startup'));
  const cache = new Cache(redis, new CategoryVersions(redis, logger), logger, {
    enabled: env.CACHE_ENABLED,
    singleFlight: env.CACHE_SINGLE_FLIGHT,
  });

  // Ingest: the API only enqueues; src/worker.ts consumes.
  const queueConnection = createQueueConnection(env.REDIS_URL);
  queueConnection.on('error', (err) => logger.warn({ err: err.message }, 'queue redis connection error'));
  const queues = createIngestQueues({
    connection: queueConnection,
    logger,
    maxAttempts: env.INGEST_MAX_ATTEMPTS,
    invocationTimeoutMs: env.INGEST_INVOCATION_TIMEOUT_MS,
  });
  const storage = new LocalStorage(env.STORAGE_DIR);

  const app = createApp({
    pool,
    db,
    redis,
    cache,
    logger,
    storage,
    queues,
    ingest: { staleAfterMs: env.INGEST_INVOCATION_TIMEOUT_MS },
  });
  const server: Server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'api listening');
  });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    const forceExit = setTimeout(() => {
      logger.error('shutdown timed out; exiting');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    server.close(() => {
      void Promise.allSettled([queues.close(), queueConnection.quit(), pool.end(), redis.quit()]).then(() => {
        logger.info('shutdown complete');
        process.exit(0);
      });
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err: unknown) => {
  const fallback = createLogger({ level: 'info', pretty: false });
  if (err instanceof ConfigError) {
    fallback.fatal({ keys: err.keys, issues: err.issues }, err.message);
  } else {
    fallback.fatal({ err }, 'startup failed');
  }
  process.exit(1);
});
