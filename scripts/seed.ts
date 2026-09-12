/**
 * Development seed: a few categories, N products, and two promotions so the
 * listing shows discounted prices out of the box.
 *
 *   npm run seed                      # 4 categories, 200 products
 *   npm run seed -- --products 5000   # enough for pagination to be interesting
 *   npm run seed -- --categories 6 --products 50000
 *
 * Idempotent: categories and products use ON CONFLICT DO NOTHING; promotions
 * are inserted only if a promotion with the same name does not exist.
 *
 * Prices are computed in SQL (generate_series → numeric). No money value
 * ever exists as a JS number here (CLAUDE.md money rule).
 */
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { env } from '../src/config/index.js';
import { createPool } from '../src/db/index.js';
import { createLogger } from '../src/shared/logger.js';

const CATEGORY_NAMES = ['Accessories', 'Shoes', 'Apparel', 'Electronics', 'Home', 'Beauty', 'Sports', 'Toys'];

const argsSchema = z.object({
  products: z.coerce.number().int().min(1).max(1_000_000),
  categories: z.coerce.number().int().min(1).max(200),
});

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      products: { type: 'string', default: '200' },
      categories: { type: 'string', default: '4' },
    },
  });
  const args = argsSchema.parse(values);
  const logger = createLogger({ level: env.LOG_LEVEL, pretty: env.NODE_ENV === 'development' });
  const pool = createPool(env.DATABASE_URL);

  try {
    // Categories: fixed names first, then "Category N".
    const names = Array.from({ length: args.categories }, (_, i) => CATEGORY_NAMES[i] ?? `Category ${i + 1}`);
    await pool.query(
      `INSERT INTO categories (name) SELECT unnest($1::text[]) ON CONFLICT (name) DO NOTHING`,
      [names],
    );
    const { rows: categories } = await pool.query<{ id: string; name: string }>(
      `SELECT id, name FROM categories WHERE name = ANY($1::text[]) ORDER BY array_position($1::text[], name)`,
      [names],
    );
    const categoryIds = categories.map((c) => c.id);

    // Products: one INSERT ... SELECT. SKU is zero-padded so text order == numeric order.
    // Price: 150 distinct values between 1.00 and 199.17, so any seed larger
    // than 150 products has price ties and the (effective_price, id) tiebreaker matters.
    const inserted = await pool.query(
      `INSERT INTO products (sku, name, category_id, base_price, stock_quantity)
       SELECT 'SEED-' || lpad(g::text, 6, '0'),
              'Seed product ' || g,
              ($1::uuid[])[(g % $2::int) + 1],
              (((g * 7919) % 150) * 133 + 100)::numeric / 100,
              (g * 31) % 500
       FROM generate_series(1, $3::int) g
       ON CONFLICT (sku) DO NOTHING`,
      [categoryIds, categoryIds.length, args.products],
    );

    // Promotions: one category-scope, one product-scope (only where the FIXED rule allows it).
    const promoCategory = categories[0]!;
    const catPromo = await pool.query(
      `INSERT INTO promotions (name, category_id, discount_type, value, starts_at, ends_at)
       SELECT $1, $2, 'PERCENTAGE', 20, now() - interval '1 hour', now() + interval '30 days'
       WHERE NOT EXISTS (SELECT 1 FROM promotions WHERE name = $1)`,
      [`Seed: 20% off ${promoCategory.name}`, promoCategory.id],
    );
    const prodPromo = await pool.query(
      `INSERT INTO promotions (name, product_id, discount_type, value, starts_at, ends_at)
       SELECT $1, p.id, 'FIXED', 5.00, now() - interval '1 hour', now() + interval '30 days'
       FROM products p
       WHERE p.category_id = $2 AND p.base_price > 5.00 AND p.sku LIKE 'SEED-%'
         AND NOT EXISTS (SELECT 1 FROM promotions WHERE name = $1)
       ORDER BY p.sku
       LIMIT 1`,
      [`Seed: 5.00 off one ${promoCategory.name} product`, promoCategory.id],
    );

    logger.info(
      {
        categories: categoryIds.length,
        products_inserted: inserted.rowCount ?? 0,
        products_requested: args.products,
        promotions_inserted: (catPromo.rowCount ?? 0) + (prodPromo.rowCount ?? 0),
      },
      'seed complete',
    );
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  createLogger({ level: 'info', pretty: false }).fatal({ err }, 'seed failed');
  process.exit(1);
});
