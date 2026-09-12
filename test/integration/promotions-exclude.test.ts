/**
 * Proves the "at most one active promotion per product" invariant is enforced
 * by the database alone (ADR §3): no application code is involved here.
 * Runs against TEST_DATABASE_URL, which test/global-setup.ts has migrated
 * and truncated before this file starts.
 */
import { randomUUID } from 'node:crypto';
import { DatabaseError } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../../src/config/index.js';
import { createPool, type Pool } from '../../src/db/index.js';

const pool: Pool = createPool(env.TEST_DATABASE_URL);

let categoryId: string;
let productId: string;

async function insertProductPromo(startsAt: string, endsAt: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO promotions (name, product_id, discount_type, value, starts_at, ends_at)
     VALUES ($1, $2, 'PERCENTAGE', 10, $3, $4)
     RETURNING id`,
    [`promo ${randomUUID()}`, productId, startsAt, endsAt],
  );
  return rows[0]!.id;
}

async function captureError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return undefined;
  } catch (err) {
    return err;
  }
}

beforeAll(async () => {
  const cat = await pool.query<{ id: string }>(
    'INSERT INTO categories (name) VALUES ($1) RETURNING id',
    [`test-category-${randomUUID()}`],
  );
  categoryId = cat.rows[0]!.id;

  const prod = await pool.query<{ id: string }>(
    `INSERT INTO products (sku, name, category_id, base_price)
     VALUES ($1, 'Test product', $2, '100.00') RETURNING id`,
    [`TEST-${randomUUID()}`, categoryId],
  );
  productId = prod.rows[0]!.id;
});

afterAll(async () => {
  // No row cleanup: global-setup.ts truncates the test database before each run.
  await pool.end();
});

describe('no_overlapping_product_promos EXCLUDE constraint', () => {
  let firstPromoId: string;

  it('accepts the first active promotion for a product', async () => {
    firstPromoId = await insertProductPromo('2026-10-01T00:00:00Z', '2026-10-10T00:00:00Z');
    expect(firstPromoId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('rejects an overlapping active promotion with SQLSTATE 23P01', async () => {
    const err = await captureError(() =>
      insertProductPromo('2026-10-05T00:00:00Z', '2026-10-15T00:00:00Z'),
    );

    expect(err).toBeInstanceOf(DatabaseError);
    const dbErr = err as DatabaseError;
    expect(dbErr.code).toBe('23P01');
    expect(dbErr.constraint).toBe('no_overlapping_product_promos');
  });

  it('accepts a non-overlapping promotion (ranges are half-open, so touching is fine)', async () => {
    const id = await insertProductPromo('2026-10-10T00:00:00Z', '2026-10-20T00:00:00Z');
    expect(id).not.toBe(firstPromoId);
  });

  it('stops blocking once the conflicting promotion is CANCELLED (partial predicate)', async () => {
    await pool.query(`UPDATE promotions SET status = 'CANCELLED' WHERE id = $1`, [firstPromoId]);

    // Same window that was rejected above, now allowed because the blocker is cancelled.
    const id = await insertProductPromo('2026-10-05T00:00:00Z', '2026-10-09T00:00:00Z');
    expect(id).toBeTruthy();
  });
});
