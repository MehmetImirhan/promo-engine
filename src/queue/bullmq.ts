import { Queue as BullQueue, Worker as BullWorker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import type { Logger } from '../shared/logger.js';
import type { ConsumeOptions, Consumer, EnqueueOptions, Queue, QueueWorker } from './queue.js';

export interface BullmqQueueOptions<T> {
  connection: Redis;
  logger: Logger;
  /** Deliveries before the message is parked in `deadLetter` (SQS maxReceiveCount). */
  maxAttempts: number;
  /** Base of the exponential backoff between attempts. */
  backoffMs: number;
  /**
   * How long a running delivery stays invisible to other consumers before
   * it is considered stalled and redelivered (SQS visibility timeout). Set
   * to the invocation timeout so a dead worker's chunk is redelivered only
   * after the processor's stale-PROCESSING reclaim window has passed.
   */
  lockDurationMs: number;
  deadLetter?: Queue<T>;
  /** Redis key prefix; tests use their own so they never touch the dev queues. */
  prefix?: string;
}

/**
 * BullMQ requires `maxRetriesPerRequest: null` on its connections; the
 * cache client (src/cache/redis.ts) deliberately does not have that, so the
 * worker gets its own connection.
 */
export function createQueueConnection(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: false });
}

export class BullmqQueue<T> implements Queue<T> {
  private readonly queue: BullQueue<unknown, void, string>;

  constructor(
    readonly name: string,
    private readonly opts: BullmqQueueOptions<T>,
  ) {
    this.queue = new BullQueue<unknown, void, string>(name, {
      connection: opts.connection,
      ...(opts.prefix ? { prefix: opts.prefix } : {}),
      defaultJobOptions: {
        attempts: opts.maxAttempts,
        backoff: { type: 'exponential', delay: opts.backoffMs },
        removeOnComplete: 1000,
        removeOnFail: 1000,
      },
    });
  }

  async enqueue(payload: T, options: EnqueueOptions = {}): Promise<void> {
    await this.queue.add(this.name, payload, {
      ...(options.id !== undefined ? { jobId: options.id } : {}),
      ...(options.delayMs !== undefined ? { delay: options.delayMs } : {}),
    });
  }

  async remove(id: string): Promise<void> {
    const job = await this.queue.getJob(id);
    if (!job) return;
    // A job that is active or locked cannot be removed; that is fine, it is being handled.
    await job.remove().catch(() => undefined);
  }

  consume(consumer: Consumer<T>, options: ConsumeOptions): QueueWorker {
    const { logger, deadLetter, prefix, lockDurationMs } = this.opts;
    const worker = new BullWorker<T, void, string>(
      this.name,
      (job: Job<T, void, string>) =>
        consumer({
          id: String(job.id),
          payload: job.data,
          attempt: job.attemptsMade + 1,
          maxAttempts: job.opts.attempts ?? 1,
        }),
      {
        connection: this.opts.connection,
        ...(prefix ? { prefix } : {}),
        concurrency: options.concurrency,
        lockDuration: lockDurationMs,
      },
    );

    worker.on('failed', (job, err) => {
      if (!job) return;
      const exhausted = job.attemptsMade >= (job.opts.attempts ?? 1);
      logger.warn({ queue: this.name, id: job.id, attempt: job.attemptsMade, exhausted, err: err.message }, 'delivery failed');
      if (exhausted && deadLetter) {
        // SQS redrive: after maxReceiveCount the message moves to the DLQ.
        void deadLetter.enqueue(job.data, { id: String(job.id) }).catch((e: Error) => {
          logger.error({ queue: this.name, id: job.id, err: e.message }, 'dead-letter enqueue failed');
        });
      }
    });
    worker.on('error', (err) => logger.error({ queue: this.name, err: err.message }, 'worker error'));

    return { close: () => worker.close() };
  }

  /** Test/ops helper: how many messages are parked (waiting or delayed). */
  async waitingCount(): Promise<number> {
    return this.queue.getWaitingCount();
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}
