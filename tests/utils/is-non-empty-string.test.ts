import { describe, expect, test } from 'bun:test';

import { isNonEmptyString } from '../../src/utils/is-non-empty-string.ts';

describe('isNonEmptyString', () => {
  test('accepts non-empty strings', () => {
    expect(isNonEmptyString('a')).toBe(true);
    expect(isNonEmptyString(' ')).toBe(true);
    expect(isNonEmptyString('0')).toBe(true);
  });

  test('rejects the empty string, undefined and null', () => {
    expect(isNonEmptyString('')).toBe(false);
    expect(isNonEmptyString(undefined)).toBe(false);
    expect(isNonEmptyString(null)).toBe(false);
  });
});
