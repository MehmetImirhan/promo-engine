import { describe, expect, it } from 'vitest';
import { Validation } from '../shared/errors.js';
import { decodeCursor, encodeCursor } from './cursor.js';

const key = { effectivePrice: '17.99', id: '019212a0-7b1e-7c3a-9f0e-2d5b3c4a1f00' };

describe('cursor', () => {
  it('round-trips (effective_price, id)', () => {
    expect(decodeCursor(encodeCursor(key))).toEqual(key);
  });

  it('keeps the price as the exact string it was given', () => {
    const decoded = decodeCursor(encodeCursor({ ...key, effectivePrice: '0.00' }));
    expect(decoded.effectivePrice).toBe('0.00');
    expect(typeof decoded.effectivePrice).toBe('string');
  });

  it('is URL-safe (no +, / or = characters)', () => {
    const cursor = encodeCursor(key);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(cursor)).toBe(cursor);
  });

  it.each([
    ['not base64 json', 'zzz'],
    ['empty', ''],
    ['json but wrong shape', Buffer.from('{"foo":1}').toString('base64url')],
    ['price is a number', Buffer.from('{"p":17.99,"i":"019212a0-7b1e-7c3a-9f0e-2d5b3c4a1f00"}').toString('base64url')],
    ['price not 2dp', Buffer.from('{"p":"17.9","i":"019212a0-7b1e-7c3a-9f0e-2d5b3c4a1f00"}').toString('base64url')],
    ['id not a uuid', Buffer.from('{"p":"17.99","i":"1"}').toString('base64url')],
    ['extra keys', Buffer.from('{"p":"17.99","i":"019212a0-7b1e-7c3a-9f0e-2d5b3c4a1f00","x":1}').toString('base64url')],
  ])('rejects %s with Validation', (_label, cursor) => {
    expect(() => decodeCursor(cursor)).toThrow(Validation);
  });
});
