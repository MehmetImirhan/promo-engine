/**
 * The BullMQ driver against the compose Redis: deterministic ids collapse,
 * retries carry the attempt number, and the final failure lands in the DLQ.
 * Uses its own key prefix so it never touches the dev worker's queues.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../../src/config/index.js';
import { BullmqQueue, createQueueConnection } from '../../src/queue/index.js';
import { createLogger } from '../../src/shared/logger.js';

const prefix = `test:${randomUUID().slice(0, 8)}`;
const logger = createLogger({ level: 'silent', pretty: false });
let connection: ReturnType<typeof createQueueConnection>;
let dlq: BullmqQueue<{ n: number }>;
let queue: BullmqQueue<{ n: number }>;

function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('timed out waiting'));
      setTimeout(tick, 25);
    };
    tick();
  });
}

beforeAll(async () => {
  connection = createQueueConnection(env.REDIS_URL);
  const base = { connection, logger, maxAttempts: 2, backoffMs: 10, lockDurationMs: 5_000, prefix };
  dlq = new BullmqQueue('dlq', { ...base, maxAttempts: 1 });
  queue = new BullmqQueue('q', { ...base, deadLetter: dlq });
});

afterAll(async () => {
  await queue.close();
  await dlq.close();
  const keys = await connection.keys(`${prefix}:*`);
  if (keys.length > 0) await connection.del(...keys);
  await connection.quit();
});

describe('BullmqQueue', () => {
  it('delivers with attempt numbers, retries a failure, then dead-letters it', async () => {
    const seen: Array<{ n: number; attempt: number }> = [];
    const worker = queue.consume(
      async ({ payload, attempt }) => {
        seen.push({ n: payload.n, attempt });
        if (payload.n === 2) throw new Error('poison');
      },
      { concurrency: 2 },
    );

    await queue.enqueue({ n: 1 }, { id: 'one' });
    await queue.enqueue({ n: 1 }, { id: 'one' }); // duplicate id while queued: collapses
    await queue.enqueue({ n: 2 }, { id: 'two' });

    await waitFor(() => seen.filter((s) => s.n === 2).length === 2);
    await waitFor(() => seen.filter((s) => s.n === 1).length === 1);
    expect(seen.filter((s) => s.n === 2).map((s) => s.attempt)).toEqual([1, 2]);

    // Final failure moved to the DLQ with the same id.
    await waitFor(() => false, 200).catch(() => undefined);
    expect(await dlq.waitingCount()).toBe(1);

    await worker.close();
  });
});
