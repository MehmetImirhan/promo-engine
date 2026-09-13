/**
 * replay-failed against the real BullMQ driver. The in-memory queue accepts
 * any enqueue; BullMQ ignores an add whose id already exists, and an
 * exhausted chunk's record stays in the failed set. This test is the one
 * that fails if the replay forgets to remove that record first: the chunk
 * is "replayed" and never runs, and the job sits in SPLIT_DONE for good.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../../src/config/index.js';
import { createDb, createPool, type Db, type Pool } from '../../src/db/index.js';
import type { InvocationContext } from '../../src/ingest/context.js';
import { IngestInvalidation } from '../../src/ingest/invalidation.js';
import { ChunkProcessor } from '../../src/ingest/processor.js';
import { IngestService } from '../../src/ingest/service.js';
import { chunkKey, Splitter } from '../../src/ingest/splitter.js';
import { BullmqQueue, createQueueConnection, type ProcessChunkMessage, type QueueWorker, type SplitMessage } from '../../src/queue/index.js';
import { createLogger } from '../../src/shared/logger.js';
import { LocalStorage } from '../../src/storage/index.js';
import { createJobForCsv, memoryVersions } from '../helpers/ingest.js';

const logger = createLogger({ level: 'silent', pretty: false });
const ctx: InvocationContext = { remainingTimeMs: () => 60_000 };
const prefix = `test:${randomUUID().slice(0, 8)}`;
const MAX_ATTEMPTS = 1;
const STALE_MS = 60_000;

let pool: Pool;
let db: Db;
let root: string;
let storage: LocalStorage;
let connection: ReturnType<typeof createQueueConnection>;
let split: BullmqQueue<SplitMessage>;
let processChunk: BullmqQueue<ProcessChunkMessage>;
let deadLetter: BullmqQueue<ProcessChunkMessage>;
let service: IngestService;
let splitter: Splitter;
let worker: QueueWorker;

async function until(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 50));
  }
}

const jobStatus = async (id: string) =>
  (await db.selectFrom('ingest_jobs').select('status').where('id', '=', id).executeTakeFirstOrThrow()).status;

beforeAll(async () => {
  pool = createPool(env.TEST_DATABASE_URL);
  db = createDb(pool);
  root = await mkdtemp(path.join(os.tmpdir(), 'promo-replay-'));
  storage = new LocalStorage(root);
  connection = createQueueConnection(env.TEST_REDIS_URL);
  const base = { connection, logger, backoffMs: 10, lockDurationMs: 5_000, prefix };
  deadLetter = new BullmqQueue('dlq', { ...base, maxAttempts: 1 });
  processChunk = new BullmqQueue('process-chunk', { ...base, maxAttempts: MAX_ATTEMPTS, deadLetter });
  split = new BullmqQueue('split', { ...base, maxAttempts: MAX_ATTEMPTS });

  const invalidation = new IngestInvalidation(db, memoryVersions());
  service = new IngestService(db, storage, { split, processChunk, deadLetter }, invalidation, {
    staleAfterMs: STALE_MS,
    maxAttempts: MAX_ATTEMPTS,
  });
  splitter = new Splitter(
    { db, storage, splitQueue: split, chunkQueue: processChunk, logger, invalidation },
    { chunkSize: 10, reserveMs: 1_000, maxAttempts: MAX_ATTEMPTS },
  );
  const processor = new ChunkProcessor({ db, storage, logger, invalidation }, { maxAttempts: MAX_ATTEMPTS, staleAfterMs: STALE_MS });
  worker = processChunk.consume((d) => processor.handle(d.payload, ctx), { concurrency: 1 });
});

afterAll(async () => {
  await worker.close();
  await Promise.all([split.close(), processChunk.close(), deadLetter.close()]);
  const keys = await connection.keys(`${prefix}:*`);
  if (keys.length > 0) await connection.del(...keys);
  await connection.quit();
  await rm(root, { recursive: true, force: true });
  await pool.end();
});

describe('POST /ingest/jobs/:id/replay-failed on BullMQ', () => {
  it('re-runs a dead-lettered chunk whose id still exists in the failed set, and the job completes', async () => {
    const sku = `RB-${randomUUID().slice(0, 8)}`;
    const { id } = await createJobForCsv(db, storage, `sku,name,category,cost,stock_quantity\n${sku},Replayed,Shoes,10.00,1\n`);

    // Split, then make the only chunk unreadable before the worker gets to it.
    // With one attempt the processor's ENOENT parks the message in the DLQ and the job ends PARTIAL.
    await worker.close();
    await splitter.handle({ jobId: id }, ctx);
    const chunkBody = await storage.getStream(chunkKey(id, 0)).then((s) => new Response(s as never).text());
    await storage.delete(chunkKey(id, 0));
    const processor = new ChunkProcessor(
      { db, storage, logger, invalidation: new IngestInvalidation(db, memoryVersions()) },
      { maxAttempts: MAX_ATTEMPTS, staleAfterMs: STALE_MS },
    );
    worker = processChunk.consume((d) => processor.handle(d.payload, ctx), { concurrency: 1 });
    await until(async () => (await jobStatus(id)) === 'PARTIAL');
    await until(async () => (await deadLetter.waitingCount()) === 1);
    expect(await processChunk.waitingCount()).toBe(0);

    // Restore the chunk and replay. The old record is still in BullMQ's failed set under the same id.
    await storage.put(chunkKey(id, 0), Readable.from([chunkBody]));
    const replay = await service.replayFailed(id);
    expect(replay).toEqual({ job_id: id, replayed_chunks: [0], split_reenqueued: false });
    expect(await deadLetter.waitingCount()).toBe(0);

    await until(async () => (await jobStatus(id)) === 'COMPLETED');
    const chunk = await db.selectFrom('ingest_chunks').selectAll().where('job_id', '=', id).executeTakeFirstOrThrow();
    expect(chunk).toMatchObject({ status: 'DONE', attempts: 2, rows_applied: 1 });
    expect(await db.selectFrom('products').select('base_price').where('sku', '=', sku).executeTakeFirst()).toEqual({ base_price: '12.99' });
  });
});
