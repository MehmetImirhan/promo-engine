import type { Readable } from 'node:stream';

/**
 * Object storage for vendor uploads and chunk files (ADR §7).
 *
 * The pipeline only ever streams: `put` consumes a Readable and `getStream`
 * returns one, so no caller can hold a whole file in memory by accident.
 * Keys are `/`-separated paths such as `uploads/{vendor}/{id}.csv` or
 * `chunks/{jobId}/{index}.jsonl`.
 *
 * Production mapping (S3, not implemented here — no AWS SDK in this repo):
 *   put       → PutObject / multipart Upload from the stream
 *   getStream → GetObject().Body
 *   exists    → HeadObject (404 → false)
 *   delete    → DeleteObject
 * An object is visible only once fully written in both implementations.
 */
export interface Storage {
  put(key: string, body: Readable): Promise<void>;
  /** Rejects if the key does not exist. */
  getStream(key: string): Promise<Readable>;
  exists(key: string): Promise<boolean>;
  /** Idempotent: deleting a missing key is not an error. */
  delete(key: string): Promise<void>;
}

export class StorageKeyError extends Error {
  constructor(key: string) {
    super(`Invalid storage key: ${JSON.stringify(key)}`);
    this.name = 'StorageKeyError';
  }
}

const KEY_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * A key is one or more safe segments joined by `/`. This is what keeps a
 * local key from escaping STORAGE_DIR; S3 has no such problem but the same
 * rule keeps keys portable.
 */
export function assertValidKey(key: string): void {
  const segments = key.split('/');
  const ok =
    segments.length > 0 &&
    segments.every((s) => KEY_SEGMENT.test(s) && s !== '.' && s !== '..');
  if (!ok) throw new StorageKeyError(key);
}
