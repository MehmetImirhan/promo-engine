import type { Redis } from 'ioredis';
import type { Logger } from '../shared/logger.js';
import { BullmqQueue } from './bullmq.js';
import { QUEUE_NAMES, type ProcessChunkMessage, type Queue, type SplitMessage } from './queue.js';

/** The three ingest queues, whichever driver backs them. */
export interface IngestQueues {
  split: Queue<SplitMessage>;
  processChunk: Queue<ProcessChunkMessage>;
  deadLetter: Queue<ProcessChunkMessage>;
}

export interface IngestQueueConfig {
  connection: Redis;
  logger: Logger;
  maxAttempts: number;
  invocationTimeoutMs: number;
}

/**
 * BullMQ-backed ingest queues, shared by the API (enqueue only) and the
 * worker (consume). The split queue retries with the same attempt budget as
 * chunks so a transient error mid-split resumes from the checkpoint.
 */
export function createIngestQueues(cfg: IngestQueueConfig): IngestQueues & { close(): Promise<void> } {
  const base = {
    connection: cfg.connection,
    logger: cfg.logger,
    backoffMs: 1_000,
    lockDurationMs: cfg.invocationTimeoutMs,
  };
  const deadLetter = new BullmqQueue<ProcessChunkMessage>(QUEUE_NAMES.deadLetter, { ...base, maxAttempts: 1 });
  const processChunk = new BullmqQueue<ProcessChunkMessage>(QUEUE_NAMES.processChunk, {
    ...base,
    maxAttempts: cfg.maxAttempts,
    deadLetter,
  });
  const split = new BullmqQueue<SplitMessage>(QUEUE_NAMES.split, { ...base, maxAttempts: cfg.maxAttempts });
  return {
    split,
    processChunk,
    deadLetter,
    close: async () => {
      await Promise.all([split.close(), processChunk.close(), deadLetter.close()]);
    },
  };
}
