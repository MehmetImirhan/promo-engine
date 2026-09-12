/**
 * Keyset cursor for GET /products (ADR §5).
 *
 * The cursor is an opaque base64url string encoding the sort key of the last
 * row on the page: `(effective_price, id)`. `id` is the tiebreaker that makes
 * the order total. Callers must resend the same `category_id` and `order`
 * they used to obtain the cursor; the cursor carries only the key.
 *
 * `effective_price` stays a string end to end. It is never parsed into a JS
 * number: it goes back into the query as a `numeric` parameter.
 */
import { z } from 'zod';
import { Validation } from '../shared/errors.js';

export interface CursorKey {
  /** effective_price as a 2dp decimal string, e.g. "17.99". */
  effectivePrice: string;
  /** Product id (uuid). */
  id: string;
}

const MONEY_2DP = /^\d{1,10}\.\d{2}$/;

const payloadSchema = z.strictObject({
  p: z.string().regex(MONEY_2DP),
  i: z.uuid(),
});

export function encodeCursor(key: CursorKey): string {
  const payload = JSON.stringify({ p: key.effectivePrice, i: key.id });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

/** Throws `Validation` for anything that is not a cursor this module produced. */
export function decodeCursor(cursor: string): CursorKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new Validation('Malformed cursor');
  }

  const result = payloadSchema.safeParse(parsed);
  if (!result.success) {
    throw new Validation('Malformed cursor');
  }
  return { effectivePrice: result.data.p, id: result.data.i };
}
