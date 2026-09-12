/**
 * Product reads. Both queries start from `pricedProducts()` — the one place
 * the effective-price rule exists. Nothing here touches a price in JS: money
 * arrives as strings and leaves as strings.
 */
import { sql } from 'kysely';
import type { Db, DiscountType } from '../db/index.js';
import { NotFound } from '../shared/errors.js';
import { decodeCursor, encodeCursor, type CursorScope, type SortOrder } from './cursor.js';
import { pricedProducts, type PricedProduct } from './effective-price.sql.js';

export type { SortOrder };

export interface AppliedPromotion {
  id: string;
  name: string;
  type: DiscountType;
  value: string;
}

export interface ProductView {
  id: string;
  sku: string;
  name: string;
  category_id: string;
  base_price: string;
  effective_price: string;
  /** The promotion that produced effective_price, or null when it equals base_price. */
  promotion: AppliedPromotion | null;
  created_at: Date;
  updated_at: Date;
}

export interface ListProductsParams {
  category_id?: string | undefined;
  order: SortOrder;
  limit: number;
  cursor?: string | undefined;
}

export interface ProductPage {
  items: ProductView[];
  /** Pass back as `cursor` with the same category_id and order to get the next page; null on the last page. A cursor sent with a different order or category_id is rejected with 400. */
  next_cursor: string | null;
}

export function toProductView(row: PricedProduct): ProductView {
  const promotion: AppliedPromotion | null =
    row.promotion_id !== null && row.promotion_name !== null && row.promotion_type !== null && row.promotion_value !== null
      ? { id: row.promotion_id, name: row.promotion_name, type: row.promotion_type, value: row.promotion_value }
      : null;

  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    category_id: row.category_id,
    base_price: row.base_price,
    effective_price: row.effective_price,
    promotion,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function createProductsService(db: Db) {
  return {
    async getProduct(id: string): Promise<ProductView> {
      const row = await pricedProducts(db).where('p.id', '=', id).executeTakeFirst();
      if (!row) throw new NotFound(`Product ${id} not found`);
      return toProductView(row);
    },

    /**
     * Keyset pagination (ADR §5). `pricedProducts()` is wrapped as a subquery
     * so the WHERE and ORDER BY can name `effective_price` directly — a select
     * alias is not visible in its own WHERE, and repeating the pricing
     * expression here would duplicate the rule. Postgres flattens the wrapper,
     * so the category filter still applies before the lateral join.
     */
    async listProducts({ category_id, order, limit, cursor }: ListProductsParams): Promise<ProductPage> {
      const scope: CursorScope = { order, categoryId: category_id ?? null };
      let query = db.selectFrom(pricedProducts(db).as('t')).selectAll('t');

      if (category_id !== undefined) {
        query = query.where('t.category_id', '=', category_id);
      }

      if (cursor !== undefined) {
        const key = decodeCursor(cursor, scope);
        // Row-value comparison over the full sort key; `id` makes the order total.
        // Ascending pages continue past the key, descending pages continue before it.
        query =
          order === 'asc'
            ? query.where(sql<boolean>`(t.effective_price, t.id) > (${key.effectivePrice}::numeric, ${key.id}::uuid)`)
            : query.where(sql<boolean>`(t.effective_price, t.id) < (${key.effectivePrice}::numeric, ${key.id}::uuid)`);
      }

      // Fetch one extra row to learn whether a next page exists without a COUNT.
      const rows = await query
        .orderBy('t.effective_price', order)
        .orderBy('t.id', order)
        .limit(limit + 1)
        .execute();

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page.at(-1);

      return {
        items: page.map(toProductView),
        next_cursor: hasMore && last ? encodeCursor({ effectivePrice: last.effective_price, id: last.id }, scope) : null,
      };
    },
  };
}

export type ProductsService = ReturnType<typeof createProductsService>;
