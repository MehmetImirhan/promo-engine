import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PRICING_RULES, marginFor, priceRow, roundToEnding, type PricingRules } from './pricing-rules.js';

const rules: PricingRules = {
  defaultMargin: '0.30',
  floorMargin: '0.10',
  categoryMargins: { Electronics: '0.15', Clearance: '0.02' },
  priceEnding: '0.99',
};

describe('marginFor', () => {
  it('uses the category override, else the default, never below the floor', () => {
    expect(marginFor('Shoes', rules).toString()).toBe('0.3');
    expect(marginFor('Electronics', rules).toString()).toBe('0.15');
    expect(marginFor('Clearance', rules).toString()).toBe('0.1');
  });
});

describe('roundToEnding', () => {
  const ending = new Decimal('0.99');
  it.each([
    ['12.34', '11.99'], // nearest .99 is below
    ['12.60', '12.99'], // nearest .99 is above
    ['12.30', '11.99'],
    ['12.49', '12.99'], // exact tie between 11.99 and 12.99 rounds up
    ['13.00', '12.99'],
    ['0.13', '0.99'], // low candidate would be negative
  ])('%s → %s', (raw, expected) => {
    expect(roundToEnding(new Decimal(raw), ending).toFixed(2)).toBe(expected);
  });
});

describe('priceRow', () => {
  it('applies margin then rounds to the price ending, returning a 2dp string', () => {
    expect(priceRow({ cost: '10.00', category: 'Shoes' }, rules)).toEqual({ ok: true, base_price: '12.99' });
    expect(priceRow({ cost: '10.00', category: 'Electronics' }, rules)).toEqual({ ok: true, base_price: '11.99' });
    expect(priceRow({ cost: '10.00', category: 'Clearance' }, rules)).toEqual({ ok: true, base_price: '10.99' });
  });

  it('keeps decimal precision that floats would lose', () => {
    // 0.1 * 1.3 in binary floating point is 0.13000000000000003
    expect(priceRow({ cost: '0.10', category: 'Shoes' }, rules)).toEqual({ ok: true, base_price: '0.99' });
    expect(priceRow({ cost: '1234567.89', category: 'Shoes' }, rules)).toEqual({ ok: true, base_price: '1604937.99' });
  });

  it('rejects a row whose rounded price falls below vendor cost', () => {
    // 1.30 × 1.10 = 1.43 → nearest .99 is 0.99 < cost
    const result = priceRow({ cost: '1.30', category: 'Clearance' }, rules);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/below vendor cost 1\.30/);
  });

  it('never produces a JS number anywhere in the result', () => {
    const result = priceRow({ cost: '19.99', category: 'Accessories' }, DEFAULT_PRICING_RULES);
    expect(result).toEqual({ ok: true, base_price: '28.99' });
    expect(typeof (result as { base_price: string }).base_price).toBe('string');
  });
});
