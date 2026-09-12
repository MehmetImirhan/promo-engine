/**
 * Thin queue abstraction the ingest pipeline talks to (ADR §7).
 *
 * Kept deliberately small so the production mapping is honest:
 *   enqueue  → SQS SendMessage (deduplication id = `id`)
 *   consume  → Lambda event source mapping (concurrency = reserved concurrency)
 *   retries  → SQS visibility timeout + maxReceiveCount
 *   DLQ      → SQS redrive policy
 * Nothing above this interface knows which driver is in use; tests run the
 * whole pipeline on the in-memory driver.
 */

export interface EnqueueOptions {
  /**
   * Deterministic message id. A second enqueue with the same id while the
   * first is still queued is a no-op, which is what makes splitter retries
   * idempotent at the queue layer as well as at the database.
   */
  id?: string;
  delayMs?: number;
}

export interface Delivery<T> {
  id: string;
  payload: T;
  /** 1-based. */
  attempt: number;
  maxAttempts: number;
}

export type Consumer<T> = (delivery: Delivery<T>) => Promise<void>;

export interface ConsumeOptions {
  concurrency: number;
}

export interface QueueWorker {
  close(): Promise<void>;
}

export interface Queue<T> {
  readonly name: string;
  enqueue(payload: T, opts?: EnqueueOptions): Promise<void>;
  /** Remove a queued (not running) message by id. No-op when absent. */
  remove(id: string): Promise<void>;
  /**
   * Start delivering messages to `consumer`. A consumer that throws is
   * retried up to the queue's max attempts; the final failure is moved to
   * the queue's dead-letter queue if it has one.
   */
  consume(consumer: Consumer<T>, opts: ConsumeOptions): QueueWorker;
}

// --- ingest message shapes -------------------------------------------------

export interface SplitMessage {
  jobId: string;
}

export interface ProcessChunkMessage {
  jobId: string;
  chunkIndex: number;
}

export const QUEUE_NAMES = {
  split: 'ingest-split',
  processChunk: 'ingest-process-chunk',
  deadLetter: 'ingest-dlq',
} as const;

/** Message ids are deterministic so duplicates collapse in the queue. */
export const messageIds = {
  split: (jobId: string, fromChunk: number): string => `split:${jobId}:${fromChunk}`,
  chunk: (jobId: string, chunkIndex: number): string => `chunk:${jobId}:${chunkIndex}`,
};
