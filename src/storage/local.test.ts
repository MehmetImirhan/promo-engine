import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalStorage } from './local.js';
import { StorageKeyError } from './storage.js';

let root: string;
let storage: LocalStorage;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'promo-storage-'));
  storage = new LocalStorage(root);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('LocalStorage', () => {
  it('round-trips a stream and reports existence', async () => {
    await expect(storage.exists('chunks/j1/0.jsonl')).resolves.toBe(false);
    await storage.put('chunks/j1/0.jsonl', Readable.from(['{"a":1}\n', '{"b":"çığ"}\n']));
    await expect(storage.exists('chunks/j1/0.jsonl')).resolves.toBe(true);
    await expect(text(await storage.getStream('chunks/j1/0.jsonl'))).resolves.toBe('{"a":1}\n{"b":"çığ"}\n');
  });

  it('leaves no object behind when the source stream fails', async () => {
    const failing = new Readable({
      read() {
        this.push('partial');
        this.destroy(new Error('upstream broke'));
      },
    });
    await expect(storage.put('uploads/v/broken.csv', failing)).rejects.toThrow('upstream broke');
    await expect(storage.exists('uploads/v/broken.csv')).resolves.toBe(false);
    await expect(readdir(path.join(root, 'uploads', 'v'))).resolves.toEqual([]);
  });

  it('rejects a missing key on getStream and tolerates delete of a missing key', async () => {
    await expect(storage.getStream('nope/missing.csv')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(storage.delete('nope/missing.csv')).resolves.toBeUndefined();
    await storage.put('uploads/v/x.csv', Readable.from(['x']));
    await storage.delete('uploads/v/x.csv');
    await expect(storage.exists('uploads/v/x.csv')).resolves.toBe(false);
  });

  it('refuses keys that could escape the root', async () => {
    for (const key of ['../etc/passwd', '/abs/path', 'a//b', 'a/./b', 'a/..', '', 'sp ace']) {
      await expect(storage.exists(key)).rejects.toBeInstanceOf(StorageKeyError);
    }
  });
});
