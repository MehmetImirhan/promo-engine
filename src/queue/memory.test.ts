import { describe, expect, it } from 'vitest';
import { MemoryQueue } from './memory.js';

describe('MemoryQueue', () => {
  it('collapses duplicate ids while queued and delivers messages enqueued during the drain', async () => {
    const q = new MemoryQueue<{ n: number }>('q');
    await q.enqueue({ n: 1 }, { id: 'a' });
    await q.enqueue({ n: 1 }, { id: 'a' });
    await q.enqueue({ n: 2 }, { id: 'b' });
    expect(q.size).toBe(2);

    const seen: number[] = [];
    const deliveries = await q.drain(async ({ payload }) => {
      seen.push(payload.n);
      if (payload.n === 2) await q.enqueue({ n: 3 }, { id: 'c' });
    });
    expect(seen).toEqual([1, 2, 3]);
    expect(deliveries).toBe(3);
    expect(q.size).toBe(0);
  });

  it('retries up to maxAttempts, then moves the message to the dead-letter queue', async () => {
    const dlq = new MemoryQueue<{ n: number }>('dlq');
    const q = new MemoryQueue<{ n: number }>('q', { maxAttempts: 3, deadLetter: dlq });
    await q.enqueue({ n: 1 }, { id: 'a' });

    const attempts: number[] = [];
    await q.drain(async ({ attempt, maxAttempts }) => {
      attempts.push(attempt);
      expect(maxAttempts).toBe(3);
      throw new Error('boom');
    });
    expect(attempts).toEqual([1, 2, 3]);
    expect(dlq.enqueued).toEqual([{ id: 'a', payload: { n: 1 } }]);
  });

  it('remove drops a queued message and ignores unknown ids', async () => {
    const q = new MemoryQueue<string>('q');
    await q.enqueue('x', { id: 'a' });
    await q.remove('a');
    await q.remove('zzz');
    expect(q.size).toBe(0);
  });
});
