/**
 * Splitter (ADR §7): streams the uploaded CSV once, writes fixed-size
 * chunks to Storage, records a row per chunk, enqueues each chunk, and
 * checkpoints after every chunk so any invocation can stop and a later one
 * can continue.
 *
 * Bounded by construction:
 *   - memory: one chunk of records plus parser buffers, never the file;
 *   - time:   after each chunk it checks remainingTimeMs() and, when the
 *             reserve is reached, re-enqueues itself and returns. It always
 *             writes at least one chunk per invocation, so a continuation
 *             cannot spin without progress;
 *   - state:  everything it knows is in ingest_jobs.next_chunk_index and
 *             the chunk files. The message carries only the job id.
 *
 * Resume is record-skip: the parser's `from` option discards the first
 * next_chunk_index × chunkSize records. Chunk keys are deterministic and the
 * chunk row insert is ON CONFLICT DO NOTHING, so re-splitting a chunk after
 * a crash between "write" and "checkpoint" rewrites identical bytes and
 * enqueues a message the processor's claim statement ignores.
 */
import { Readable } from 'node:stream';
import { parse, CsvError } from 'csv-parse';
import { sql } from 'kysely';
import type { Db } from '../db/index.js';
import type { ProcessChunkMessage, Queue, SplitMessage } from '../queue/index.js';
import { messageIds } from '../queue/index.js';
import type { Logger } from '../shared/logger.js';
import type { Storage } from '../storage/index.js';
import { checkJobCompletion } from './completion.js';
import type { InvocationContext } from './context.js';
import { missingColumns } from './row-schema.js';

export interface SplitterDeps {
  db: Db;
  storage: Storage;
  splitQueue: Queue<SplitMessage>;
  chunkQueue: Queue<ProcessChunkMessage>;
  logger: Logger;
}

export interface SplitterOptions {
  chunkSize: number;
  /** Stop and re-enqueue when less than this remains. */
  reserveMs: number;
  /** Needed by the completion check it runs after SPLIT_DONE. */
  maxAttempts: number;
}

/** One line of a chunk file. */
export interface ChunkRow {
  row_no: number;
  raw: Record<string, string | undefined>;
}

export const chunkKey = (jobId: string, chunkIndex: number): string => `chunks/${jobId}/${chunkIndex}.jsonl`;

/** A file the splitter can never split: bad header or unparseable CSV. Fails the job, is not retried. */
export class UnsplittableFile extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsplittableFile';
  }
}

interface ClaimedJob {
  id: string;
  file_key: string;
  next_chunk_index: number;
}

export class Splitter {
  constructor(
    private readonly deps: SplitterDeps,
    private readonly options: SplitterOptions,
  ) {}

  async handle(event: SplitMessage, ctx: InvocationContext): Promise<void> {
    const { db, logger } = this.deps;
    const job = await this.claim(event.jobId);
    if (!job) {
      logger.info({ jobId: event.jobId }, 'split: job not splittable (already split, failed, or unknown); skipping');
      return;
    }

    const log = logger.child({ jobId: job.id, from: job.next_chunk_index });
    try {
      const outcome = await this.split(job, ctx, log);
      if (outcome === 'paused') return;
      await db
        .updateTable('ingest_jobs')
        .set({ status: 'SPLIT_DONE', updated_at: sql`now()` })
        .where('id', '=', job.id)
        .where('status', '=', 'SPLITTING')
        .execute();
      const final = await checkJobCompletion(db, job.id, this.options.maxAttempts);
      log.info({ final }, 'split: done');
    } catch (err) {
      if (err instanceof UnsplittableFile || err instanceof CsvError) {
        // Deterministic: retrying would fail identically. Fail the job and stop.
        await db
          .updateTable('ingest_jobs')
          .set({ status: 'FAILED', error: err.message, updated_at: sql`now()` })
          .where('id', '=', job.id)
          .execute();
        log.warn({ err: err.message }, 'split: file rejected');
        return;
      }
      // Transient (storage, database, queue): leave SPLITTING so the retry resumes from the checkpoint.
      throw err;
    }
  }

