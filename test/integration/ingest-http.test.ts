/**
 * POST /ingest/jobs (multipart, streamed, checksum-deduplicated),
 * GET /ingest/jobs, /ingest/jobs/:id, /ingest/jobs/:id/chunks, POST /ingest/jobs/:id/replay-failed — through the
 * HTTP layer with in-memory queues, then the pipeline drained by hand.
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../../src/config/index.js';
import type { InvocationContext } from '../../src/ingest/context.js';
import { ChunkProcessor } from '../../src/ingest/processor.js';
import type { JobStatusView, ReplayResult } from '../../src/ingest/service.js';
import { Splitter } from '../../src/ingest/splitter.js';
import { createLogger } from '../../src/shared/logger.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { messyCsv } from '../helpers/ingest.js';

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}
interface CreatedBody {
  id: string;
  status: string;
  created: boolean;
}

const logger = createLogger({ level: 'silent', pretty: false });
const ctx: InvocationContext = { remainingTimeMs: () => 60_000 };
const HEADER = 'sku,name,category,cost,stock_quantity';

let app: TestApp;
let splitter: Splitter;
let processor: ChunkProcessor;

beforeAll(async () => {
  app = await startTestApp();
  const fx = app.ingest;
  splitter = new Splitter(
    { db: app.db, storage: fx.storage, splitQueue: fx.splitQueue, chunkQueue: fx.chunkQueue, logger, invalidation: fx.invalidation },
    { chunkSize: 4, reserveMs: 1_000, maxAttempts: env.INGEST_MAX_ATTEMPTS },
  );
  processor = new ChunkProcessor(
    { db: app.db, storage: fx.storage, logger, invalidation: fx.invalidation },
    { maxAttempts: env.INGEST_MAX_ATTEMPTS, staleAfterMs: env.INGEST_INVOCATION_TIMEOUT_MS },
  );
});

afterAll(async () => {
  await app.close();
});

/** Run the pipeline the way the worker would, on the in-memory queues. */
async function drainPipeline(): Promise<void> {
  await app.ingest.splitQueue.drain((d) => splitter.handle(d.payload, ctx));
  await app.ingest.chunkQueue.drain((d) => processor.handle(d.payload, ctx));
}

describe('POST /ingest/jobs', () => {
  const vendor = `vendor-${randomUUID().slice(0, 8)}`;
  const csv = messyCsv(10);
  let jobId: string;

  it('streams the upload to storage, creates the job, enqueues split, answers 202', async () => {
    const res = await app.upload<CreatedBody>('/ingest/jobs', { fields: { vendor_id: vendor }, file: { name: 'v.csv', content: csv } });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: 'PENDING', created: true });
    jobId = res.body.id;

    const job = await app.db.selectFrom('ingest_jobs').selectAll().where('id', '=', jobId).executeTakeFirstOrThrow();
    expect(job.vendor_id).toBe(vendor);
    expect(job.file_checksum).toBe(createHash('sha256').update(csv).digest('hex'));
    await expect(app.ingest.storage.exists(job.file_key)).resolves.toBe(true);
    expect(app.ingest.splitQueue.enqueued.at(-1)).toEqual({ id: `split:${jobId}:0`, payload: { jobId } });
  });

  it('returns the existing job with 200 for the same vendor and file, and drops the duplicate upload', async () => {
    const keysBefore = app.ingest.splitQueue.enqueued.length;
    const res = await app.upload<CreatedBody>('/ingest/jobs', { fields: { vendor_id: vendor }, file: { name: 'again.csv', content: csv } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: jobId, created: false });

    const jobs = await app.db.selectFrom('ingest_jobs').select('id').where('vendor_id', '=', vendor).execute();
    expect(jobs).toHaveLength(1);
    // Still PENDING (not yet split), so the split message is re-offered; the deterministic id collapses it.
    expect(app.ingest.splitQueue.enqueued.length).toBe(keysBefore + 1);
    expect(app.ingest.splitQueue.size).toBe(1);
  });

  it('is a new job for another vendor with the same file', async () => {
    const res = await app.upload<CreatedBody>('/ingest/jobs', { fields: { vendor_id: `${vendor}-b` }, file: { name: 'v.csv', content: csv } });
    expect(res.status).toBe(202);
    expect(res.body.id).not.toBe(jobId);
  });

  it('400 without a file part, and without vendor_id (upload discarded)', async () => {
    const noFile = await app.upload<ErrorBody>('/ingest/jobs', { fields: { vendor_id: vendor } });
    expect(noFile.status).toBe(400);
    expect(noFile.body.error.details).toEqual([{ path: 'file', message: 'Required' }]);

    const noVendor = await app.upload<ErrorBody>('/ingest/jobs', { file: { name: 'v.csv', content: 'x' } });
    expect(noVendor.status).toBe(400);
    expect(noVendor.body.error.code).toBe('VALIDATION_ERROR');
    expect(noVendor.body.error.details).toEqual([{ path: 'vendor_id', message: expect.any(String) }]);
  });

  it('400 for a non-multipart body', async () => {
    const res = await app.post<ErrorBody>('/ingest/jobs', { vendor_id: vendor });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/multipart/);
  });
});

