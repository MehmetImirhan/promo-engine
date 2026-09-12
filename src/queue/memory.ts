import type { ConsumeOptions, Consumer, Delivery, EnqueueOptions, Queue, QueueWorker } from './queue.js';

interface Pending<T> {
  id: string;
  payload: T;
  attempt: number;
}

export interface MemoryQueueOptions<T> {
  maxAttempts?: number;
  deadLetter?: Queue<T>;
}

/**
 * In-memory Queue for tests. Messages sit in an array until a test calls
 * `drain`, which runs one consumer over every message sequentially,
 * including messages enqueued while draining (splitter continuations,
 * chunks produced by the splitter). Failures retry up to maxAttempts, then
 * go to the dead-letter queue, mirroring the BullMQ driver.
 */
export class MemoryQueue<T> implements Queue<T> {
  private readonly pending: Pending<T>[] = [];
  private seq = 0;
  readonly enqueued: Array<{ id: string; payload: T }> = [];
  private readonly maxAttempts: number;
  private readonly deadLetter: Queue<T> | undefined;

  constructor(
    readonly name: string,
    opts: MemoryQueueOptions<T> = {},
  ) {
    this.maxAttempts = opts.maxAttempts ?? 1;
    this.deadLetter = opts.deadLetter;
  }

  async enqueue(payload: T, opts: EnqueueOptions = {}): Promise<void> {
    const id = opts.id ?? `msg:${++this.seq}`;
    this.enqueued.push({ id, payload });
    if (this.pending.some((m) => m.id === id)) return;
    this.pending.push({ id, payload, attempt: 0 });
  }

  async remove(id: string): Promise<void> {
    const i = this.pending.findIndex((m) => m.id === id);
    if (i >= 0) this.pending.splice(i, 1);
  }

  get size(): number {
    return this.pending.length;
  }

  /** Not used by tests directly; `drain` is the test-facing entry point. */
  consume(consumer: Consumer<T>, _opts: ConsumeOptions): QueueWorker {
    void this.drain(consumer);
    return { close: async () => undefined };
  }

  /** Deliver every pending message (and any enqueued meanwhile) to `consumer`. Returns deliveries made. */
  async drain(consumer: Consumer<T>): Promise<number> {
    let deliveries = 0;
    for (;;) {
      const next = this.pending.shift();
      if (!next) return deliveries;
      next.attempt += 1;
      deliveries += 1;
      const delivery: Delivery<T> = {
        id: next.id,
        payload: next.payload,
        attempt: next.attempt,
        maxAttempts: this.maxAttempts,
      };
      try {
        await consumer(delivery);
      } catch {
        if (next.attempt < this.maxAttempts) {
          this.pending.push(next);
        } else if (this.deadLetter) {
          await this.deadLetter.enqueue(next.payload, { id: next.id });
        }
      }
    }
  }
}
