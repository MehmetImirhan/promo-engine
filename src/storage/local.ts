import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, mkdir, open, rename, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { assertValidKey, type Storage } from './storage.js';

/**
 * Filesystem Storage rooted at one directory (STORAGE_DIR, default ./data).
 *
 * `put` writes to a temp file next to the target and renames it into place,
 * so a crash mid-write never leaves a half object where a complete one is
 * expected — the same all-or-nothing visibility S3 gives a PutObject.
 */
export class LocalStorage implements Storage {
  constructor(private readonly root: string) {}

  private pathFor(key: string): string {
    assertValidKey(key);
    return path.join(this.root, ...key.split('/'));
  }

  async put(key: string, body: Readable): Promise<void> {
    const target = this.pathFor(key);
    await mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.${randomUUID()}.tmp`;
    try {
      await pipeline(body, createWriteStream(tmp, { flags: 'wx' }));
      await rename(tmp, target);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  async getStream(key: string): Promise<Readable> {
    // Open eagerly so a missing key rejects here, not as a late 'error' event.
    const handle = await open(this.pathFor(key), 'r');
    return handle.createReadStream();
  }

  async exists(key: string): Promise<boolean> {
    const target = this.pathFor(key);
    try {
      await access(target);
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    const target = this.pathFor(key);
    try {
      await unlink(target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}
