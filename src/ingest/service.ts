/**
 * Ingest job lifecycle as seen from HTTP (ADR §7). The API never reads row
 * data: it streams the upload to Storage while hashing it, writes one job
 * row, enqueues one message, and answers. Everything else happens in the
 * splitter and processor.
 */
import { createHash, randomUUID } from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import { sql } from 'kysely';
import type { Db, IngestChunkStatus, IngestJob } from '../db/index.js';
import { messageIds, type IngestQueues } from '../queue/index.js';
import { NotFound, Unavailable } from '../shared/errors.js';
import type { Storage } from '../storage/index.js';
import { checkJobCompletion } from './completion.js';
import type { IngestInvalidation } from './invalidation.js';

export interface Upload {
  fileKey: string;
  checksum: string;
  bytes: number;
}

export interface CreateJobResult {
  job: IngestJob;
  /** false when UNIQUE (vendor_id, file_checksum) matched an existing job. */
  created: boolean;
}

export interface JobStatusView {
  id: string;
  vendor_id: string;
  job_seq: string;
  status: IngestJob['status'];
  file_checksum: string;
  next_chunk_index: number;
  split_invocations: number;
  error: string | null;
  chunks: Record<IngestChunkStatus | 'total', number>;
  rows: { total: number; valid: number; invalid: number; applied: number };
  error_count: number;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

export interface ReplayResult {
  job_id: string;
  replayed_chunks: number[];
  split_reenqueued: boolean;
}

export interface IngestServiceOptions {
  /** Same value the processor uses to reclaim PROCESSING chunks. */
  staleAfterMs: number;
  /** Same value the completion check uses to tell a terminal FAILED chunk from a retryable one. */
  maxAttempts: number;
}

export interface ChunkView {
  chunk_index: number;
  status: IngestChunkStatus;
  attempts: number;
  row_count: number;
  rows_valid: number;
  rows_invalid: number;
  rows_applied: number;
  error: string | null;
  updated_at: Date;
}

interface ChunkStatusCounts {
  status: IngestChunkStatus;
  chunks: string;
  rows: string | null;
  valid: string | null;
  invalid: string | null;
  applied: string | null;
}

/** Counts are bigint aggregates, strings from pg; they are row counts, never money. */
function toStatusView(job: IngestJob, byStatus: ChunkStatusCounts[], errorCount: number): JobStatusView {
  const chunks: JobStatusView['chunks'] = { total: 0, PENDING: 0, PROCESSING: 0, DONE: 0, FAILED: 0 };
  const rows = { total: 0, valid: 0, invalid: 0, applied: 0 };
  for (const r of byStatus) {
    const n = Number(r.chunks);
    chunks[r.status] += n;
    chunks.total += n;
    rows.total += Number(r.rows);
    rows.valid += Number(r.valid);
    rows.invalid += Number(r.invalid);
    rows.applied += Number(r.applied);
  }

  return {
    id: job.id,
    vendor_id: job.vendor_id,
    job_seq: job.job_seq,
    status: job.status,
    file_checksum: job.file_checksum,
    next_chunk_index: job.next_chunk_index,
    split_invocations: job.split_invocations,
    error: job.error,
    chunks,
    rows,
    error_count: errorCount,
    created_at: job.created_at,
    updated_at: job.updated_at,
    completed_at: job.completed_at,
  };
}

export class IngestService {
  constructor(
    private readonly db: Db,
    private readonly storage: Storage,
    private readonly queues: IngestQueues,
    private readonly invalidation: IngestInvalidation,
    private readonly options: IngestServiceOptions,
  ) {}

