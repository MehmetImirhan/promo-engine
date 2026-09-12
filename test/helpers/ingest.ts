/**
 * Fixtures for driving the ingest pipeline directly (no HTTP): a temp
 * LocalStorage, in-memory queues, the completion → cache hook, and a job
 * row for a CSV string. Without a real CategoryVersions the hook bumps a
 * Map-backed counter, so pure ingest tests need no Redis.
 */
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { CategoryVersions } from '../../src/cache/index.js';
import type { Db } from '../../src/db/index.js';
import { IngestInvalidation } from '../../src/ingest/invalidation.js';
import type { ChunkRow } from '../../src/ingest/splitter.js';
import { createLogger } from '../../src/shared/logger.js';
import { chunkKey } from '../../src/ingest/splitter.js';
import { MemoryQueue, type ProcessChunkMessage, type SplitMessage } from '../../src/queue/index.js';
import { LocalStorage } from '../../src/storage/index.js';

export interface IngestFixture {
  storage: LocalStorage;
  splitQueue: MemoryQueue<SplitMessage>;
  chunkQueue: MemoryQueue<ProcessChunkMessage>;
  dlq: MemoryQueue<ProcessChunkMessage>;
  invalidation: IngestInvalidation;
  cleanup(): Promise<void>;
}

/** CategoryVersions over a Map, for tests that do not involve Redis. */
export function memoryVersions(): CategoryVersions {
  const store = new Map<string, string>();
  const fake = {
    get: async (key: string) => store.get(key) ?? null,
    incr: async (key: string) => {
      const n = Number(store.get(key) ?? '0') + 1;
      store.set(key, String(n));
      return n;
    },
  };
  return new CategoryVersions(fake, createLogger({ level: 'silent', pretty: false }));
}

export async function ingestFixture(db: Db, maxAttempts = 3, versions = memoryVersions()): Promise<IngestFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'promo-ingest-'));
  const dlq = new MemoryQueue<ProcessChunkMessage>('dlq');
  return {
    invalidation: new IngestInvalidation(db, versions),
    storage: new LocalStorage(root),
    splitQueue: new MemoryQueue<SplitMessage>('split'),
    chunkQueue: new MemoryQueue<ProcessChunkMessage>('process-chunk', { maxAttempts, deadLetter: dlq }),
    dlq,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

export interface JobRow {
  id: string;
  job_seq: string;
}

/** Stores `csv` and inserts a PENDING job for it, as POST /ingest/jobs would. */
export async function createJobForCsv(db: Db, storage: LocalStorage, csv: string, vendorId = 'vendor-test'): Promise<JobRow> {
  const fileKey = `uploads/${vendorId}/${randomUUID()}.csv`;
  await storage.put(fileKey, Readable.from([csv]));
  return db
    .insertInto('ingest_jobs')
    .values({
      vendor_id: vendorId,
      file_checksum: createHash('sha256').update(csv).update(randomUUID()).digest('hex'),
      file_key: fileKey,
    })
    .returning(['id', 'job_seq'])
    .executeTakeFirstOrThrow();
}

export async function readChunk(storage: LocalStorage, jobId: string, chunkIndex: number): Promise<ChunkRow[]> {
  const body = await text(await storage.getStream(chunkKey(jobId, chunkIndex)));
  return body
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as ChunkRow);
}

export async function readChunkRaw(storage: LocalStorage, jobId: string, chunkIndex: number): Promise<string> {
  return text(await storage.getStream(chunkKey(jobId, chunkIndex)));
}

/** A CSV with realistic mess: BOM, quoted comma/newline, UTF-8, a blank line, a short row. */
export function messyCsv(rows: number): string {
  const lines = ['﻿sku,name,category,cost,stock_quantity'];
  for (let i = 1; i <= rows; i++) {
    if (i % 7 === 0) lines.push(`SKU-${i},"Name ${i}, ""quoted""\nsecond line",Shoes,${i}.50,${i}`);
    else if (i % 11 === 0) lines.push(`SKU-${i},Short row`);
    else if (i % 13 === 0) lines.push(`SKU-${i},Çığ ünïcode ${i},Electronics,${i}.00,${i}`);
    else lines.push(`SKU-${i},Name ${i},Accessories,${i}.25,${i}`);
    if (i % 5 === 0) lines.push('');
  }
  return lines.join('\n') + '\n';
}
