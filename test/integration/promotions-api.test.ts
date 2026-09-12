/**
 * POST /promotions, /promotions/:id/cancel, /promotions/:id/assign through
 * the HTTP layer: validation, the product-scope FIXED rule, the 409 body for
 * SQLSTATE 23P01, idempotent cancel, and re-targeting.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Promotion } from '../../src/db/index.js';
import type { ProductView } from '../../src/products/service.js';
import { startTestApp, type TestApp } from '../helpers/app.js';

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

const HOUR = 3_600_000;
const at = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();
const window = { starts_at: at(-HOUR), ends_at: at(HOUR) };

let app: TestApp;
let catA: string;
let catB: string;
let catC: string;
let catD: string;
let productA: string; // in catA, base 20.00
let productB: string; // in catB, base 5.00
let productC: string; // in catA, base 10.00

async function category(): Promise<string> {
  const { rows } = await app.pool.query<{ id: string }>('INSERT INTO categories (name) VALUES ($1) RETURNING id', [
    `promo-api-${randomUUID()}`,
  ]);
  return rows[0]!.id;
}

async function product(categoryId: string, basePrice: string): Promise<string> {
  const { rows } = await app.pool.query<{ id: string }>(
    `INSERT INTO products (sku, name, category_id, base_price) VALUES ($1, 'P', $2, $3) RETURNING id`,
    [`PROMO-${randomUUID()}`, categoryId, basePrice],
  );
  return rows[0]!.id;
}

beforeAll(async () => {
  app = await startTestApp();
  [catA, catB, catC, catD] = await Promise.all([category(), category(), category(), category()]);
  productA = await product(catA, '20.00');
  productB = await product(catB, '5.00');
  productC = await product(catA, '10.00');
});

afterAll(async () => {
  await app.close();
});

describe('POST /promotions', () => {
  let categoryPromoA: Promotion;

  it('creates a category-scope promotion with 201 and money as strings', async () => {
    const res = await app.post<Promotion>('/promotions', {
      name: 'Cat A 10%',
      category_id: catA,
      discount_type: 'PERCENTAGE',
      value: '10',
      ...window,
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ category_id: catA, product_id: null, status: 'ACTIVE', value: '10.00' });
    categoryPromoA = res.body;
  });

  it('rejects an overlapping same-scope promotion with a structured 409', async () => {
    const res = await app.post<ErrorBody>('/promotions', {
      name: 'Cat A again',
      category_id: catA,
      discount_type: 'FIXED',
      value: '1.00',
      starts_at: at(0),
      ends_at: at(2 * HOUR),
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    expect(res.body.error.details).toMatchObject({
      constraint: 'no_overlapping_category_promos',
      scope: 'category',
      category_id: catA,
    });
  });

  it('rejects a product-scope FIXED promotion whose value is not below base_price', async () => {
    const res = await app.post<ErrorBody>('/promotions', {
      name: 'Too big',
      product_id: productA,
      discount_type: 'FIXED',
      value: '20.00',
      ...window,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual([{ path: 'value', message: expect.stringContaining('20.00') }]);
  });

  it('accepts a product-scope FIXED promotion below base_price, then 409s an overlap on the product', async () => {
    const ok = await app.post<Promotion>('/promotions', {
      name: 'Product A 19.99 off',
      product_id: productA,
      discount_type: 'FIXED',
      value: '19.99',
      ...window,
    });
    expect(ok.status).toBe(201);

    const dup = await app.post<ErrorBody>('/promotions', {
      name: 'Product A again',
      product_id: productA,
      discount_type: 'PERCENTAGE',
      value: '5',
      ...window,
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error.details).toMatchObject({
      constraint: 'no_overlapping_product_promos',
      scope: 'product',
      product_id: productA,
    });
  });

  it('allows a category-scope FIXED promotion above every price; effective price floors at 0.00', async () => {
    const res = await app.post<Promotion>('/promotions', {
      name: 'Cat B 999 off',
      category_id: catB,
      discount_type: 'FIXED',
      value: '999.00',
      ...window,
    });
    expect(res.status).toBe(201);

    const detail = await app.get<ProductView>(`/products/${productB}`);
    expect(detail.body.effective_price).toBe('0.00');
    expect(detail.body.promotion?.id).toBe(res.body.id);
  });

  it.each([
    ['both scopes', { product_id: () => productA, category_id: () => catA }, 'product_id'],
    ['no scope', {}, 'product_id'],
    ['unknown product_id', { product_id: () => randomUUID() }, 'product_id'],
    ['unknown category_id', { category_id: () => randomUUID() }, 'category_id'],
  ])('rejects %s with 400', async (_label, scope, path) => {
    const body: Record<string, unknown> = {
      name: 'x',
      discount_type: 'PERCENTAGE',
      value: '10',
      ...window,
    };
    for (const [k, v] of Object.entries(scope)) body[k] = (v as () => string)();
    const res = await app.post<ErrorBody>('/promotions', body);
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual([expect.objectContaining({ path })]);
  });

  it.each([
    ['PERCENTAGE above 100', { discount_type: 'PERCENTAGE', value: '150' }, 'value'],
    ['value 0', { value: '0.00' }, 'value'],
    ['value as JSON number', { value: 10 }, 'value'],
    ['value with 3 decimals', { value: '1.005' }, 'value'],
    ['ends_at before starts_at', { starts_at: at(HOUR), ends_at: at(-HOUR) }, 'ends_at'],
    ['non-ISO date', { starts_at: 'tomorrow' }, 'starts_at'],
  ])('rejects %s with 400', async (_label, override, path) => {
    const res = await app.post<ErrorBody>('/promotions', {
      name: 'x',
      category_id: catC,
      discount_type: 'PERCENTAGE',
      value: '10',
      ...window,
      ...override,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details).toEqual([expect.objectContaining({ path })]);
  });

  describe('POST /promotions/:id/cancel', () => {
    it('flips status to CANCELLED and is idempotent', async () => {
      const first = await app.post<Promotion>(`/promotions/${categoryPromoA.id}/cancel`);
      expect(first.status).toBe(200);
      expect(first.body.status).toBe('CANCELLED');

      const second = await app.post<Promotion>(`/promotions/${categoryPromoA.id}/cancel`);
      expect(second.status).toBe(200);
      expect(second.body.status).toBe('CANCELLED');
      expect(second.body.updated_at).toBe(first.body.updated_at);

      const { rows } = await app.pool.query('SELECT 1 FROM promotions WHERE id = $1', [categoryPromoA.id]);
      expect(rows).toHaveLength(1); // never deleted
    });

    it('404s for an unknown promotion', async () => {
      const res = await app.post<ErrorBody>(`/promotions/${randomUUID()}/cancel`);
      expect(res.status).toBe(404);
    });

    it('frees the window: a new category promotion on catA is accepted', async () => {
      const res = await app.post<Promotion>('/promotions', {
        name: 'Cat A after cancel',
        category_id: catA,
        discount_type: 'PERCENTAGE',
        value: '25',
        ...window,
      });
      expect(res.status).toBe(201);
    });
  });
});

describe('POST /promotions/:id/assign', () => {
  let promo: Promotion;

  beforeAll(async () => {
    const res = await app.post<Promotion>('/promotions', {
      name: 'Movable FIXED 15',
      category_id: catC,
      discount_type: 'FIXED',
      value: '15.00',
      ...window,
    });
    expect(res.status).toBe(201);
    promo = res.body;
  });

  it('re-targets to another category', async () => {
    const res = await app.post<Promotion>(`/promotions/${promo.id}/assign`, { category_id: catD });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: promo.id, category_id: catD, product_id: null });
  });

  it('re-targets to a product (product scope replaces category scope)', async () => {
    const res = await app.post<Promotion>(`/promotions/${promo.id}/assign`, { product_id: productA });
    // productA already has an active product-scope promotion → the constraint says no.
    expect(res.status).toBe(409);
    expect((res.body as unknown as ErrorBody).error.details).toMatchObject({ scope: 'product', product_id: productA });
  });

  it('applies the FIXED-below-base-price rule to the new product target', async () => {
    const res = await app.post<ErrorBody>(`/promotions/${promo.id}/assign`, { product_id: productC }); // base 10.00 < 15.00
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual([expect.objectContaining({ path: 'value' })]);
  });

  it('rejects both or neither scope with 400, unknown id with 404', async () => {
    expect((await app.post<ErrorBody>(`/promotions/${promo.id}/assign`, { product_id: productC, category_id: catC })).status).toBe(400);
    expect((await app.post<ErrorBody>(`/promotions/${promo.id}/assign`, {})).status).toBe(400);
    expect((await app.post<ErrorBody>(`/promotions/${randomUUID()}/assign`, { category_id: catC })).status).toBe(404);
  });

  it('refuses to assign a cancelled promotion', async () => {
    await app.post(`/promotions/${promo.id}/cancel`);
    const res = await app.post<ErrorBody>(`/promotions/${promo.id}/assign`, { category_id: catC });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/cancelled/i);
  });
});
