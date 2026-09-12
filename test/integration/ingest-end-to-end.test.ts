/**
 * Test (a): a generated 5k-row file with duplicates and malformed rows goes
 * through POST /ingest/jobs → split → process (in-memory queues) → COMPLETED,
 * with counts and the final catalog matching the generator's oracle.
 */
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { text } from 'node:stream/consumers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateCsv, type GenerateSummary } from '../../scripts/ingest/generate.js';
import { env } from '../../src/config/index.js';
import type { InvocationContext } from '../../src/ingest/context.js';
import { priceRow } from '../../src/ingest/pricing-rules.js';
import { ChunkProcessor } from '../../src/ingest/processor.js';
import type { JobStatusView } from '../../src/ingest/service.js';
import { Splitter } from '../../src/ingest/splitter.js';
import { createLogger } from '../../src/shared/logger.js';
import { startTestApp, type TestApp } from '../helpers/app.js';

const ROWS = 5_000;
const CHUNK = 250;
const logger = createLogger({ level: 'silent', pretty: false });
const ctx: InvocationContext = { remainingTimeMs: () => 60_000 };

let app: TestApp;
let splitter: Splitter;
let processor: ChunkProcessor;
let prefix: string;
let csv: string;
let summary: GenerateSummary;

beforeAll(async () => {
  app = await startTestApp();
  const fx = app.ingest;
  splitter = new Splitter(
    { db: app.db, storage: fx.storage, splitQueue: fx.splitQueue, chunkQueue: fx.chunkQueue, logger, invalidation: fx.invalidation },
    { chunkSize: CHUNK, reserveMs: 1_000, maxAttempts: env.INGEST_MAX_ATTEMPTS },
  );
  processor = new ChunkProcessor(
    { db: app.db, storage: fx.storage, logger, invalidation: fx.invalidation },
    { maxAttempts: env.INGEST_MAX_ATTEMPTS, staleAfterMs: env.INGEST_INVOCATION_TIMEOUT_MS },
  );

  prefix = `E2E${randomUUID().slice(0, 6)}`;
  const sink = new PassThrough();
  const collected = text(sink);
  summary = await generateCsv(sink, { rows: ROWS, seed: 7, skuPrefix: prefix, collectExpected: true });
  sink.end();
  csv = await collected;
});

afterAll(async () => {
  await app.close();
});

describe('(a) 5k-row generated file end to end', () => {
  it('ingests to COMPLETED with correct counts, errors recorded, and newest-wins catalog', async () => {
    expect(summary.malformed).toBeGreaterThan(10);
    expect(summary.duplicates).toBeGreaterThan(50);

    const created = await app.upload<{ id: string }>('/ingest/jobs', {
      fields: { vendor_id: `vendor-${prefix}` },
      file: { name: 'vendor.csv', content: csv },
    });
    expect(created.status).toBe(202);
    const id = created.body.id;

    await app.ingest.splitQueue.drain((d) => splitter.handle(d.payload, ctx));
    await app.ingest.chunkQueue.drain((d) => processor.handle(d.payload, ctx));

    const { body: status } = await app.get<JobStatusView>(`/ingest/jobs/${id}`);
    const expectedChunks = Math.ceil(ROWS / CHUNK);
    expect(status).toMatchObject({
      status: 'COMPLETED',
      split_invocations: 1,
      next_chunk_index: expectedChunks,
      chunks: { total: expectedChunks, DONE: expectedChunks, PENDING: 0, PROCESSING: 0, FAILED: 0 },
      rows: { total: ROWS, valid: ROWS - summary.malformed, invalid: summary.malformed },
      error_count: summary.malformed,
    });
    // Applied ≤ valid (in-chunk duplicates collapse; cross-chunk older rows are outranked) and ≥ distinct products.
    expect(status.rows.applied).toBeLessThanOrEqual(status.rows.valid);
    expect(status.rows.applied).toBeGreaterThanOrEqual(summary.expected!.size);

    // Every SKU with at least one valid row exists exactly once; no other SKU with this prefix does.
    const products = await app.db
      .selectFrom('products')
      .innerJoin('categories', 'categories.id', 'products.category_id')
      .select(['sku', 'products.name', 'base_price', 'stock_quantity', 'categories.name as category'])
      .where('sku', 'like', `${prefix}-%`)
      .execute();
    expect(products).toHaveLength(summary.expected!.size);

    // The final row of each SKU (by file order) is what is stored, priced by the rules.
    let checked = 0;
    for (const p of products) {
      const want = summary.expected!.get(p.sku)!;
      const priced = priceRow({ cost: want.cost, category: want.category });
      expect(priced.ok).toBe(true);
      expect(p).toMatchObject({
        name: want.name,
        category: want.category,
        stock_quantity: want.stock_quantity,
        base_price: (priced as { base_price: string }).base_price,
      });
      checked++;
    }
    expect(checked).toBe(summary.expected!.size);

    // Row errors are exactly the malformed rows, each with a path.
    const errors = await app.db.selectFrom('ingest_row_errors').select(['row_no', 'errors']).where('job_id', '=', id).execute();
    expect(errors).toHaveLength(summary.malformed);
    expect(errors.every((e) => e.errors.length > 0 && e.errors.every((i) => i.path.length > 0))).toBe(true);
  });
});
