/**
 * Cache behaviour end to end (ADR §6), against the compose Redis:
 *   (a) detail served from cache on the second read
 *   (b) a category promotion makes the old keys unreachable; next read is discounted
 *   (c) auto-inherit: a product added by POST /products or by ingest shows the discount on first read
 *   (d) cancel restores the base price on the next read
 *   (e) Redis unreachable → every endpoint still answers correctly
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../../src/config/index.js';
import type { InvocationContext } from '../../src/ingest/context.js';
import { priceRow } from '../../src/ingest/pricing-rules.js';
import { ChunkProcessor } from '../../src/ingest/processor.js';
import type { JobStatusView } from '../../src/ingest/service.js';
import { Splitter } from '../../src/ingest/splitter.js';
import type { ProductPage, ProductView } from '../../src/products/service.js';
import { createLogger } from '../../src/shared/logger.js';
import { startTestApp, type TestApp } from '../helpers/app.js';

let app: TestApp;
let categoryId: string;

async function category(): Promise<string> {
  const { rows } = await app.pool.query<{ id: string }>('INSERT INTO categories (name) VALUES ($1) RETURNING id', [
    `cache-${randomUUID()}`,
  ]);
  return rows[0]!.id;
}

async function product(catId: string, basePrice: string): Promise<string> {
  const { rows } = await app.pool.query<{ id: string }>(
    `INSERT INTO products (sku, name, category_id, base_price) VALUES ($1, 'P', $2, $3) RETURNING id`,
    [`CACHE-${randomUUID()}`, catId, basePrice],
  );
  return rows[0]!.id;
}

/** Redis keys under a prefix; only tests enumerate keys. */
async function keys(pattern: string): Promise<string[]> {
  return app.redis.keys(pattern);
}

beforeAll(async () => {
  app = await startTestApp();
  categoryId = await category();
});

afterAll(async () => {
  await app.close();
});

describe('(a) detail served from cache', () => {
  it('second read comes from Redis: a direct SQL price change (no bump) is not visible until the version moves', async () => {
    const id = await product(categoryId, '10.00');

    const first = await app.get<ProductView>(`/products/${id}`);
    expect(first.status).toBe(200);
    expect(first.body.effective_price).toBe('10.00');

    const written = await keys(`product:${id}:v*`);
    expect(written).toHaveLength(1);
    expect(await app.redis.ttl(written[0]!)).toBeGreaterThan(0);

    // Bypass every bump on purpose; the cache must answer, not Postgres.
    await app.pool.query(`UPDATE products SET base_price = '99.00' WHERE id = $1`, [id]);
    const second = await app.get<ProductView>(`/products/${id}`);
    expect(second.body).toEqual(first.body);

    await app.cache.versions.bump([categoryId]);
    const third = await app.get<ProductView>(`/products/${id}`);
    expect(third.body.effective_price).toBe('99.00');
    // The old key is orphaned, not deleted.
    expect(await keys(`product:${id}:v*`)).toHaveLength(2);
  });

  it('listing pages are cached per (category, order, limit, cursor) under the same version', async () => {
    const cat = await category();
    await product(cat, '1.00');
    await product(cat, '2.00');
    const page = await app.get<ProductPage>(`/products?category_id=${cat}&limit=1`);
    expect(page.status).toBe(200);
    const next = page.body.next_cursor!;
    await app.get<ProductPage>(`/products?category_id=${cat}&limit=1&cursor=${next}`);

    const listKeys = await keys(`products:list:${cat}:*`);
    expect(listKeys.sort()).toEqual(
      [`products:list:${cat}:asc:1:-:v${cat}.0`, `products:list:${cat}:asc:1:${next}:v${cat}.0`].sort(),
    );
  });

  it('a bad cursor is a 400 and never written to the cache', async () => {
    const res = await app.get(`/products?category_id=${categoryId}&cursor=nope`);
    expect(res.status).toBe(400);
    expect(await keys(`products:list:${categoryId}:*:nope:*`)).toEqual([]);
  });

  it('404 is not cached', async () => {
    const id = randomUUID();
    expect((await app.get(`/products/${id}`)).status).toBe(404);
    expect(await keys(`product:${id}*`)).toEqual([]);
  });
});

