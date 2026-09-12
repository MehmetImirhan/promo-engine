/**
 * Splitter: bounded, resumable, idempotent. Test (c) from the session brief
 * plus the derived completion check.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../../src/config/index.js';
import { createDb, createPool, type Db, type Pool } from '../../src/db/index.js';
import { checkJobCompletion } from '../../src/ingest/completion.js';
import type { InvocationContext } from '../../src/ingest/context.js';
import { Splitter } from '../../src/ingest/splitter.js';
import { createLogger } from '../../src/shared/logger.js';
import { createJobForCsv, ingestFixture, messyCsv, readChunk, readChunkRaw, type IngestFixture } from '../helpers/ingest.js';

const logger = createLogger({ level: 'silent', pretty: false });
const plenty: InvocationContext = { remainingTimeMs: () => 60_000 };
const none: InvocationContext = { remainingTimeMs: () => 0 };
const CHUNK = 4;
const ROWS = 25; // 6 full chunks + 1 row

let pool: Pool;
let db: Db;
let fx: IngestFixture;
let splitter: Splitter;

beforeAll(async () => {
  pool = createPool(env.TEST_DATABASE_URL);
  db = createDb(pool);
  fx = await ingestFixture(db);
  splitter = new Splitter(
    { db, storage: fx.storage, splitQueue: fx.splitQueue, chunkQueue: fx.chunkQueue, logger, invalidation: fx.invalidation },
    { chunkSize: CHUNK, reserveMs: 1_000, maxAttempts: 3 },
  );
});

afterAll(async () => {
  await fx.cleanup();
  await pool.end();
});

async function chunkRows(jobId: string) {
  return db
    .selectFrom('ingest_chunks')
    .select(['chunk_index', 'row_count', 'status'])
    .where('job_id', '=', jobId)
    .orderBy('chunk_index')
    .execute();
}

async function job(jobId: string) {
  return db.selectFrom('ingest_jobs').selectAll().where('id', '=', jobId).executeTakeFirstOrThrow();
}

describe('Splitter', () => {
  it('splits a messy file in one invocation into contiguous chunks with file-global row numbers', async () => {
    const { id } = await createJobForCsv(db, fx.storage, messyCsv(ROWS));
    await splitter.handle({ jobId: id }, plenty);

    const j = await job(id);
    expect(j.status).toBe('SPLIT_DONE');
    expect(j.next_chunk_index).toBe(7);
    expect(j.split_invocations).toBe(1);

    const chunks = await chunkRows(id);
    expect(chunks.map((c) => c.row_count)).toEqual([4, 4, 4, 4, 4, 4, 1]);

    const rowNos: number[] = [];
    for (let i = 0; i < 7; i++) rowNos.push(...(await readChunk(fx.storage, id, i)).map((r) => r.row_no));
    expect(rowNos).toEqual(Array.from({ length: ROWS }, (_, i) => i + 1));

    // Quoted newline, BOM-stripped header, and the short row all survived as records.
    const first = await readChunk(fx.storage, id, 0);
    expect(first[0]!.raw).toEqual({ sku: 'SKU-1', name: 'Name 1', category: 'Accessories', cost: '1.25', stock_quantity: '1' });
    const seventh = (await readChunk(fx.storage, id, 1))[2]!; // row 7
    expect(seventh.raw.name).toBe('Name 7, "quoted"\nsecond line');
    const eleventh = (await readChunk(fx.storage, id, 2))[2]!; // row 11
    expect(eleventh.raw).toEqual({ sku: 'SKU-11', name: 'Short row' });

    expect(fx.chunkQueue.enqueued.filter((m) => m.payload.jobId === id).map((m) => m.payload.chunkIndex)).toEqual([
      0, 1, 2, 3, 4, 5, 6,
    ]);
  });

  it('(c) stops when time is low, re-enqueues itself, and completes with zero duplicate chunks', async () => {
    const reference = await createJobForCsv(db, fx.storage, messyCsv(ROWS));
    await splitter.handle({ jobId: reference.id }, plenty);

    const { id } = await createJobForCsv(db, fx.storage, messyCsv(ROWS));
    const before = fx.chunkQueue.enqueued.length;

    // Every invocation sees no time left after its first chunk → one chunk per invocation.
    await fx.splitQueue.enqueue({ jobId: id }, { id: `split:${id}:0` });
    const invocations = await fx.splitQueue.drain((d) => splitter.handle(d.payload, none));

    const j = await job(id);
    expect(j.status).toBe('SPLIT_DONE');
    expect(invocations).toBe(7); // 6 continuations + the final one that hits EOF
    expect(j.split_invocations).toBe(7);
    expect(j.next_chunk_index).toBe(7);

    const chunks = await chunkRows(id);
    expect(chunks.map((c) => c.chunk_index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(chunks.map((c) => c.row_count)).toEqual([4, 4, 4, 4, 4, 4, 1]);

    // Every chunk message enqueued exactly once.
    const enqueued = fx.chunkQueue.enqueued.slice(before).filter((m) => m.payload.jobId === id);
    expect(enqueued.map((m) => m.payload.chunkIndex)).toEqual([0, 1, 2, 3, 4, 5, 6]);

    // Byte-identical to the uninterrupted split of the same file.
    for (let i = 0; i < 7; i++) {
      expect(await readChunkRaw(fx.storage, id, i)).toBe(await readChunkRaw(fx.storage, reference.id, i));
    }
  });

  it('ignores a duplicate split message for a job that is already SPLIT_DONE', async () => {
    const { id } = await createJobForCsv(db, fx.storage, messyCsv(5));
    await splitter.handle({ jobId: id }, plenty);
    const before = fx.chunkQueue.enqueued.length;

    await splitter.handle({ jobId: id }, plenty);

    expect((await job(id)).split_invocations).toBe(1);
    expect(fx.chunkQueue.enqueued.length).toBe(before);
  });

  it('fails the job, not the process, when the header lacks a required column', async () => {
    const { id } = await createJobForCsv(db, fx.storage, 'sku,name,price\nA,Alpha,1.00\n');
    await splitter.handle({ jobId: id }, plenty);
    const j = await job(id);
    expect(j.status).toBe('FAILED');
    expect(j.error).toMatch(/missing required columns: category, cost, stock_quantity/);
    expect(await chunkRows(id)).toEqual([]);
  });

  it('fails the job on unparseable CSV', async () => {
    const { id } = await createJobForCsv(db, fx.storage, 'sku,name,category,cost,stock_quantity\nA,"unterminated,Shoes,1.00,1\n');
    await splitter.handle({ jobId: id }, plenty);
    expect((await job(id)).status).toBe('FAILED');
  });

  it('completes a header-only file immediately', async () => {
    const { id } = await createJobForCsv(db, fx.storage, 'sku,name,category,cost,stock_quantity\n');
    await splitter.handle({ jobId: id }, plenty);
    const j = await job(id);
    expect(j.status).toBe('COMPLETED');
    expect(j.completed_at).not.toBeNull();
  });
});

describe('checkJobCompletion', () => {
  async function jobWithChunks(status: 'SPLITTING' | 'SPLIT_DONE', chunks: Array<{ status: string; attempts: number }>) {
    const { id } = await createJobForCsv(db, fx.storage, 'sku,name,category,cost,stock_quantity\n');
    await db.updateTable('ingest_jobs').set({ status }).where('id', '=', id).execute();
    for (const [i, c] of chunks.entries()) {
      await db
        .insertInto('ingest_chunks')
        .values({ job_id: id, chunk_index: i, row_count: 1, status: c.status as 'DONE', attempts: c.attempts })
        .execute();
    }
    return id;
  }

  it('does nothing until the splitter is done', async () => {
    const id = await jobWithChunks('SPLITTING', [{ status: 'DONE', attempts: 1 }]);
    expect(await checkJobCompletion(db, id, 3)).toBeNull();
    expect((await job(id)).status).toBe('SPLITTING');
  });

  it('does nothing while a chunk is pending, processing, or failed with retries left', async () => {
    for (const chunk of [
      { status: 'PENDING', attempts: 0 },
      { status: 'PROCESSING', attempts: 1 },
      { status: 'FAILED', attempts: 2 },
    ]) {
      const id = await jobWithChunks('SPLIT_DONE', [{ status: 'DONE', attempts: 1 }, chunk]);
      expect(await checkJobCompletion(db, id, 3)).toBeNull();
    }
  });

  it('is COMPLETED when every chunk is DONE, PARTIAL when a chunk failed for good', async () => {
    const done = await jobWithChunks('SPLIT_DONE', [{ status: 'DONE', attempts: 1 }, { status: 'DONE', attempts: 2 }]);
    expect(await checkJobCompletion(db, done, 3)).toBe('COMPLETED');

    const partial = await jobWithChunks('SPLIT_DONE', [{ status: 'DONE', attempts: 1 }, { status: 'FAILED', attempts: 3 }]);
    expect(await checkJobCompletion(db, partial, 3)).toBe('PARTIAL');
    // A second call after completion matches nothing.
    expect(await checkJobCompletion(db, partial, 3)).toBeNull();
  });
});
