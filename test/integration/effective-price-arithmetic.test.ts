/**
 * Arithmetic of the effective-price rule. The rule exists only as SQL
 * (src/products/effective-price.sql.ts) — there is deliberately no TypeScript
 * reimplementation to unit-test — so this evaluates the exported fragment
 * itself against Postgres with literal inputs. No tables are involved.
 */
import { sql } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import { env } from '../../src/config/index.js';
import { createDb, createPool } from '../../src/db/index.js';
import { discountedPrice } from '../../src/products/effective-price.sql.js';

const pool = createPool(env.TEST_DATABASE_URL);
const db = createDb(pool);

afterAll(() => pool.end());

async function evaluate(base: string, type: 'PERCENTAGE' | 'FIXED', value: string): Promise<string> {
  const row = await db
    .selectNoFrom(
      discountedPrice(sql`${base}::numeric`, sql`${type}::text`, sql`${value}::numeric`).as('price'),
    )
    .executeTakeFirstOrThrow();
  return row.price;
}

// [base_price, discount_type, value, expected]
const cases: Array<[string, 'PERCENTAGE' | 'FIXED', string, string, string]> = [
  ['19.99', 'PERCENTAGE', '10.00', '17.99', '17.991 rounds down'],
  ['10.00', 'PERCENTAGE', '33.33', '6.67', '6.667 rounds up'],
  ['0.05', 'PERCENTAGE', '50.00', '0.03', 'exact half (0.025) rounds half-up'],
  ['1.00', 'PERCENTAGE', '12.50', '0.88', 'exact half (0.875) rounds half-up'],
  ['100.00', 'PERCENTAGE', '100.00', '0.00', '100% off is 0.00, not 0'],
  ['100.00', 'PERCENTAGE', '0.01', '99.99', 'tiny percentage keeps 2dp'],
  ['10.00', 'FIXED', '3.50', '6.50', 'plain subtraction'],
  ['10.00', 'FIXED', '10.00', '0.00', 'value equal to base floors at 0.00'],
  ['10.00', 'FIXED', '25.00', '0.00', 'value above base floors at 0.00 (category-scope case)'],
  ['9999999999.99', 'FIXED', '0.01', '9999999999.98', 'top of numeric(12,2) range stays exact'],
];

describe('discountedPrice() SQL fragment', () => {
  for (const [base, type, value, expected, why] of cases) {
    it(`${type} ${value} on ${base} -> ${expected} (${why})`, async () => {
      expect(await evaluate(base, type, value)).toBe(expected);
    });
  }

  it('returns a string, never a JS number', async () => {
    expect(typeof (await evaluate('19.99', 'PERCENTAGE', '10.00'))).toBe('string');
  });
});