describe('GET /ingest/jobs/:id', () => {
  it('reports status, chunk counts by status, row counts, and error count as the pipeline advances', async () => {
    const res = await app.upload<CreatedBody>('/ingest/jobs', {
      fields: { vendor_id: `vendor-${randomUUID().slice(0, 8)}` },
      file: { name: 'v.csv', content: messyCsv(10) }, // rows 11.. absent; row 7 quoted; no short rows below 11
    });
    const id = res.body.id;

    let status = await app.get<JobStatusView>(`/ingest/jobs/${id}`);
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ status: 'PENDING', chunks: { total: 0 }, rows: { total: 0 }, error_count: 0 });

    await app.ingest.splitQueue.drain((d) => splitter.handle(d.payload, ctx));
    status = await app.get<JobStatusView>(`/ingest/jobs/${id}`);
    expect(status.body).toMatchObject({
      status: 'SPLIT_DONE',
      next_chunk_index: 3,
      split_invocations: 1,
      chunks: { total: 3, PENDING: 3, PROCESSING: 0, DONE: 0, FAILED: 0 },
      rows: { total: 10, valid: 0, invalid: 0, applied: 0 },
    });

    await app.ingest.chunkQueue.drain((d) => processor.handle(d.payload, ctx));
    status = await app.get<JobStatusView>(`/ingest/jobs/${id}`);
    expect(status.body).toMatchObject({
      status: 'COMPLETED',
      chunks: { total: 3, DONE: 3 },
      rows: { total: 10, valid: 10, invalid: 0, applied: 10 },
      error_count: 0,
    });
    expect(status.body.completed_at).not.toBeNull();
  });

  it('404 for an unknown id, 400 for a non-uuid', async () => {
    expect((await app.get(`/ingest/jobs/${randomUUID()}`)).status).toBe(404);
    expect((await app.get('/ingest/jobs/not-a-uuid')).status).toBe(400);
  });
});

