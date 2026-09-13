/**
 * Promotion writes. The "one active promotion per product/category" rule is
 * enforced only by the EXCLUDE constraints; this module never checks for
 * overlaps itself. It maps SQLSTATE 23P01 to a structured 409.
 *
 * Every successful write ends with one category version bump (ADR §6): the
 * promotion's category, or for product scope the product's category. That
 * bump is the entire cache invalidation of a 50k-product flash sale.
 */
import { sql } from 'kysely';
import type { DatabaseError } from 'pg';
import type { CategoryVersions } from '../cache/index.js';
import type { Db, DiscountType, Promotion } from '../db/index.js';
import { Conflict, NotFound, Validation } from '../shared/errors.js';
import { PG, isPgError, translateIntegrityError, type ConstraintMessages } from '../shared/pg-errors.js';
import type { AssignPromotionBody, CreatePromotionBody } from './schemas.js';

type Scope = AssignPromotionBody;

/** `status` as stored, evaluated against now(): an ACTIVE row outside its window is SCHEDULED or ENDED. */
export type EffectiveStatus = 'SCHEDULED' | 'ACTIVE' | 'ENDED' | 'CANCELLED';

export interface PromotionListItem extends Promotion {
  effective_status: EffectiveStatus;
  /** The target, named: set for product scope. */
  product: { id: string; sku: string; name: string; category_id: string } | null;
  /** The target, named: set for category scope. */
  category: { id: string; name: string } | null;
}

const CONSTRAINTS: ConstraintMessages = {
  promotions_product_id_fkey: { path: 'product_id', message: 'Unknown product_id' },
  promotions_category_id_fkey: { path: 'category_id', message: 'Unknown category_id' },
  promotions_one_scope: { path: 'product_id', message: 'Exactly one of product_id or category_id is required' },
  promotions_value_positive: { path: 'value', message: 'value must be greater than 0' },
  promotions_percentage_range: { path: 'value', message: 'PERCENTAGE value must be at most 100' },
  promotions_valid_range: { path: 'ends_at', message: 'ends_at must be after starts_at' },
};

/**
 * Product-scope rule from ADR §3: a FIXED discount must be lower than the
 * product's base price. Compared in SQL, no money arithmetic in JS. Category
 * scope skips this on purpose; the GREATEST(0, …) floor covers it.
 * Returns the product's category, which the cache bump needs.
 */
async function assertProductScopeAllowed(
  db: Db,
  productId: string,
  discountType: DiscountType,
  value: string,
): Promise<string> {
  const product = await db
    .selectFrom('products')
    .select(['base_price', 'category_id', sql<boolean>`base_price <= ${value}::numeric`.as('value_covers_price')])
    .where('id', '=', productId)
    .executeTakeFirst();

  if (!product) {
    throw new Validation('Unknown product_id', [{ path: 'product_id', message: 'Unknown product_id' }]);
  }
  if (discountType === 'FIXED' && product.value_covers_price) {
    throw new Validation('FIXED value must be lower than the product base price', [
      { path: 'value', message: `value ${value} is not below base_price ${product.base_price}` },
    ]);
  }
  return product.category_id;
}

/** 23P01 → 409 with a body that says which scope and window collided. */
function overlapConflict(err: DatabaseError, scope: Scope, window: { starts_at: unknown; ends_at: unknown }): never {
  const isProduct = err.constraint === 'no_overlapping_product_promos';
  throw new Conflict(`An active ${isProduct ? 'product' : 'category'}-scope promotion already overlaps this window`, {
    constraint: err.constraint,
    scope: isProduct ? 'product' : 'category',
    ...(isProduct ? { product_id: scope.product_id } : { category_id: scope.category_id }),
    starts_at: window.starts_at,
    ends_at: window.ends_at,
  });
}

function mapWriteError(err: unknown, scope: Scope, window: { starts_at: unknown; ends_at: unknown }): never {
  if (isPgError(err, PG.EXCLUSION_VIOLATION)) overlapConflict(err, scope, window);
  return translateIntegrityError(err, CONSTRAINTS);
}

type ListRow = Promotion & {
  product_sku: string | null;
  product_name: string | null;
  product_category_id: string | null;
  category_name: string | null;
  effective_status: EffectiveStatus;
};

function toListItem({ product_sku, product_name, product_category_id, category_name, ...promotion }: ListRow): PromotionListItem {
  return {
    ...promotion,
    product:
      promotion.product_id !== null && product_sku !== null && product_name !== null && product_category_id !== null
        ? { id: promotion.product_id, sku: product_sku, name: product_name, category_id: product_category_id }
        : null,
    category:
      promotion.category_id !== null && category_name !== null ? { id: promotion.category_id, name: category_name } : null,
  };
}

