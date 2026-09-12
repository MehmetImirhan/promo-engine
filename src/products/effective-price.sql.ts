/**
 * The ONE place the effective-price rule exists (ADR §4, CLAUDE.md).
 *
 * Both the product detail query and the listing query are built from
 * `pricedProducts()`. Nothing else may compute a discounted price — not in
 * SQL elsewhere, and never in TypeScript.
 *
 * Rules:
 * - Active = status 'ACTIVE' and now() inside [starts_at, ends_at).
 * - Product-scope promotion beats category-scope (precedence, ADR §4).
 * - PERCENTAGE: ROUND(base * (1 - value/100), 2). Postgres numeric ROUND is
 *   half away from zero, i.e. half-up for non-negative prices.
 * - FIXED: GREATEST(0, base - value) — floors at zero. Category-scope FIXED
 *   promotions are not validated against every product's price, so this
 *   floor is load-bearing, not cosmetic.
 * - The result is cast to numeric(12,2) so a zero floor reads "0.00", not "0",
 *   and the cursor always carries a 2dp string.
 */
import { sql, type Expression, type RawBuilder } from 'kysely';
import type { Db } from '../db/index.js';

/**
 * Discounted price for one (base_price, discount_type, value) triple.
 * All three arguments are SQL expressions (column refs or typed parameters);
 * the arithmetic happens in Postgres numeric, never in JS.
 */
export function discountedPrice(
  base: Expression<unknown>,
  discountType: Expression<unknown>,
  value: Expression<unknown>,
): RawBuilder<string> {
  return sql<string>`(
    CASE ${discountType}
      WHEN 'PERCENTAGE' THEN ROUND(${base} * (1 - ${value} / 100), 2)
      WHEN 'FIXED'      THEN GREATEST(0, ${base} - ${value})
    END
  )::numeric(12,2)`;
}

/**
 * `products` joined laterally to its single winning active promotion.
 *
 * Selects every product column plus:
 * - effective_price: the discounted price, or base_price when nothing applies
 * - promotion_id / promotion_name / promotion_type / promotion_value: the
 *   applied promotion, all null when nothing applies
 *
 * The lateral subquery hits the two partial GiST indexes created by the
 * EXCLUDE constraints (equality on product_id / category_id via btree_gist),
 * so per-product cost is an index probe over ≈1–2 rows.
 */
export function pricedProducts(db: Db) {
  return db
    .selectFrom('products as p')
    .leftJoinLateral(
      (eb) =>
        eb
          .selectFrom('promotions as pr')
          .select((seb) => [
            'pr.id as promotion_id',
            'pr.name as promotion_name',
            'pr.discount_type as promotion_type',
            'pr.value as promotion_value',
            discountedPrice(
              seb.ref('p.base_price'),
              seb.ref('pr.discount_type'),
              seb.ref('pr.value'),
            ).as('discounted_price'),
          ])
          .where('pr.status', '=', 'ACTIVE')
          .where(sql<boolean>`tstzrange(pr.starts_at, pr.ends_at) @> now()`)
          .where((seb) =>
            seb.or([
              seb('pr.product_id', '=', seb.ref('p.id')),
              seb('pr.category_id', '=', seb.ref('p.category_id')),
            ]),
          )
          // Product scope wins over category scope.
          .orderBy(sql`(pr.product_id IS NOT NULL)`, 'desc')
          .limit(1)
          .as('promo'),
      (join) => join.onTrue(),
    )
    .select([
      'p.id',
      'p.sku',
      'p.name',
      'p.category_id',
      'p.base_price',
      'p.created_at',
      'p.updated_at',
      sql<string>`COALESCE(promo.discounted_price, p.base_price)`.as('effective_price'),
      'promo.promotion_id',
      'promo.promotion_name',
      'promo.promotion_type',
      'promo.promotion_value',
    ]);
}

/** One row of `pricedProducts()`. Money fields are strings. */
export type PricedProduct = Awaited<ReturnType<ReturnType<typeof pricedProducts>['execute']>>[number];