  /**
   * Stream the request file into Storage, computing its checksum on the way.
   * Memory is one transform buffer; the file is never assembled in process.
   * The key does not depend on the checksum (unknown until the end) or the
   * vendor (may arrive after the file part).
   */
  async storeUpload(file: Readable): Promise<Upload> {
    const fileKey = `uploads/${randomUUID()}.csv`;
    const hash = createHash('sha256');
    let bytes = 0;
    const tap = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        bytes += chunk.length;
        callback(null, chunk);
      },
    });
    file.on('error', (err) => tap.destroy(err));
    await this.storage.put(fileKey, file.pipe(tap));
    return { fileKey, checksum: hash.digest('hex'), bytes };
  }

  async discardUpload(upload: Upload): Promise<void> {
    await this.storage.delete(upload.fileKey);
  }

  /**
   * One INSERT guarded by UNIQUE (vendor_id, file_checksum). A re-upload of
   * the same file returns the existing job and drops the duplicate bytes.
   * The split message is enqueued only after the row exists, and the
   * response is sent only after the enqueue: nothing runs after the reply.
   *
   * A queue that cannot take the message is a 503, not a hang and not a
   * 500: the job row and file are already in place, so the same upload
   * again returns them with 200 and re-offers the split.
   */
  async createJob(vendorId: string, upload: Upload): Promise<CreateJobResult> {
    const inserted = await this.db
      .insertInto('ingest_jobs')
      .values({ vendor_id: vendorId, file_checksum: upload.checksum, file_key: upload.fileKey })
      .onConflict((oc) => oc.columns(['vendor_id', 'file_checksum']).doNothing())
      .returningAll()
      .executeTakeFirst();

    if (inserted) {
      await this.enqueueSplit(inserted.id, 0);
      return { job: inserted, created: true };
    }

    const existing = await this.db
      .selectFrom('ingest_jobs')
      .selectAll()
      .where('vendor_id', '=', vendorId)
      .where('file_checksum', '=', upload.checksum)
      .executeTakeFirstOrThrow();
    await this.discardUpload(upload);

    // A job whose split message was lost (enqueue failed after insert) gets it again; the id dedupes otherwise.
    if (existing.status === 'PENDING') {
      await this.enqueueSplit(existing.id, 0);
    }
    return { job: existing, created: false };
  }

  private async enqueueSplit(jobId: string, fromChunk: number): Promise<void> {
    try {
      await this.queues.split.enqueue({ jobId }, { id: messageIds.split(jobId, fromChunk) });
    } catch (err) {
      throw new Unavailable('Ingest queue is unavailable; the job is recorded and the same upload can be retried', {
        job_id: jobId,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async getStatus(jobId: string): Promise<JobStatusView> {
    const job = await this.findOrThrow(jobId);
    const [view] = await this.statusViews([job]);
    return view!;
  }

  /** Newest first; uuidv7 ids are creation order, so the primary key serves the sort. */
  async listJobs(limit: number): Promise<JobStatusView[]> {
    const jobs = await this.db.selectFrom('ingest_jobs').selectAll().orderBy('id', 'desc').limit(limit).execute();
    return this.statusViews(jobs);
  }

  /**
   * Every chunk of one job, in order. Unpaginated on purpose: the count is
   * file rows / INGEST_CHUNK_SIZE, so a 500k-row file is 500 small rows.
   */
  async listChunks(jobId: string): Promise<ChunkView[]> {
    await this.findOrThrow(jobId);
    return this.db
      .selectFrom('ingest_chunks')
      .select(['chunk_index', 'status', 'attempts', 'row_count', 'rows_valid', 'rows_invalid', 'rows_applied', 'error', 'updated_at'])
      .where('job_id', '=', jobId)
      .orderBy('chunk_index')
      .execute();
  }

  /** Two grouped queries for any number of jobs, never one pair per job. */
  private async statusViews(jobs: IngestJob[]): Promise<JobStatusView[]> {
    if (jobs.length === 0) return [];
    const ids = jobs.map((j) => j.id);

    const byStatus = await this.db
      .selectFrom('ingest_chunks')
      .select((eb) => [
        'job_id',
        'status',
        eb.fn.countAll<string>().as('chunks'),
        eb.fn.sum<string>('row_count').as('rows'),
        eb.fn.sum<string>('rows_valid').as('valid'),
        eb.fn.sum<string>('rows_invalid').as('invalid'),
        eb.fn.sum<string>('rows_applied').as('applied'),
      ])
      .where('job_id', 'in', ids)
      .groupBy(['job_id', 'status'])
      .execute();

    const errors = await this.db
      .selectFrom('ingest_row_errors')
      .select((eb) => ['job_id', eb.fn.countAll<string>().as('n')])
      .where('job_id', 'in', ids)
      .groupBy('job_id')
      .execute();
    const errorCounts = new Map(errors.map((e) => [e.job_id, Number(e.n)]));

    return jobs.map((job) =>
      toStatusView(job, byStatus.filter((r) => r.job_id === job.id), errorCounts.get(job.id) ?? 0),
    );
  }

  /**
   * Re-enqueue every chunk that is FAILED or has sat in PROCESSING longer
   * than the invocation timeout, and an unfinished split. The processor's
   * claim statement and source_seq make any replay safe in any order.
   *
   * Each message is removed before it is enqueued: a driver that keys
   * messages by id (BullMQ here, SQS FIFO in production) ignores an add
   * whose id still exists, and an exhausted delivery's record does still
   * exist, in the failed set. Without the remove, the replay reports the
   * chunk and nothing runs.
   *
   * Once queued, a FAILED chunk goes back to PENDING so the derived
   * completion check counts it as outstanding again (a FAILED chunk at max
   * attempts reads as terminal). A PARTIAL job goes back to SPLIT_DONE only
   * after every enqueue succeeded, so a throw mid-loop leaves it PARTIAL and
   * replayable rather than SPLIT_DONE with nothing queued. The completion
   * check then runs here too: a fast worker may finish a replayed chunk
   * before the flip, and its own check finds no SPLIT_DONE job to complete.
   */
  async replayFailed(jobId: string): Promise<ReplayResult> {
    const job = await this.findOrThrow(jobId);

    const stuck = await this.db
      .selectFrom('ingest_chunks')
      .select('chunk_index')
      .where('job_id', '=', jobId)
      .where((eb) =>
        eb.or([
          eb('status', '=', 'FAILED'),
          eb.and([
            eb('status', '=', 'PROCESSING'),
            eb('updated_at', '<', sql<Date>`now() - make_interval(secs => ${this.options.staleAfterMs / 1000})`),
          ]),
        ]),
      )
      .orderBy('chunk_index')
      .execute();

    for (const { chunk_index } of stuck) {
      const id = messageIds.chunk(jobId, chunk_index);
      await this.queues.deadLetter.remove(id);
      await this.queues.processChunk.remove(id);
      await this.queues.processChunk.enqueue({ jobId, chunkIndex: chunk_index }, { id });
      // After the enqueue, never before: a chunk reset without a message would not be found by the next replay.
      await this.db
        .updateTable('ingest_chunks')
        .set({ status: 'PENDING', updated_at: sql`now()` })
        .where('job_id', '=', jobId)
        .where('chunk_index', '=', chunk_index)
        .where('status', '=', 'FAILED')
        .execute();
    }

    const splitUnfinished = job.status === 'PENDING' || job.status === 'SPLITTING';
    if (splitUnfinished) {
      const id = messageIds.split(jobId, job.next_chunk_index);
      await this.queues.split.remove(id);
      await this.queues.split.enqueue({ jobId }, { id });
    }

    if (job.status === 'PARTIAL') {
      await this.db
        .updateTable('ingest_jobs')
        .set({ status: 'SPLIT_DONE', completed_at: null, updated_at: sql`now()` })
        .where('id', '=', jobId)
        .where('status', '=', 'PARTIAL')
        .execute();
      const final = await checkJobCompletion(this.db, jobId, this.options.maxAttempts);
      if (final !== null) await this.invalidation.afterJobFinished(jobId);
    }

    return { job_id: jobId, replayed_chunks: stuck.map((c) => c.chunk_index), split_reenqueued: splitUnfinished };
  }

  private async findOrThrow(jobId: string): Promise<IngestJob> {
    const job = await this.db.selectFrom('ingest_jobs').selectAll().where('id', '=', jobId).executeTakeFirst();
    if (!job) throw new NotFound(`Ingest job ${jobId} not found`);
    return job;
  }
}
