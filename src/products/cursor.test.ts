import { describe, expect, it } from 'vitest';
import { Validation } from '../shared/errors.js';
import { decodeCursor, encodeCursor, type CursorScope } from './cursor.js';

const key = { effectivePrice: '17.99', id: '019212a0-7b1e-7c3a-9f0e-2d5b3c4a1f00' };
const scope: CursorScope = { order: 'asc', categoryId: '019212a0-7b1e-7c3a-9f0e-2d5b3c4a1f01' };
const b64 = (s: string) => Buffer.from(s).toString('base64url');

describe('cursor', () => {
  it('round-trips (effective_price, id) for the same listing', () => {
    expect(decodeCursor(encodeCursor(key, scope), scope)).toEqual(key);
  });

  it('round-trips with no category filter', () => {
    const unfiltered: CursorScope = { order: 'desc', categoryId: null };
    expect(decodeCursor(encodeCursor(key, unfiltered), unfiltered)).toEqual(key);
  });

  it('keeps the price as the exact string it was given', () => {
    const decoded = decodeCursor(encodeCursor({ ...key, effectivePrice: '0.00' }, scope), scope);
    expect(decoded.effectivePrice).toBe('0.00');
    expect(typeof decoded.effectivePrice).toBe('string');
  });

  it('is URL-safe (no +, / or = characters)', () => {
    const cursor = encodeCursor(key, scope);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(cursor)).toBe(cursor);
  });

  it('rejects a cursor replayed with a different order', () => {
    const cursor = encodeCursor(key, scope);
    expect(() => decodeCursor(cursor, { ...scope, order: 'desc' })).toThrow(/does not belong/);
  });

  it('rejects a cursor replayed with a different category (or none)', () => {
    const cursor = encodeCursor(key, scope);
    expect(() => decodeCursor(cursor, { ...scope, categoryId: '019212a0-7b1e-7c3a-9f0e-2d5b3c4a1f02' })).toThrow(Validation);
    expect(() => decodeCursor(cursor, { ...scope, categoryId: null })).toThrow(Validation);
  });

  const valid = { p: '17.99', i: key.id, o: 'asc', c: scope.categoryId };
  it.each([
    ['not base64 json', 'zzz'],
    ['empty', ''],
    ['json but wrong shape', b64('{"foo":1}')],
    ['price is a number', b64(JSON.stringify({ ...valid, p: 17.99 }))],
    ['price not 2dp', b64(JSON.stringify({ ...valid, p: '17.9' }))],
    ['id not a uuid', b64(JSON.stringify({ ...valid, i: '1' }))],
    ['order not asc/desc', b64(JSON.stringify({ ...valid, o: 'up' }))],
    ['missing scope fields', b64(JSON.stringify({ p: valid.p, i: valid.i }))],
    ['extra keys', b64(JSON.stringify({ ...valid, x: 1 }))],
  ])('rejects %s with Validation', (_label, cursor) => {
    expect(() => decodeCursor(cursor, scope)).toThrow(Validation);
  });
});
