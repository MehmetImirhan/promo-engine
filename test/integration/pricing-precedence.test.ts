/**
 * Scenario B through the API: product scope beats category scope, a cancelled
 * promotion stops applying, a future one does not apply yet, an ended one is
 * ignored, and a product created into a category during a sale is discounted
 * on its first read.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Promotion } from '../../src/db/index.js';
import type { ProductPage, ProductView } from '../../src/products/service.js';
import { startTestApp, type TestApp } from '../helpers/app.js';

const HOUR = 3_600_000;
const at = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();

let app: TestApp;
let categoryId: string;
let p1: string; // 100.00
let p2: string; // 50.00
let categoryPromo: Promotion;
let productPromo: Promotion;

async function createProduct(basePrice: string): Promise<ProductView> {
  const res = await app.post<ProductView>('/products', {
    sku: `PREC-${randomUUID()}`,
    name: 'Precedence',
    category_id: categoryId,
    base_price: basePrice,
  });
  expect(res.status).toBe(201);
  return res.body;
}

async function promo(body: Record<string, unknown>): Promise<Promotion> {
  const res = await app.post<Promotion>('/promotions', { name: 'precedence', ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

async function detail(id: string): Promise<ProductView> {
  const res = await app.get<ProductView>(`/products/${id}`);
  expect(res.status).toBe(200);
  return res.body;
}

beforeAll(async () => {
  app = await startTestApp();
  const { rows } = await app.pool.query<{ id: string }>('INSERT INTO categories (name) VALUES ($1) RETURNING id', [
    `precedence-${randomUUID()}`,
  ]);
  categoryId = rows[0]!.id;
  p1 = (await createProduct('100.00')).id;
  p2 = (await createProduct('50.00')).id;
});

afterAll(async () => {
  await app.close();
});

describe('effective price precedence and lifecycle', () => {
  it('no promotion: effective_price equals base_price and promotion is null', async () => {
    const d = await detail(p1);
    expect(d.effective_price).toBe('100.00');
    expect(d.promotion).toBeNull();
  });

  it('category promotion applies to every product in the category', async () => {
    categoryPromo = await promo({
      category_id: categoryId,
      discount_type: 'PERCENTAGE',
      value: '20',
      starts_at: at(-HOUR),
      ends_at: at(HOUR),
    });
    expect((await detail(p1)).effective_price).toBe('80.00');
    const d2 = await detail(p2);
    expect(d2.effective_price).toBe('40.00');
    expect(d2.promotion).toEqual({ id: categoryPromo.id, name: 'precedence', type: 'PERCENTAGE', value: '20.00' });
  });

  it('product scope beats category scope, even when it is the worse deal', async () => {
    productPromo = await promo({
      product_id: p1,
      discount_type: 'FIXED',
      value: '5.00',
      starts_at: at(-HOUR),
      ends_at: at(HOUR),
    });
    const d = await detail(p1);
    expect(d.effective_price).toBe('95.00');
    expect(d.promotion?.id).toBe(productPromo.id);
    // p2 is untouched by p1's promotion
    expect((await detail(p2)).effective_price).toBe('40.00');
  });

  it('a cancelled product promotion no longer applies; the category promotion takes over', async () => {
    const res = await app.post<Promotion>(`/promotions/${productPromo.id}/cancel`);
    expect(res.status).toBe(200);
    const d = await detail(p1);
    expect(d.effective_price).toBe('80.00');
    expect(d.promotion?.id).toBe(categoryPromo.id);
  });

  it('a scheduled (future) product promotion does not apply yet', async () => {
    await promo({
      product_id: p1,
      discount_type: 'PERCENTAGE',
      value: '90',
      starts_at: at(HOUR),
      ends_at: at(2 * HOUR),
    });
    const d = await detail(p1);
    expect(d.effective_price).toBe('80.00');
    expect(d.promotion?.id).toBe(categoryPromo.id);
  });

  it('an ended product promotion is ignored', async () => {
    await promo({
      product_id: p2,
      discount_type: 'PERCENTAGE',
      value: '90',
      starts_at: at(-3 * HOUR),
      ends_at: at(-2 * HOUR),
    });
    expect((await detail(p2)).effective_price).toBe('40.00');
  });

  it('a product created into the category during the sale is discounted on first read (auto-inherit)', async () => {
    const created = await createProduct('10.00');
    expect(created.effective_price).toBe('8.00');
    expect(created.promotion?.id).toBe(categoryPromo.id);
    expect((await detail(created.id)).effective_price).toBe('8.00');
  });

  it('listing sorts by the effective price, not base price', async () => {
    const res = await app.get<ProductPage>(`/products?category_id=${categoryId}&order=asc`);
    expect(res.body.items.map((i) => i.effective_price)).toEqual(['8.00', '40.00', '80.00']);
  });

  it('cancelling the category promotion restores base prices everywhere', async () => {
    await app.post(`/promotions/${categoryPromo.id}/cancel`);
    const d = await detail(p1);
    expect(d.effective_price).toBe('100.00');
    expect(d.promotion).toBeNull();
    expect((await detail(p2)).effective_price).toBe('50.00');
  });
});
