/**
 * Chunk processor: tests (b), (d), (e), (f) from the session brief, plus the
 * claim statement's duplicate-delivery and failure paths.
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../../src/config/index.js';
import { createDb, createPool, type Db, type Pool } from '../../src/db/index.js';
import type { InvocationContext } from '../../src/ingest/context.js';
import { ChunkProcessor } from '../../src/ingest/processor.js';
import { Splitter } from '../../src/ingest/splitter.js';
import { createLogger } from '../../src/shared/logger.js';
import { createJobForCsv, ingestFixture, type IngestFixture } from '../helpers/ingest.js';

const logger = createLogger({ level: 'silent', pretty: false });
const ctx: InvocationContext = { remainingTimeMs: () => 60_000 };
const HEADER = 'sku,name,category,cost,stock_quantity';
const CHUNK = 4;
const MAX_ATTEMPTS = 3;
const STALE_MS = 60_000;

let pool: Pool;
let db: Db;
let fx: IngestFixture;
let splitter: Splitter;
let processor: ChunkProcessor;

beforeAll(async () => {
  pool = createPool(env.TEST_DATABASE_URL);
  db = createDb(pool);
  fx = await ingestFixture(db, MAX_ATTEMPTS);
  splitter = new Splitter(
    { db, storage: fx.storage, splitQueue: fx.splitQueue, chunkQueue: fx.chunkQueue, logger, invalidation: fx.invalidation },
    { chunkSize: CHUNK, reserveMs: 1_000, maxAttempts: MAX_ATTEMPTS },
  );
  processor = new ChunkProcessor({ db, storage: fx.storage, logger, invalidation: fx.invalidation }, { maxAttempts: MAX_ATTEMPTS, staleAfterMs: STALE_MS });
});

afterAll(async () => {
  await fx.cleanup();
  await pool.end();
});

const u = () => Math.random().toString(36).slice(2, 8);
const csv = (...rows: string[]): string => [HEADER, ...rows].join('\n') + '\n';

async function splitJob(content: string) {
  const job = await createJobForCsv(db, fx.storage, content);
  await splitter.handle({ jobId: job.id }, ctx);
  return job;
}

async function product(sku: string) {
  return db
    .selectFrom('products')
    .innerJoin('categories', 'categories.id', 'products.category_id')
    .select(['sku', 'products.name', 'base_price', 'stock_quantity', 'source_seq', 'categories.name as category'])
    .where('sku', '=', sku)
    .executeTakeFirst();
}

async function chunk(jobId: string, index: number) {
  return db
    .selectFrom('ingest_chunks')
    .selectAll()
    .where('job_id', '=', jobId)
    .where('chunk_index', '=', index)
    .executeTakeFirstOrThrow();
}

async function jobStatus(jobId: string) {
  return (await db.selectFrom('ingest_jobs').select('status').where('id', '=', jobId).executeTakeFirstOrThrow()).status;
}

describe('ChunkProcessor', () => {
  it('prices, resolves categories, upserts, and records counts on the chunk', async () => {
    const cat = `Cat-${u()}`;
    const a = `A-${u()}`;
    const b = `B-${u()}`;
    const { id } = await splitJob(csv(`${a},Alpha,${cat},10.00,5`, `${b},Beta,Electronics,10.00,0`));

    await processor.handle({ jobId: id, chunkIndex: 0 }, ctx);

    expect(await product(a)).toMatchObject({ name: 'Alpha', base_price: '12.99', stock_quantity: 5, category: cat });
    expect(await product(b)).toMatchObject({ base_price: '11.99', category: 'Electronics' });
    const c = await chunk(id, 0);
    expect(c).toMatchObject({ status: 'DONE', attempts: 1, rows_valid: 2, rows_invalid: 0, rows_applied: 2 });
    expect(c.changed_category_ids).toHaveLength(2);
    expect(await jobStatus(id)).toBe('COMPLETED');
  });

  it('(b) later row wins for a duplicate SKU, across chunks in any processing order and within one chunk', async () => {
    const x = `X-${u()}`;
    const y = `Y-${u()}`;
    // rows 1..4 → chunk 0, 5..8 → chunk 1, 9..12 → chunk 2
    const { id } = await splitJob(
      csv(
        `${x},First,Shoes,10.00,1`, // row 1, chunk 0
        `${y},Y-first,Shoes,10.00,1`, // row 2, chunk 0
        `${y},Y-second,Shoes,20.00,2`, // row 3, chunk 0 (same chunk duplicate)
        `F1-${u()},Filler,Shoes,1.00,1`,
        `F2-${u()},Filler,Shoes,1.00,1`,
        `F3-${u()},Filler,Shoes,1.00,1`,
        `F4-${u()},Filler,Shoes,1.00,1`,
        `F5-${u()},Filler,Shoes,1.00,1`,
        `${x},Last,Shoes,30.00,3`, // row 9, chunk 2
      ),
    );

    // Newest chunk first, then the oldest: the old row must not overwrite.
    await processor.handle({ jobId: id, chunkIndex: 2 }, ctx);
    await processor.handle({ jobId: id, chunkIndex: 0 }, ctx);
    await processor.handle({ jobId: id, chunkIndex: 1 }, ctx);

    expect(await product(x)).toMatchObject({ name: 'Last', base_price: '38.99', stock_quantity: 3 });
    expect(await product(y)).toMatchObject({ name: 'Y-second', base_price: '25.99', stock_quantity: 2 });
    // chunk 0 had 3 valid rows but only Y was applied (X was outranked, Y-first deduped away).
    expect(await chunk(id, 0)).toMatchObject({ rows_valid: 3, rows_applied: 1 });
    expect(await jobStatus(id)).toBe('COMPLETED');
  });

  it('(d) a FAILED chunk replayed after a newer job wrote the same SKU does not overwrite the newer price', async () => {
    const z = `Z-${u()}`;
    const older = await splitJob(csv(`${z},Old,Shoes,10.00,1`));
    const newer = await splitJob(csv(`${z},New,Shoes,50.00,9`));

    await processor.handle({ jobId: newer.id, chunkIndex: 0 }, ctx);
    expect(await product(z)).toMatchObject({ name: 'New', base_price: '64.99' });

    // The older job's chunk failed earlier (simulated) and is replayed now.
    await db
      .updateTable('ingest_chunks')
      .set({ status: 'FAILED', attempts: 1, error: 'simulated' })
      .where('job_id', '=', older.id)
      .execute();
    await processor.handle({ jobId: older.id, chunkIndex: 0 }, ctx);

    expect(await product(z)).toMatchObject({ name: 'New', base_price: '64.99', stock_quantity: 9 });
    expect(await chunk(older.id, 0)).toMatchObject({ status: 'DONE', attempts: 2, rows_valid: 1, rows_applied: 0, changed_category_ids: [] });
    expect(await jobStatus(older.id)).toBe('COMPLETED');
  });

  it('(e) a poisoned chunk lands its valid rows and records every bad row with a path', async () => {
    const good = `G-${u()}`;
    const short = `S-${u()}`;
    const badCost = `C-${u()}`;
    const belowCost = `B-${u()}`;
    const { id } = await splitJob(
      csv(
        `${good},Good,Shoes,10.00,1`,
        `${short},Short row`,
        `${badCost},Bad cost,Shoes,ten,1`,
        `${belowCost},Cheap,Electronics,1.00,1`, // 1.15 → 0.99 < cost: pricing rule rejects
      ),
    );

    await processor.handle({ jobId: id, chunkIndex: 0 }, ctx);

    expect(await product(good)).toMatchObject({ base_price: '12.99' });
    expect(await product(short)).toBeUndefined();
    expect(await product(badCost)).toBeUndefined();
    expect(await product(belowCost)).toBeUndefined();

    const errors = await db
      .selectFrom('ingest_row_errors')
      .select(['row_no', 'sku', 'errors', 'raw'])
      .where('job_id', '=', id)
      .orderBy('row_no')
      .execute();
    expect(errors.map((e) => [e.row_no, e.sku])).toEqual([
      [2, short],
      [3, badCost],
      [4, belowCost],
    ]);
    expect(errors[0]!.errors.map((e) => e.path).sort()).toEqual(['category', 'cost', 'stock_quantity']);
    expect(errors[1]!.errors[0]).toMatchObject({ path: 'cost' });
    expect(errors[2]!.errors[0]).toMatchObject({ path: 'cost', message: expect.stringMatching(/below vendor cost 1\.00/) });
    expect(errors[1]!.raw).toEqual({ sku: badCost, name: 'Bad cost', category: 'Shoes', cost: 'ten', stock_quantity: '1' });

    expect(await chunk(id, 0)).toMatchObject({ status: 'DONE', rows_valid: 1, rows_invalid: 3, rows_applied: 1 });
    expect(await jobStatus(id)).toBe('COMPLETED');
  });

  it('(f) reclaims a chunk stuck in PROCESSING with a stale updated_at, but not a fresh one', async () => {
    const s = `R-${u()}`;
    const { id } = await splitJob(csv(`${s},Stuck,Shoes,10.00,1`));

    // Fresh PROCESSING: another worker has it → skip.
    await db.updateTable('ingest_chunks').set({ status: 'PROCESSING', attempts: 1, updated_at: sql`now()` }).where('job_id', '=', id).execute();
    await processor.handle({ jobId: id, chunkIndex: 0 }, ctx);
    expect(await product(s)).toBeUndefined();
    expect(await chunk(id, 0)).toMatchObject({ status: 'PROCESSING', attempts: 1 });

    // Stale PROCESSING: the worker died → reclaim and finish.
    await db
      .updateTable('ingest_chunks')
      .set({ updated_at: sql`now() - make_interval(secs => ${(STALE_MS * 2) / 1000})` })
      .where('job_id', '=', id)
      .execute();
    await processor.handle({ jobId: id, chunkIndex: 0 }, ctx);
    expect(await product(s)).toMatchObject({ base_price: '12.99' });
    expect(await chunk(id, 0)).toMatchObject({ status: 'DONE', attempts: 2 });
    expect(await jobStatus(id)).toBe('COMPLETED');
  });

  it('ignores a duplicate delivery for a DONE chunk', async () => {
    const s = `D-${u()}`;
    const { id } = await splitJob(csv(`${s},Once,Shoes,10.00,1`));
    await processor.handle({ jobId: id, chunkIndex: 0 }, ctx);
    await processor.handle({ jobId: id, chunkIndex: 0 }, ctx);
    expect(await chunk(id, 0)).toMatchObject({ status: 'DONE', attempts: 1 });
  });

  it('marks the chunk FAILED outside the transaction and rethrows; the last exhausted failure makes the job PARTIAL', async () => {
    const { id } = await splitJob(csv(`E-${u()},Err,Shoes,10.00,1`));
    await fx.storage.delete(`chunks/${id}/0.jsonl`); // make the read fail deterministically

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await expect(processor.handle({ jobId: id, chunkIndex: 0 }, ctx)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await chunk(id, 0)).toMatchObject({ status: 'FAILED', attempts: attempt, error: expect.stringMatching(/ENOENT/) });
      expect(await jobStatus(id)).toBe(attempt < MAX_ATTEMPTS ? 'SPLIT_DONE' : 'PARTIAL');
    }
  });

  it('re-ingesting an unchanged price applies the row (newer source_seq) but reports no changed category', async () => {
    const s = `U-${u()}`;
    const first = await splitJob(csv(`${s},Same,Shoes,10.00,1`));
    await processor.handle({ jobId: first.id, chunkIndex: 0 }, ctx);
    const second = await splitJob(csv(`${s},Same,Shoes,10.00,7`));
    await processor.handle({ jobId: second.id, chunkIndex: 0 }, ctx);

    expect(await product(s)).toMatchObject({ base_price: '12.99', stock_quantity: 7 });
    expect(await chunk(second.id, 0)).toMatchObject({ rows_applied: 1, changed_category_ids: [] });
  });
});
