import { describe, expect, test } from 'bun:test';

import fc from 'fast-check';

import { num } from '../../src/utils/num.ts';

describe('num properties', () => {
  test('returns the value exactly when it is a finite number', () => {
    fc.assert(
      fc.property(fc.oneof(fc.double(), fc.anything()), (value) => {
        const finite = typeof value === 'number' && Number.isFinite(value);
        expect(num(value)).toBe(finite ? value : undefined);
      })
    );
  });
});