describe('POST /ingest/jobs/:id/replay-failed', () => {
  it('re-enqueues FAILED and stale PROCESSING chunks, removes their DLQ entries, and lets the job complete', async () => {
    const res = await app.upload<CreatedBody>('/ingest/jobs', {
      fields: { vendor_id: `vendor-${randomUUID().slice(0, 8)}` },
      file: { name: 'v.csv', content: [HEADER, 'A-1,A,Shoes,10.00,1', 'A-2,A,Shoes,10.00,1', 'A-3,A,Shoes,10.00,1', 'A-4,A,Shoes,10.00,1', 'A-5,A,Shoes,10.00,1', 'A-6,A,Shoes,10.00,1', 'A-7,A,Shoes,10.00,1', 'A-8,A,Shoes,10.00,1', 'A-9,A,Shoes,10.00,1'].join('\n') + '\n' },
    });
    const id = res.body.id;
    await app.ingest.splitQueue.drain((d) => splitter.handle(d.payload, ctx));

    // Chunk 1: exhausted failure parked in the DLQ. Chunk 2: orphaned PROCESSING. Chunk 0: fine.
    await app.ingest.chunkQueue.drain(async (d) => {
      if (d.payload.chunkIndex === 1) throw new Error('poison');
      if (d.payload.chunkIndex === 2) return; // "worker died" — never claimed nor finished
      await processor.handle(d.payload, ctx);
    });
    await app.db
      .updateTable('ingest_chunks')
      .set({ status: 'FAILED', attempts: env.INGEST_MAX_ATTEMPTS, error: 'poison' })
      .where('job_id', '=', id)
      .where('chunk_index', '=', 1)
      .execute();
    await app.db
      .updateTable('ingest_chunks')
      .set({ status: 'PROCESSING', attempts: 1, updated_at: new Date(Date.now() - env.INGEST_INVOCATION_TIMEOUT_MS * 2) })
      .where('job_id', '=', id)
      .where('chunk_index', '=', 2)
      .execute();
    await app.db.updateTable('ingest_jobs').set({ status: 'PARTIAL', completed_at: new Date() }).where('id', '=', id).execute();
    expect(app.ingest.dlq.size).toBe(1);

    const replay = await app.post<ReplayResult>(`/ingest/jobs/${id}/replay-failed`);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ job_id: id, replayed_chunks: [1, 2], split_reenqueued: false });
    expect(app.ingest.dlq.size).toBe(0);
    expect(app.ingest.chunkQueue.size).toBe(2);
    expect((await app.get<JobStatusView>(`/ingest/jobs/${id}`)).body.status).toBe('SPLIT_DONE');

    await app.ingest.chunkQueue.drain((d) => processor.handle(d.payload, ctx));
    const status = await app.get<JobStatusView>(`/ingest/jobs/${id}`);
    expect(status.body).toMatchObject({ status: 'COMPLETED', chunks: { DONE: 3, FAILED: 0, PROCESSING: 0 }, rows: { applied: 9 } });
  });

  it('re-enqueues the split for a job whose splitter never finished', async () => {
    const res = await app.upload<CreatedBody>('/ingest/jobs', {
      fields: { vendor_id: `vendor-${randomUUID().slice(0, 8)}` },
      file: { name: 'v.csv', content: messyCsv(3) },
    });
    const id = res.body.id;
    await app.ingest.splitQueue.remove(`split:${id}:0`); // the message was lost
    await app.db.updateTable('ingest_jobs').set({ status: 'SPLITTING', next_chunk_index: 0 }).where('id', '=', id).execute();

    const replay = await app.post<ReplayResult>(`/ingest/jobs/${id}/replay-failed`);
    expect(replay.body).toEqual({ job_id: id, replayed_chunks: [], split_reenqueued: true });
    await drainPipeline();
    expect((await app.get<JobStatusView>(`/ingest/jobs/${id}`)).body.status).toBe('COMPLETED');
  });

  it('404 for an unknown job', async () => {
    expect((await app.post(`/ingest/jobs/${randomUUID()}/replay-failed`)).status).toBe(404);
  });
});

describe('GET /ingest/jobs and GET /ingest/jobs/:id/chunks', () => {
  let jobId: string;

  beforeAll(async () => {
    const res = await app.upload<CreatedBody>('/ingest/jobs', {
      fields: { vendor_id: `vendor-${randomUUID().slice(0, 8)}` },
      file: { name: 'v.csv', content: messyCsv(9) }, // 9 records at chunk size 4: chunks of 4, 4, 1
    });
    jobId = res.body.id;
    await drainPipeline();
  });

  it('lists jobs newest first, each in the same shape as GET /ingest/jobs/:id', async () => {
    const list = await app.get<{ items: JobStatusView[] }>('/ingest/jobs?limit=3');
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(3);
    expect(list.body.items[0]!.id).toBe(jobId);

    // Each item's counts come from grouped queries over all listed jobs; they must match the single-job read.
    for (const item of list.body.items) {
      expect(item).toEqual((await app.get<JobStatusView>(`/ingest/jobs/${item.id}`)).body);
    }
    expect((await app.get('/ingest/jobs?limit=51')).status).toBe(400);
  });

  it('lists every chunk of a job in order, with its row counts', async () => {
    const [chunks, status] = await Promise.all([
      app.get<{ items: Array<{ chunk_index: number; status: string; attempts: number; row_count: number; rows_valid: number; rows_invalid: number }> }>(
        `/ingest/jobs/${jobId}/chunks`,
      ),
      app.get<JobStatusView>(`/ingest/jobs/${jobId}`),
    ]);
    expect(chunks.status).toBe(200);
    expect(chunks.body.items.map((c) => [c.chunk_index, c.status, c.row_count])).toEqual([
      [0, 'DONE', 4],
      [1, 'DONE', 4],
      [2, 'DONE', 1],
    ]);
    expect(chunks.body.items.every((c) => c.attempts === 1 && c.rows_valid + c.rows_invalid === c.row_count)).toBe(true);
    expect(chunks.body.items.reduce((n, c) => n + c.rows_invalid, 0)).toBe(status.body.rows.invalid);
  });

  it('404 for an unknown job, 400 for a malformed id', async () => {
    expect((await app.get<ErrorBody>(`/ingest/jobs/${randomUUID()}/chunks`)).status).toBe(404);
    expect((await app.get<ErrorBody>('/ingest/jobs/nope/chunks')).status).toBe(400);
  });
});
