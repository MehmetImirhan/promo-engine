import { describe, expect, it } from 'vitest';
import { SingleFlight } from './single-flight.js';

/** A promise the test resolves by hand, so concurrency is deterministic. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('SingleFlight', () => {
  it('coalesces N concurrent calls for one key into one fn invocation', async () => {
    const sf = new SingleFlight();
    const gate = deferred<string>();
    let calls = 0;
    const fn = () => {
      calls++;
      return gate.promise;
    };

    const waiters = Array.from({ length: 25 }, () => sf.run('k', fn));
    expect(calls).toBe(1);
    expect(sf.size).toBe(1);

    gate.resolve('value');
    const results = await Promise.all(waiters);
    expect(results).toEqual(Array(25).fill('value'));
    expect(sf.size).toBe(0);
  });

  it('runs fn again once the previous flight has settled', async () => {
    const sf = new SingleFlight();
    let calls = 0;
    const fn = async () => ++calls;

    expect(await sf.run('k', fn)).toBe(1);
    expect(await sf.run('k', fn)).toBe(2);
  });

  it('keeps different keys apart', async () => {
    const sf = new SingleFlight();
    const gate = deferred<void>();
    let calls = 0;
    const fn = () => {
      calls++;
      return gate.promise;
    };
    const a = sf.run('a', fn);
    const b = sf.run('b', fn);
    expect(calls).toBe(2);
    gate.resolve();
    await Promise.all([a, b]);
  });

  it('propagates a rejection to every waiter and does not cache it', async () => {
    const sf = new SingleFlight();
    const gate = deferred<never>();
    let calls = 0;
    const fn = () => {
      calls++;
      return gate.promise;
    };
    const waiters = [sf.run('k', fn), sf.run('k', fn), sf.run('k', fn)];
    gate.reject(new Error('boom'));
    for (const w of waiters) await expect(w).rejects.toThrow('boom');
    expect(sf.size).toBe(0);

    await expect(sf.run('k', async () => 'ok')).resolves.toBe('ok');
    expect(calls).toBe(1);
  });

  it('turns a synchronous throw inside fn into a rejection', async () => {
    const sf = new SingleFlight();
    await expect(
      sf.run('k', () => {
        throw new Error('sync');
      }),
    ).rejects.toThrow('sync');
    expect(sf.size).toBe(0);
  });

  it('runs fn for every caller when disabled', async () => {
    const sf = new SingleFlight(false);
    const gate = deferred<string>();
    let calls = 0;
    const fn = () => {
      calls++;
      return gate.promise;
    };
    const waiters = Array.from({ length: 5 }, () => sf.run('k', fn));
    expect(calls).toBe(5);
    expect(sf.size).toBe(0);
    gate.resolve('v');
    await Promise.all(waiters);
  });
});
