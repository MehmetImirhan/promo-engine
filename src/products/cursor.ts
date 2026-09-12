/**
 * Keyset cursor for GET /products (ADR §5).
 *
 * The cursor is an opaque base64url string encoding the sort key of the last
 * row on the page, `(effective_price, id)`, plus the listing it belongs to:
 * the sort `order` and the `category_id` filter (or null). Decoding checks
 * the listing fields against the current request and rejects a mismatch with
 * 400, so a cursor cannot be silently replayed into a different listing where
 * it would still be "valid" but mean something else.
 *
 * `effective_price` stays a string end to end. It is never parsed into a JS
 * number: it goes back into the query as a `numeric` parameter.
 */
import { z } from 'zod';
import { Validation } from '../shared/errors.js';

export type SortOrder = 'asc' | 'desc';

/** The listing a cursor belongs to. */
export interface CursorScope {
  order: SortOrder;
  categoryId: string | null;
}

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
  o: z.enum(['asc', 'desc']),
  c: z.uuid().nullable(),
});

export function encodeCursor(key: CursorKey, scope: CursorScope): string {
  const payload = JSON.stringify({ p: key.effectivePrice, i: key.id, o: scope.order, c: scope.categoryId });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

/**
 * Throws `Validation` for anything this module did not produce, and for a
 * well-formed cursor that was issued for a different order or category.
 */
export function decodeCursor(cursor: string, expected: CursorScope): CursorKey {
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

  const { p, i, o, c } = result.data;
  if (o !== expected.order || c !== expected.categoryId) {
    throw new Validation('Cursor does not belong to this listing', {
      cursor: { order: o, category_id: c },
      request: { order: expected.order, category_id: expected.categoryId },
    });
  }
  return { effectivePrice: p, id: i };
}
