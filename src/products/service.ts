/**
 * Product reads. Both queries start from `pricedProducts()` — the one place
 * the effective-price rule exists. Nothing here touches a price in JS: money
 * arrives as strings and leaves as strings.
 *
 * Caching (ADR §6): both reads are cache-aside under a per-category version.
 *   detail   product:{id}:v{token}                          TTL 300 s
 *   listing  products:list:{cat|all}:{order}:{limit}:{cursor}:v{token}  TTL 60 s
 * The detail key needs the product's category before it can be built, so
 * the product → category mapping is cached beside it (24 h, refreshed on
 * every miss). Invalidation is never a delete: a bump changes the token.
 */
import { sql } from 'kysely';
import { ALL_SCOPE, type Cache } from '../cache/index.js';
import type { Db, DiscountType } from '../db/index.js';
import { NotFound } from '../shared/errors.js';
import { translateIntegrityError, type ConstraintMessages } from '../shared/pg-errors.js';
import { decodeCursor, encodeCursor, type CursorKey, type CursorScope, type SortOrder } from './cursor.js';
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
  stock_quantity: number;
  effective_price: string;
  /** The promotion that produced effective_price, or null when it equals base_price. */
  promotion: AppliedPromotion | null;
  /** ISO 8601; strings so the view survives the JSON round trip through the cache unchanged. */
  created_at: string;
  updated_at: string;
}

export interface CreateProductInput {
  sku: string;
  name: string;
  category_id: string;
  base_price: string;
  stock_quantity: number;
}

const CONSTRAINTS: ConstraintMessages = {
  products_sku_key: { path: 'sku', message: 'A product with this SKU already exists' },
  products_category_id_fkey: { path: 'category_id', message: 'Unknown category_id' },
  products_base_price_nonnegative: { path: 'base_price', message: 'base_price must be at least 0' },
  products_stock_quantity_nonnegative: { path: 'stock_quantity', message: 'stock_quantity must be at least 0' },
};

export interface ListProductsParams {
  category_id?: string | undefined;
  order: SortOrder;
  limit: number;
  cursor?: string | undefined;
}

export const DETAIL_TTL_S = 300;
export const LIST_TTL_S = 60;
/** The product → category mapping only changes when ingest moves a product; a miss refreshes it. */
const CATEGORY_MAP_TTL_S = 86_400;

export function detailKeyPrefix(id: string): string {
  return `product:${id}`;
}

export function categoryMapKey(id: string): string {
  return `product:${id}:category`;
}

export function listKeyPrefix({ category_id, order, limit, cursor }: ListProductsParams): string {
  return `products:list:${category_id ?? 'all'}:${order}:${limit}:${cursor ?? '-'}`;
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
    stock_quantity: row.stock_quantity,
    effective_price: row.effective_price,
    promotion,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export class ProductsService {
  constructor(
    private readonly db: Db,
    private readonly cache: Cache,
  ) {}

  /**
   * Two cache-aside reads: the product's category (needed to know which
   * version the detail key carries), then the priced view under that
   * version. A product ingest moved to another category is detected when
   * the fresh view disagrees with the mapping; the mapping is corrected and
   * the entry written under the old category's token is simply never read
   * again.
   */
  async getProduct(id: string): Promise<ProductView> {
    const categoryId = await this.cache.getOrCompute(categoryMapKey(id), CATEGORY_MAP_TTL_S, () =>
      this.lookupCategory(id),
    );
    const view = await this.cache.getOrComputeVersioned(categoryId, detailKeyPrefix(id), DETAIL_TTL_S, () =>
      this.readProduct(id),
    );
    if (view.category_id !== categoryId) {
      await this.cache.put(categoryMapKey(id), CATEGORY_MAP_TTL_S, view.category_id);
    }
    return view;
  }

  private async lookupCategory(id: string): Promise<string> {
    const row = await this.db.selectFrom('products').select('category_id').where('id', '=', id).executeTakeFirst();
    if (!row) throw new NotFound(`Product ${id} not found`);
    return row.category_id;
  }

  private async readProduct(id: string): Promise<ProductView> {
    const row = await pricedProducts(this.db).where('p.id', '=', id).executeTakeFirst();
    if (!row) throw new NotFound(`Product ${id} not found`);
    return toProductView(row);
  }

  /**
   * One INSERT, then the normal priced read. A product created into a
   * category with an active promotion is returned already discounted:
   * that is Scenario B's auto-inherit, with no extra code.
   */
  async createProduct(input: CreateProductInput): Promise<ProductView> {
    let id: string;
    try {
      ({ id } = await this.db.insertInto('products').values(input).returning('id').executeTakeFirstOrThrow());
    } catch (err) {
      return translateIntegrityError(err, CONSTRAINTS);
    }
    // The new product changes its category's listing; the bump makes every cached page of it unreachable.
    await this.cache.versions.bump([input.category_id]);
    return this.getProduct(id);
  }

  /**
   * Keyset pagination (ADR §5). `pricedProducts()` is wrapped as a subquery
   * so the WHERE and ORDER BY can name `effective_price` directly — a select
   * alias is not visible in its own WHERE, and repeating the pricing
   * expression here would duplicate the rule. Postgres flattens the wrapper,
   * so the category filter still applies before the lateral join.
   */
  async listProducts(params: ListProductsParams): Promise<ProductPage> {
    const { category_id, order, cursor } = params;
    const scope: CursorScope = { order, categoryId: category_id ?? null };
    // Decoded before the cache so a bad cursor is a 400 without a Redis round trip.
    const key = cursor === undefined ? null : decodeCursor(cursor, scope);
    return this.cache.getOrComputeVersioned(category_id ?? ALL_SCOPE, listKeyPrefix(params), LIST_TTL_S, () =>
      this.readPage(params, scope, key),
    );
  }

  private async readPage(
    { category_id, order, limit }: ListProductsParams,
    scope: CursorScope,
    key: CursorKey | null,
  ): Promise<ProductPage> {
    let query = this.db.selectFrom(pricedProducts(this.db).as('t')).selectAll('t');

    if (category_id !== undefined) {
      query = query.where('t.category_id', '=', category_id);
    }

    if (key !== null) {
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
  }
}
