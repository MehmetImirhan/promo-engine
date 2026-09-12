/**
 * Ingest worker: the BullMQ adapter around the splitter and the processor.
 *
 * All pipeline logic lives in `Splitter.handle(event, ctx)` and
 * `ChunkProcessor.handle(event, ctx)`. This file only builds their
 * dependencies, turns a queue delivery into (event, ctx), and shuts down
 * cleanly. The equivalent Lambda entry points would be:
 *
 *   export const split = (event, lambdaCtx) =>
 *     splitter.handle(event, { remainingTimeMs: () => lambdaCtx.getRemainingTimeInMillis() });
 *   export const processChunk = (event, lambdaCtx) =>
 *     processor.handle(event, { remainingTimeMs: () => lambdaCtx.getRemainingTimeInMillis() });
 *
 * Here the context is a deadline of INGEST_INVOCATION_TIMEOUT_MS from the
 * moment the delivery starts, which is what forces the splitter to
 * checkpoint and continue instead of running for the length of the file.
 *
 *   npm run worker                       # both queues
 *   npm run worker -- --only split       # one queue (used by scripts/ingest/measure.sh
 *   npm run worker -- --only process-chunk   # to measure the two stages separately)
 */
import { parseArgs } from 'node:util';
import { ConfigError } from './config/env.js';
import { createDb, createPool } from './db/index.js';
import { contextWithDeadline } from './ingest/context.js';
import { ChunkProcessor } from './ingest/processor.js';
import { Splitter } from './ingest/splitter.js';
import { createIngestQueues, createQueueConnection, type QueueWorker } from './queue/index.js';
import { createLogger } from './shared/logger.js';
import { LocalStorage } from './storage/index.js';

const SHUTDOWN_TIMEOUT_MS = 30_000;

async function main(): Promise<void> {
  const { env } = await import('./config/index.js');
  const { values } = parseArgs({ options: { only: { type: 'string' } } });
  const only = values.only;
  if (only !== undefined && only !== 'split' && only !== 'process-chunk') {
    throw new Error(`--only must be "split" or "process-chunk", got ${JSON.stringify(only)}`);
  }

  const logger = createLogger({ level: env.LOG_LEVEL, pretty: env.NODE_ENV === 'development' });
  const pool = createPool(env.DATABASE_URL);
  pool.on('error', (err) => logger.error({ err }, 'idle postgres client error'));
  const db = createDb(pool);
  const storage = new LocalStorage(env.STORAGE_DIR);

  const connection = createQueueConnection(env.REDIS_URL);
  connection.on('error', (err) => logger.warn({ err: err.message }, 'queue redis connection error'));
  const queues = createIngestQueues({
    connection,
    logger,
    maxAttempts: env.INGEST_MAX_ATTEMPTS,
    invocationTimeoutMs: env.INGEST_INVOCATION_TIMEOUT_MS,
  });

  const splitter = new Splitter(
    { db, storage, splitQueue: queues.split, chunkQueue: queues.processChunk, logger },
    { chunkSize: env.INGEST_CHUNK_SIZE, reserveMs: env.INGEST_SPLIT_RESERVE_MS, maxAttempts: env.INGEST_MAX_ATTEMPTS },
  );
  const processor = new ChunkProcessor(
    { db, storage, logger },
    { maxAttempts: env.INGEST_MAX_ATTEMPTS, staleAfterMs: env.INGEST_INVOCATION_TIMEOUT_MS },
  );

  const invocation = () => contextWithDeadline(env.INGEST_INVOCATION_TIMEOUT_MS);
  const workers: QueueWorker[] = [];
  if (only !== 'process-chunk') {
    workers.push(
      queues.split.consume((d) => splitter.handle(d.payload, invocation()), { concurrency: env.INGEST_WORKER_CONCURRENCY }),
    );
  }
  if (only !== 'split') {
    workers.push(
      queues.processChunk.consume((d) => processor.handle(d.payload, invocation()), {
        concurrency: env.INGEST_WORKER_CONCURRENCY,
      }),
    );
  }
  logger.info(
    {
      queues: only ?? 'split,process-chunk',
      concurrency: env.INGEST_WORKER_CONCURRENCY,
      invocationTimeoutMs: env.INGEST_INVOCATION_TIMEOUT_MS,
      chunkSize: env.INGEST_CHUNK_SIZE,
    },
    'ingest worker started',
  );

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'worker shutting down');
    const forceExit = setTimeout(() => {
      logger.error('worker shutdown timed out; exiting');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    // Worker.close() waits for in-flight deliveries; anything not finished is redelivered after lockDuration.
    void Promise.allSettled(workers.map((w) => w.close()))
      .then(() => Promise.allSettled([queues.close(), connection.quit(), pool.end()]))
      .then(() => {
        logger.info('worker shutdown complete');
        process.exit(0);
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
    fallback.fatal({ err }, 'worker startup failed');
  }
  process.exit(1);
});