const HOUR = 3_600_000;
const window = () => ({
  starts_at: new Date(Date.now() - HOUR).toISOString(),
  ends_at: new Date(Date.now() + HOUR).toISOString(),
});

async function version(scope: string): Promise<string | null> {
  return app.redis.get(`catver:${scope}`);
}

describe('(b)(c)(d) promotion writes invalidate by version bump', () => {
  let cat: string;
  let p1: string;
  let promoId: string;

  beforeAll(async () => {
    cat = await category();
    p1 = await product(cat, '20.00');
  });

  it('(b) creating a category promotion is one bump; the next read returns the discounted price', async () => {
    expect((await app.get<ProductView>(`/products/${p1}`)).body.effective_price).toBe('20.00');
    const page = await app.get<ProductPage>(`/products?category_id=${cat}`);
    expect(page.body.items[0]!.effective_price).toBe('20.00');
    const before = await keys(`*${cat}*`);
    const allBefore = await version('_all');

    const res = await app.post<{ id: string }>('/promotions', {
      name: 'flash',
      category_id: cat,
      discount_type: 'PERCENTAGE',
      value: '25',
      ...window(),
    });
    expect(res.status).toBe(201);
    promoId = res.body.id;

    expect(await version(cat)).toBe('1');
    expect(Number(await version('_all'))).toBe(Number(allBefore ?? '0') + 1);

    expect((await app.get<ProductView>(`/products/${p1}`)).body.effective_price).toBe('15.00');
    expect((await app.get<ProductPage>(`/products?category_id=${cat}`)).body.items[0]!.effective_price).toBe('15.00');
    // Old keys still exist (nothing was deleted); new keys carry the new token.
    for (const k of before) expect(await app.redis.exists(k)).toBe(1);
    expect(await keys(`product:${p1}:v${cat}.1`)).toHaveLength(1);
    expect(await keys(`products:list:${cat}:*:v${cat}.1`)).toHaveLength(1);
  });

  it('(c) POST /products during the sale: first read is discounted, and the cached listing includes it', async () => {
    const created = await app.post<ProductView>('/products', {
      sku: `CACHE-${randomUUID()}`,
      name: 'New during sale',
      category_id: cat,
      base_price: '10.00',
    });
    expect(created.status).toBe(201);
    expect(created.body.effective_price).toBe('7.50');
    expect(created.body.promotion?.id).toBe(promoId);

    expect((await app.get<ProductView>(`/products/${created.body.id}`)).body.effective_price).toBe('7.50');
    const page = await app.get<ProductPage>(`/products?category_id=${cat}`);
    expect(page.body.items.map((p) => p.effective_price)).toEqual(['7.50', '15.00']);
  });

  it('(d) cancelling restores the base price on the next read; cancelling again bumps nothing', async () => {
    const cancel = await app.post(`/promotions/${promoId}/cancel`);
    expect(cancel.status).toBe(200);
    const v = await version(cat);
    expect((await app.get<ProductView>(`/products/${p1}`)).body.effective_price).toBe('20.00');
    expect((await app.get<ProductPage>(`/products?category_id=${cat}`)).body.items.map((p) => p.effective_price)).toEqual([
      '10.00',
      '20.00',
    ]);

    await app.post(`/promotions/${promoId}/cancel`);
    expect(await version(cat)).toBe(v);
  });

  it('product-scope promotions bump the product\'s category; assign bumps both the old and the new target', async () => {
    const other = await category();
    const p2 = await product(other, '8.00');
    const vCat = Number(await version(cat));
    const vOther = await version(other);

    const res = await app.post<{ id: string }>('/promotions', {
      name: 'single',
      product_id: p1,
      discount_type: 'FIXED',
      value: '5.00',
      ...window(),
    });
    expect(res.status).toBe(201);
    expect(Number(await version(cat))).toBe(vCat + 1);
    expect((await app.get<ProductView>(`/products/${p1}`)).body.effective_price).toBe('15.00');
    expect((await app.get<ProductView>(`/products/${p2}`)).body.effective_price).toBe('8.00');

    const assign = await app.post(`/promotions/${res.body.id}/assign`, { product_id: p2 });
    expect(assign.status).toBe(200);
    expect(Number(await version(cat))).toBe(vCat + 2);
    expect(Number(await version(other))).toBe(Number(vOther ?? '0') + 1);
    expect((await app.get<ProductView>(`/products/${p1}`)).body.effective_price).toBe('20.00');
    expect((await app.get<ProductView>(`/products/${p2}`)).body.effective_price).toBe('3.00');
  });
});

