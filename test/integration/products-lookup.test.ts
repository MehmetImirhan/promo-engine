/** GET /categories and GET /products/search: the lookups a person uses to pick a promotion target. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CategoryView, ProductSearchHit } from '../../src/products/service.js';
import { startTestApp, type TestApp } from '../helpers/app.js';

interface Items<T> {
  items: T[];
}

let app: TestApp;
let categoryId: string;
const categoryName = `lookup-${randomUUID()}`;
const tag = randomUUID().slice(0, 8);

beforeAll(async () => {
  app = await startTestApp();
  const { rows } = await app.pool.query<{ id: string }>('INSERT INTO categories (name) VALUES ($1) RETURNING id', [categoryName]);
  categoryId = rows[0]!.id;
  await app.pool.query(
    `INSERT INTO products (sku, name, category_id, base_price) VALUES
       ($1, 'Desk lamp', $3, '24.00'),
       ($2, $4, $3, '9.50')`,
    [`LOOKUP-X${tag}-1`, `LOOKUP-${randomUUID()}`, categoryId, `Lamp shade ${tag}`],
  );
});

afterAll(async () => {
  await app.close();
});

describe('GET /categories', () => {
  it('lists categories with id and name', async () => {
    const res = await app.get<Items<CategoryView>>('/categories');
    expect(res.status).toBe(200);
    expect(res.body.items).toContainEqual({ id: categoryId, name: categoryName });
  });
});

describe('GET /products/search', () => {
  it('matches SKU or name, case-insensitively, and returns the stored product', async () => {
    const res = await app.get<Items<ProductSearchHit>>(`/products/search?q=${tag.toUpperCase()}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items).toContainEqual(
      expect.objectContaining({ sku: `LOOKUP-X${tag}-1`, name: 'Desk lamp', category_id: categoryId, base_price: '24.00' }),
    );
    expect(res.body.items.map((p) => p.name)).toContain(`Lamp shade ${tag}`);
  });

  it('treats LIKE wildcards literally', async () => {
    // Unescaped, "_" would match the "X" before the tag in the first SKU.
    const res = await app.get<Items<ProductSearchHit>>(`/products/search?q=_${tag}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  it('honours limit, and rejects a one-character term or an oversized limit with 400', async () => {
    expect((await app.get<Items<ProductSearchHit>>(`/products/search?q=${tag}&limit=1`)).body.items).toHaveLength(1);
    expect((await app.get(`/products/search?q=a`)).status).toBe(400);
    expect((await app.get(`/products/search?q=${tag}&limit=21`)).status).toBe(400);
  });
});
