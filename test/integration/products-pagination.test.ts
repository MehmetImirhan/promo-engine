/**
 * Cross-page sort correctness (ADR §5). Walks every page of a category with
 * the opaque cursor and asserts the concatenated order equals one unpaginated
 * ORDER BY effective_price, id — in both directions — with no gaps or
 * duplicates. Prices are chosen to collide so the `id` tiebreaker is exercised
 * on every page boundary, and promotions of both scopes are present so the
 * sort key really is the computed effective price, not base_price.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pricedProducts } from '../../src/products/effective-price.sql.js';
import type { ProductPage } from '../../src/products/service.js';
import { startTestApp, type TestApp } from '../helpers/app.js';

const PRODUCT_COUNT = 60;
const PAGE_SIZE = 7;
const DISTINCT_PRICES = 12; // 60 products over 12 prices → 5-way ties everywhere

let app: TestApp;
let categoryId: string;

interface ErrorBody {
  error: { code: string; message: string };
}

async function walk(order: 'asc' | 'desc'): Promise<{ ids: string[]; prices: string[]; pages: number }> {
  const ids: string[] = [];
  const prices: string[] = [];
  let cursor: string | null = null;
  let pages = 0;

  do {
    const qs = new URLSearchParams({ category_id: categoryId, order, limit: String(PAGE_SIZE) });
    if (cursor) qs.set('cursor', cursor);
    const res: { status: number; body: ProductPage } = await app.get<ProductPage>(`/products?${qs}`);
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeLessThanOrEqual(PAGE_SIZE);
    for (const item of res.body.items) {
      ids.push(item.id);
      prices.push(item.effective_price);
    }
    cursor = res.body.next_cursor;
    pages += 1;
  } while (cursor !== null);

  return { ids, prices, pages };
}

beforeAll(async () => {
  app = await startTestApp();
  const { pool } = app;

  const cat = await pool.query<{ id: string }>('INSERT INTO categories (name) VALUES ($1) RETURNING id', [
    `pagination-${randomUUID()}`,
  ]);
  categoryId = cat.rows[0]!.id;

  // Prices computed in SQL; nothing here does money arithmetic in JS.
  await pool.query(
    `INSERT INTO products (sku, name, category_id, base_price)
     SELECT 'PAG-' || $1::text || '-' || g, 'Paginated ' || g, $2, ((g % $3::int) + 1) * 2.50
     FROM generate_series(1, $4::int) g`,
    [randomUUID(), categoryId, DISTINCT_PRICES, PRODUCT_COUNT],
  );

  // Category-scope 10% off everything…
  await pool.query(
    `INSERT INTO promotions (name, category_id, discount_type, value, starts_at, ends_at)
     VALUES ('pagination cat promo', $1, 'PERCENTAGE', 10, now() - interval '1 hour', now() + interval '1 hour')`,
    [categoryId],
  );
  // …and product-scope FIXED 1.00 promos on every product priced 2.50, 15.00 or 30.00.
  // Product scope wins even where it is the worse deal (15.00 → 14.00 beats 13.50),
  // so these rows land in different positions than base_price order would give.
  await pool.query(
    `INSERT INTO promotions (name, product_id, discount_type, value, starts_at, ends_at)
     SELECT 'pagination prod promo ' || sku, id, 'FIXED', 1.00, now() - interval '1 hour', now() + interval '1 hour'
     FROM products WHERE category_id = $1 AND base_price IN (2.50, 15.00, 30.00)`,
    [categoryId],
  );
});

afterAll(async () => {
  await app.close();
});

describe('GET /products keyset pagination', () => {
  it('ascending: concatenated pages equal one unpaginated ORDER BY effective_price, id', async () => {
    const expected = await pricedProducts(app.db)
      .where('p.category_id', '=', categoryId)
      .orderBy('effective_price', 'asc')
      .orderBy('p.id', 'asc')
      .execute();
    expect(expected).toHaveLength(PRODUCT_COUNT);

    const { ids, prices, pages } = await walk('asc');

    expect(pages).toBe(Math.ceil(PRODUCT_COUNT / PAGE_SIZE));
    expect(ids).toEqual(expected.map((r) => r.id));
    expect(prices).toEqual(expected.map((r) => r.effective_price));
    expect(new Set(ids).size).toBe(PRODUCT_COUNT);
  });

  it('descending: concatenated pages equal the reverse order', async () => {
    const expected = await pricedProducts(app.db)
      .where('p.category_id', '=', categoryId)
      .orderBy('effective_price', 'desc')
      .orderBy('p.id', 'desc')
      .execute();

    const { ids, pages } = await walk('desc');

    expect(pages).toBe(Math.ceil(PRODUCT_COUNT / PAGE_SIZE));
    expect(ids).toEqual(expected.map((r) => r.id));
  });

  it('sorts by the computed effective price, not base_price', async () => {
    const res = await app.get<ProductPage>(`/products?category_id=${categoryId}&limit=${PAGE_SIZE}`);
    const first = res.body.items[0]!;
    // Cheapest base price is 2.50; the product-scope FIXED 1.00 promo makes it 1.50 (10% off would be 2.25).
    expect(first.effective_price).toBe('1.50');
    expect(first.base_price).toBe('2.50');
    expect(first.promotion?.type).toBe('FIXED');
  });

  it('last page has next_cursor null and the cursor is opaque', async () => {
    const res = await app.get<ProductPage>(`/products?category_id=${categoryId}&limit=${PRODUCT_COUNT}`);
    expect(res.body.items).toHaveLength(PRODUCT_COUNT);
    expect(res.body.next_cursor).toBeNull();

    const paged = await app.get<ProductPage>(`/products?category_id=${categoryId}&limit=1`);
    expect(paged.body.next_cursor).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('rejects a malformed cursor with 400', async () => {
    const res = await app.get<ErrorBody>(`/products?category_id=${categoryId}&cursor=not-a-cursor`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('caps the page size', async () => {
    const res = await app.get<ErrorBody>(`/products?limit=101`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /products/:id', () => {
  it('returns effective_price and the applied promotion', async () => {
    const list = await app.get<ProductPage>(`/products?category_id=${categoryId}&limit=1`);
    const id = list.body.items[0]!.id;

    const res = await app.get<ProductPage['items'][number]>(`/products/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(id);
    expect(res.body.effective_price).toBe('1.50');
    expect(res.body.promotion).toMatchObject({ type: 'FIXED', value: '1.00' });
  });

  it('404s for an unknown id and 400s for a non-uuid', async () => {
    expect((await app.get<ErrorBody>(`/products/${randomUUID()}`)).status).toBe(404);
    expect((await app.get<ErrorBody>('/products/nope')).status).toBe(400);
  });
});