describe('(c) ingest path: job completion bumps each touched category once', () => {
  const ctx: InvocationContext = { remainingTimeMs: () => 60_000 };
  const logger = createLogger({ level: 'silent', pretty: false });
  let splitter: Splitter;
  let processor: ChunkProcessor;
  let catName: string;
  let cat: string;
  let sku: string;

  async function ingest(csv: string): Promise<JobStatusView> {
    const created = await app.upload<{ id: string }>('/ingest/jobs', {
      fields: { vendor_id: `vendor-${randomUUID()}` },
      file: { name: 'v.csv', content: csv },
    });
    expect(created.status).toBe(202);
    await app.ingest.splitQueue.drain((d) => splitter.handle(d.payload, ctx));
    await app.ingest.chunkQueue.drain((d) => processor.handle(d.payload, ctx));
    const status = await app.get<JobStatusView>(`/ingest/jobs/${created.body.id}`);
    expect(status.body.status).toBe('COMPLETED');
    return status.body;
  }

  beforeAll(async () => {
    const fx = app.ingest;
    splitter = new Splitter(
      { db: app.db, storage: fx.storage, splitQueue: fx.splitQueue, chunkQueue: fx.chunkQueue, logger, invalidation: fx.invalidation },
      { chunkSize: 2, reserveMs: 1_000, maxAttempts: env.INGEST_MAX_ATTEMPTS },
    );
    processor = new ChunkProcessor(
      { db: app.db, storage: fx.storage, logger, invalidation: fx.invalidation },
      { maxAttempts: env.INGEST_MAX_ATTEMPTS, staleAfterMs: env.INGEST_INVOCATION_TIMEOUT_MS },
    );
    catName = `cache-ingest-${randomUUID()}`;
    cat = (await app.pool.query<{ id: string }>('INSERT INTO categories (name) VALUES ($1) RETURNING id', [catName]))
      .rows[0]!.id;
    sku = `CACHE-ING-${randomUUID()}`;
  });

  it('a product ingested into a category on sale is discounted on first read, and the cached listing sees it', async () => {
    const promo = await app.post('/promotions', {
      name: 'ingest sale',
      category_id: cat,
      discount_type: 'PERCENTAGE',
      value: '50',
      ...window(),
    });
    expect(promo.status).toBe(201);
    const emptyPage = await app.get<ProductPage>(`/products?category_id=${cat}`);
    expect(emptyPage.body.items).toEqual([]);
    const v = Number(await version(cat));

    // Five rows across three chunks: one bump for the category, not five, not three.
    const rows = Array.from({ length: 5 }, (_, i) => `${i === 0 ? sku : `${sku}-${i}`},Row ${i},${catName},${10 + i}.00,1`);
    const status = await ingest(['sku,name,category,cost,stock_quantity', ...rows].join('\n') + '\n');
    expect(status.chunks.DONE).toBe(3);
    expect(Number(await version(cat))).toBe(v + 1);

    const base = priceRow({ cost: '10.00', category: catName });
    expect(base.ok).toBe(true);
    const basePrice = (base as { base_price: string }).base_price;
    const page = await app.get<ProductPage>(`/products?category_id=${cat}`);
    expect(page.body.items).toHaveLength(5);
    const first = page.body.items.find((p) => p.sku === sku)!;
    expect(first.base_price).toBe(basePrice);
    expect(first.effective_price).not.toBe(basePrice);
    expect(first.promotion?.name).toBe('ingest sale');
    expect((await app.get<ProductView>(`/products/${first.id}`)).body.effective_price).toBe(first.effective_price);
  });

  it('a re-ingest with no price change bumps nothing; moving a product to another category bumps both', async () => {
    const v = Number(await version(cat));
    await ingest(`sku,name,category,cost,stock_quantity\n${sku},Renamed,${catName},10.00,7\n`);
    expect(Number(await version(cat))).toBe(v);

    const otherName = `cache-ingest-${randomUUID()}`;
    await ingest(`sku,name,category,cost,stock_quantity\n${sku},Moved,${otherName},10.00,7\n`);
    const other = (await app.db.selectFrom('categories').select('id').where('name', '=', otherName).executeTakeFirstOrThrow()).id;
    expect(Number(await version(cat))).toBe(v + 1);
    expect(await version(other)).toBe('1');

    const oldPage = await app.get<ProductPage>(`/products?category_id=${cat}`);
    expect(oldPage.body.items.map((p) => p.sku)).not.toContain(sku);
    const moved = await app.db.selectFrom('products').select('id').where('sku', '=', sku).executeTakeFirstOrThrow();
    const detail = await app.get<ProductView>(`/products/${moved.id}`);
    expect(detail.body.category_id).toBe(other);
    expect(detail.body.promotion).toBeNull();
    // The mapping was corrected: the next read is served under the new category's version.
    expect(await app.redis.get(`product:${moved.id}:category`)).toBe(JSON.stringify(other));
  });
});

