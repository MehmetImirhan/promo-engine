/**
 * Dynamic pricing rules applied to every vendor row before it is saved
 * (ADR §7, "the pricing rules step"). This is the one place in the codebase
 * where price arithmetic happens outside SQL, and it happens in decimal.js:
 * inputs and outputs are decimal strings, never JS numbers.
 *
 * Rules:
 *   1. margin = max(category margin or default margin, floor margin)
 *   2. raw = cost × (1 + margin)
 *   3. base_price = raw rounded to the nearest price with the configured
 *      ending (e.g. .99); an exact tie rounds up
 *   4. a base_price below cost after rounding is a row error, not a save
 *
 * Pure functions: no I/O, no clock, no config lookup beyond the rules
 * object passed in. Unit-tested in isolation.
 */
import { Decimal } from 'decimal.js';

const D = Decimal.clone({ precision: 30, rounding: Decimal.ROUND_HALF_UP });

export interface PricingRules {
  /** Applied when the category has no override. "0.30" = 30 %. */
  defaultMargin: string;
  /** No category may go below this margin. */
  floorMargin: string;
  /** Per-category margin overrides keyed by category name. */
  categoryMargins: Record<string, string>;
  /** Cents part every price is rounded to, e.g. "0.99". */
  priceEnding: string;
}

/**
 * The rules in force. A real deployment would load these from a table or a
 * config service; a constant keeps this session honest about what the rule
 * engine is (a pure function) without inventing an admin surface.
 */
export const DEFAULT_PRICING_RULES: PricingRules = {
  defaultMargin: '0.30',
  floorMargin: '0.10',
  categoryMargins: {
    Electronics: '0.15',
    Accessories: '0.45',
  },
  priceEnding: '0.99',
};

export interface PricingInput {
  /** Vendor cost as a decimal string, e.g. "12.50". */
  cost: string;
  category: string;
}

export type PricingResult = { ok: true; base_price: string } | { ok: false; reason: string };

export function marginFor(category: string, rules: PricingRules): Decimal {
  const configured = new D(rules.categoryMargins[category] ?? rules.defaultMargin);
  return Decimal.max(configured, new D(rules.floorMargin));
}

/**
 * Nearest price with the configured ending. `low` is the largest such price
 * not above `raw`, `high` the next one up; ties go up. If `low` would be
 * negative (very cheap items) the only sensible candidate is `high`.
 */
export function roundToEnding(raw: Decimal, ending: Decimal): Decimal {
  let low = raw.minus(ending).floor().plus(ending);
  const high = low.plus(1);
  if (low.lt(0)) low = high;
  return raw.minus(low).gte('0.5') ? high : low;
}

export function priceRow(input: PricingInput, rules: PricingRules = DEFAULT_PRICING_RULES): PricingResult {
  const cost = new D(input.cost);
  const margin = marginFor(input.category, rules);
  const raw = cost.times(new D(1).plus(margin));
  const priced = roundToEnding(raw, new D(rules.priceEnding));

  if (priced.lt(cost)) {
    return {
      ok: false,
      reason: `priced ${priced.toFixed(2)} is below vendor cost ${cost.toFixed(2)} after rounding`,
    };
  }
  return { ok: true, base_price: priced.toFixed(2) };
}
