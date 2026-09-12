/** POST /products validation and integrity mapping. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProductView } from '../../src/products/service.js';
import { startTestApp, type TestApp } from '../helpers/app.js';

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

let app: TestApp;
let categoryId: string;

beforeAll(async () => {
  app = await startTestApp();
  const { rows } = await app.pool.query<{ id: string }>('INSERT INTO categories (name) VALUES ($1) RETURNING id', [
    `create-${randomUUID()}`,
  ]);
  categoryId = rows[0]!.id;
});

afterAll(async () => {
  await app.close();
});

describe('POST /products', () => {
  const sku = `CREATE-${randomUUID()}`;

  it('creates with 201, defaults stock_quantity to 0, returns the priced view', async () => {
    const res = await app.post<ProductView>('/products', {
      sku,
      name: 'Created',
      category_id: categoryId,
      base_price: '19.9',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      sku,
      base_price: '19.90',
      effective_price: '19.90',
      stock_quantity: 0,
      promotion: null,
    });
  });

  it('409s on a duplicate SKU', async () => {
    const res = await app.post<ErrorBody>('/products', {
      sku,
      name: 'Again',
      category_id: categoryId,
      base_price: '1.00',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.details).toEqual([expect.objectContaining({ path: 'sku' })]);
  });

  it.each([
    ['unknown category_id', { category_id: randomUUID() }, 'category_id'],
    ['base_price as a JSON number', { base_price: 9.99 }, 'base_price'],
    ['base_price with 3 decimals', { base_price: '9.999' }, 'base_price'],
    ['negative stock_quantity', { stock_quantity: -1 }, 'stock_quantity'],
    ['fractional stock_quantity', { stock_quantity: 1.5 }, 'stock_quantity'],
  ])('rejects %s with 400', async (_label, override, path) => {
    const res = await app.post<ErrorBody>('/products', {
      sku: `CREATE-${randomUUID()}`,
      name: 'Bad',
      category_id: categoryId,
      base_price: '1.00',
      ...override,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual([expect.objectContaining({ path })]);
  });
});