export class PromotionsService {
  constructor(
    private readonly db: Db,
    private readonly versions: CategoryVersions,
  ) {}

  /**
   * Newest first. Ordered by id, which is uuidv7 and therefore creation
   * order, so the primary key index serves the sort. The active window is
   * [starts_at, ends_at), the same half-open range the effective-price
   * query tests with `@> now()`.
   */
  async list(limit: number): Promise<PromotionListItem[]> {
    const rows = await this.db
      .selectFrom('promotions as pr')
      .leftJoin('products as p', 'p.id', 'pr.product_id')
      .leftJoin('categories as c', 'c.id', 'pr.category_id')
      .selectAll('pr')
      .select([
        'p.sku as product_sku',
        'p.name as product_name',
        'p.category_id as product_category_id',
        'c.name as category_name',
        sql<EffectiveStatus>`CASE
          WHEN pr.status = 'CANCELLED' THEN 'CANCELLED'
          WHEN now() < pr.starts_at    THEN 'SCHEDULED'
          WHEN now() >= pr.ends_at     THEN 'ENDED'
          ELSE 'ACTIVE' END`.as('effective_status'),
      ])
      .orderBy('pr.id', 'desc')
      .limit(limit)
      .execute();
    return rows.map(toListItem);
  }

  /** One INSERT, one bump. Category scope never iterates products (ADR §4). */
  async create(input: CreatePromotionBody): Promise<Promotion> {
    const affected =
      input.product_id !== undefined
        ? await assertProductScopeAllowed(this.db, input.product_id, input.discount_type, input.value)
        : input.category_id!;
    let created: Promotion;
    try {
      created = await this.db
        .insertInto('promotions')
        .values({
          name: input.name,
          product_id: input.product_id ?? null,
          category_id: input.category_id ?? null,
          discount_type: input.discount_type,
          value: input.value,
          starts_at: input.starts_at,
          ends_at: input.ends_at,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    } catch (err) {
      return mapWriteError(err, input, input);
    }
    await this.versions.bump([affected]);
    return created;
  }

  /** Status flip, never a delete. Idempotent: cancelling twice returns the row unchanged and bumps nothing. */
  async cancel(id: string): Promise<Promotion> {
    const updated = await this.db
      .updateTable('promotions')
      .set({ status: 'CANCELLED', updated_at: sql`now()` })
      .where('id', '=', id)
      .where('status', '<>', 'CANCELLED')
      .returningAll()
      .executeTakeFirst();
    if (!updated) return this.findOrThrow(id);
    await this.versions.bump([await this.categoryOf(updated)]);
    return updated;
  }

  /**
   * Re-target an active promotion to another product or category. One
   * UPDATE; the EXCLUDE constraints validate the new target exactly as
   * they validate an INSERT, so an overlap is the same 409.
   */
  async assign(id: string, target: AssignPromotionBody): Promise<Promotion> {
    const existing = await this.findOrThrow(id);
    if (existing.status === 'CANCELLED') {
      throw new Conflict('Cannot assign a cancelled promotion; create a new one', { promotion_id: id });
    }
    const newCategory =
      target.product_id !== undefined
        ? await assertProductScopeAllowed(this.db, target.product_id, existing.discount_type, existing.value)
        : target.category_id!;
    let updated: Promotion;
    try {
      updated = await this.db
        .updateTable('promotions')
        .set({
          product_id: target.product_id ?? null,
          category_id: target.category_id ?? null,
          updated_at: sql`now()`,
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
    } catch (err) {
      return mapWriteError(err, target, existing);
    }
    // Prices change where the promotion left and where it landed.
    await this.versions.bump([await this.categoryOf(existing), newCategory]);
    return updated;
  }

  /** The category whose prices a promotion affects: its own, or its product's. */
  private async categoryOf(promotion: Pick<Promotion, 'product_id' | 'category_id'>): Promise<string> {
    if (promotion.category_id !== null) return promotion.category_id;
    const product = await this.db
      .selectFrom('products')
      .select('category_id')
      .where('id', '=', promotion.product_id!)
      .executeTakeFirstOrThrow();
    return product.category_id;
  }

  private async findOrThrow(id: string): Promise<Promotion> {
    const row = await this.db.selectFrom('promotions').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) throw new NotFound(`Promotion ${id} not found`);
    return row;
  }
}
