import { describe, expect, test } from 'bun:test';

import { assert, property, oneof, double, anything } from 'fast-check';

import { num } from '../../src/utils/num.ts';

describe('num properties', () => {
  test('returns the value exactly when it is a finite number', () => {
    assert(
      property(oneof(double(), anything()), (value) => {
        const finite = typeof value === 'number' && Number.isFinite(value);
        expect(num(value)).toBe(finite ? value : undefined);
      })
    );
  });
});
