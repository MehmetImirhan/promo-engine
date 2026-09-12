/**
 * source_seq ordering, evaluated by Postgres on the real fragment (the value
 * is only ever computed in SQL, so this is its unit test).
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../../src/config/index.js';
import { createDb, createPool, type Db, type Pool } from '../../src/db/index.js';
import { sourceSeq } from '../../src/ingest/source-seq.sql.js';

let pool: Pool;
let db: Db;

beforeAll(() => {
  pool = createPool(env.TEST_DATABASE_URL);
  db = createDb(pool);
});

afterAll(async () => {
  await pool.end();
});

async function seq(jobSeq: number, rowNo: number): Promise<bigint> {
  const row = await db
    .selectNoFrom(sourceSeq(sql`${jobSeq}`, sql`${rowNo}`).as('v'))
    .executeTakeFirstOrThrow();
  return BigInt(row.v);
}

describe('source_seq', () => {
  it('is (job_seq << 32) | row_no as a bigint string', async () => {
    expect(await seq(1, 1)).toBe((1n << 32n) | 1n);
    expect(await seq(7, 123_456)).toBe((7n << 32n) | 123_456n);
  });

  it('orders a later row in the same file above an earlier one', async () => {
    expect(await seq(5, 2)).toBeGreaterThan(await seq(5, 1));
  });

  it('orders any row of a later job above every row of an earlier job', async () => {
    const lastRowOfOldJob = await seq(5, 2 ** 32 - 1);
    const firstRowOfNewJob = await seq(6, 1);
    expect(firstRowOfNewJob).toBeGreaterThan(lastRowOfOldJob);
  });

  it('stays inside a signed bigint at the job_seq ceiling the schema enforces', async () => {
    const max = await seq(2 ** 31 - 1, 2 ** 32 - 1);
    expect(max).toBeLessThan(2n ** 63n);
    expect(max).toBeGreaterThan(0n);
  });

  it('is 0 for never-ingested products, which any ingest row outranks', async () => {
    expect(await seq(1, 1)).toBeGreaterThan(0n);
  });
});