  /** Marks the job SPLITTING and counts the invocation. Returns null when the job is not in a splittable state. */
  private async claim(jobId: string): Promise<ClaimedJob | null> {
    const row = await this.deps.db
      .updateTable('ingest_jobs')
      .set({
        status: 'SPLITTING',
        split_invocations: sql`split_invocations + 1`,
        updated_at: sql`now()`,
      })
      .where('id', '=', jobId)
      .where('status', 'in', ['PENDING', 'SPLITTING'])
      .returning(['id', 'file_key', 'next_chunk_index'])
      .executeTakeFirst();
    return row ?? null;
  }

  private async split(job: ClaimedJob, ctx: InvocationContext, log: Logger): Promise<'done' | 'paused'> {
    const { storage } = this.deps;
    const { chunkSize, reserveMs } = this.options;

    const source = await storage.getStream(job.file_key);
    const parser = source.pipe(
      parse({
        bom: true,
        columns: (header: string[]) => {
          const missing = missingColumns(header);
          if (missing.length > 0) throw new UnsplittableFile(`CSV header is missing required columns: ${missing.join(', ')}`);
          return header.map((h) => h.trim());
        },
        // Short or long rows become records that fail validation in the
        // processor; they must not kill the stream or vanish silently.
        relax_column_count: true,
        skip_empty_lines: true,
        info: true,
        // Resume: discard records already split. info.records stays file-global.
        from: job.next_chunk_index * chunkSize + 1,
      }),
    );

    let chunkIndex = job.next_chunk_index;
    let buffer: ChunkRow[] = [];
    let writtenThisInvocation = 0;

    try {
      for await (const { record, info } of parser as AsyncIterable<{
        record: Record<string, string | undefined>;
        info: { records: number };
      }>) {
        buffer.push({ row_no: info.records, raw: record });
        if (buffer.length < chunkSize) continue;

        await this.writeChunk(job.id, chunkIndex, buffer);
        chunkIndex += 1;
        buffer = [];
        writtenThisInvocation += 1;

        if (ctx.remainingTimeMs() < reserveMs) {
          await this.deps.splitQueue.enqueue({ jobId: job.id }, { id: messageIds.split(job.id, chunkIndex) });
          log.info({ nextChunk: chunkIndex, written: writtenThisInvocation }, 'split: out of time, continuation enqueued');
          return 'paused';
        }
      }
    } finally {
      source.destroy();
    }

    if (buffer.length > 0) {
      await this.writeChunk(job.id, chunkIndex, buffer);
      chunkIndex += 1;
      writtenThisInvocation += 1;
    }
    log.info({ chunks: chunkIndex, written: writtenThisInvocation }, 'split: end of file');
    return 'done';
  }

  /** Write file → insert row → enqueue → checkpoint. Each step is idempotent on replay. */
  private async writeChunk(jobId: string, chunkIndex: number, rows: ChunkRow[]): Promise<void> {
    const { db, storage, chunkQueue } = this.deps;
    const body = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
    await storage.put(chunkKey(jobId, chunkIndex), Readable.from([body]));

    await db
      .insertInto('ingest_chunks')
      .values({ job_id: jobId, chunk_index: chunkIndex, row_count: rows.length })
      .onConflict((oc) => oc.columns(['job_id', 'chunk_index']).doNothing())
      .execute();

    await chunkQueue.enqueue({ jobId, chunkIndex }, { id: messageIds.chunk(jobId, chunkIndex) });

    // GREATEST: two overlapping splitter runs can never move the checkpoint backwards.
    await db
      .updateTable('ingest_jobs')
      .set({ next_chunk_index: sql`GREATEST(next_chunk_index, ${chunkIndex + 1})`, updated_at: sql`now()` })
      .where('id', '=', jobId)
      .execute();
  }
}
