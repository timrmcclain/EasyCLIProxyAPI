import { describe, expect, it } from 'bun:test';
import { parsePriceInput, valueMultiple } from '../src/services/accountValue';

describe('subscription value', () => {
  it('reads typed prices, clears on empty, and rejects nonsense', () => {
    expect(parsePriceInput('$200')).toBe(200);
    expect(parsePriceInput(' 1,200.50 ')).toBe(1200.5);
    expect(parsePriceInput('')).toBeNull();
    expect(parsePriceInput('abc')).toBeUndefined();
    expect(parsePriceInput('-5')).toBeUndefined();
  });

  it('compares API-equivalent value with the monthly price only when a price is set', () => {
    expect(valueMultiple(640, 200)).toBe(3.2);
    expect(valueMultiple(50, 200)).toBe(0.3);
    expect(valueMultiple(640, undefined)).toBeUndefined();
    expect(valueMultiple(640, 0)).toBeUndefined();
  });
});