describe('(e) Redis unreachable', () => {
  let dark: TestApp;

  beforeAll(async () => {
    dark = await startTestApp({ redisUrl: 'redis://127.0.0.1:1' });
  });

  afterAll(async () => {
    await dark.close();
  });

  it('detail, listing, product create and promotion create all succeed straight from Postgres', async () => {
    const cat = await category();
    const id = await product(cat, '10.00');

    const detail = await dark.get<ProductView>(`/products/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.effective_price).toBe('10.00');

    const created = await dark.post<ProductView>('/products', {
      sku: `CACHE-${randomUUID()}`,
      name: 'Dark',
      category_id: cat,
      base_price: '5.00',
    });
    expect(created.status).toBe(201);

    const list = await dark.get<ProductPage>(`/products?category_id=${cat}`);
    expect(list.status).toBe(200);
    expect(list.body.items.map((p) => p.effective_price)).toEqual(['5.00', '10.00']);

    const promo = await dark.post<{ id: string }>('/promotions', {
      name: 'dark sale',
      category_id: cat,
      discount_type: 'PERCENTAGE',
      value: '50.00',
      starts_at: new Date(Date.now() - 3_600_000).toISOString(),
      ends_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(promo.status).toBe(201);

    const after = await dark.get<ProductView>(`/products/${id}`);
    expect(after.body.effective_price).toBe('5.00');
  });

  it('a live app whose Redis drops mid-flight keeps serving', async () => {
    const id = await product(categoryId, '7.00');
    expect((await app.get<ProductView>(`/products/${id}`)).body.effective_price).toBe('7.00');

    app.redis.disconnect();
    try {
      const res = await app.get<ProductView>(`/products/${id}`);
      expect(res.status).toBe(200);
      expect(res.body.effective_price).toBe('7.00');
    } finally {
      await app.redis.connect();
    }
    expect((await app.get<ProductView>(`/products/${id}`)).status).toBe(200);
  });
});
