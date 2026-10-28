import { expect, test } from 'bun:test';

import { num } from '../../src/utils/num.ts';

test('num keeps finite numbers and drops everything else', () => {
  expect(num(0)).toBe(0);
  expect(num(42)).toBe(42);
  expect(num(Number.NaN)).toBeUndefined();
  expect(num(Number.POSITIVE_INFINITY)).toBeUndefined();
  expect(num('5')).toBeUndefined();
  expect(num(null)).toBeUndefined();
  expect(num(undefined)).toBeUndefined();
});
