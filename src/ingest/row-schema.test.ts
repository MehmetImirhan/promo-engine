import { describe, expect, it } from 'vitest';
import { missingColumns, validateRow } from './row-schema.js';

const good = { sku: ' SKU-1 ', name: 'Çığ Ünïcode, "deluxe"', category: 'Shoes', cost: '12.5', stock_quantity: '07' };

describe('validateRow', () => {
  it('accepts a well-formed row, trims text, keeps cost a string and stock an integer', () => {
    const result = validateRow(good);
    expect(result).toEqual({
      ok: true,
      row: { sku: 'SKU-1', name: 'Çığ Ünïcode, "deluxe"', category: 'Shoes', cost: '12.5', stock_quantity: 7 },
    });
  });

  it.each([
    ['missing cost (short row)', { ...good, cost: undefined }, 'cost'],
    ['empty sku', { ...good, sku: '  ' }, 'sku'],
    ['cost with 3 decimals', { ...good, cost: '1.005' }, 'cost'],
    ['cost as words', { ...good, cost: 'twelve' }, 'cost'],
    ['zero cost', { ...good, cost: '0.00' }, 'cost'],
    ['negative stock', { ...good, stock_quantity: '-1' }, 'stock_quantity'],
    ['fractional stock', { ...good, stock_quantity: '1.5' }, 'stock_quantity'],
    ['empty stock', { ...good, stock_quantity: '' }, 'stock_quantity'],
  ])('rejects %s with a path', (_label, raw, path) => {
    const result = validateRow(raw as Record<string, string | undefined>);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => e.path)).toContain(path);
  });

  it('reports every issue on a row, not just the first', () => {
    const result = validateRow({ sku: '', name: '', category: '', cost: 'x', stock_quantity: 'y' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect([...new Set(result.errors.map((e) => e.path))].sort()).toEqual(['category', 'cost', 'name', 'sku', 'stock_quantity']);
  });
});

describe('missingColumns', () => {
  it('ignores order and extra columns, reports the absent ones', () => {
    expect(missingColumns(['stock_quantity', 'cost', 'category', 'name', 'sku', 'vendor_note'])).toEqual([]);
    expect(missingColumns(['sku', 'name', 'price'])).toEqual(['category', 'cost', 'stock_quantity']);
  });
});
