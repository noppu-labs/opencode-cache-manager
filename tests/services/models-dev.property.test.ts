import { describe, expect, test } from 'bun:test';

import fc from 'fast-check';

import { normaliseModelName } from '../../src/services/models-dev.ts';

describe('normaliseModelName properties', () => {
  test('never throws and returns lowercase', () => {
    fc.assert(
      fc.property(fc.string(), (name) => {
        const result = normaliseModelName(name);
        expect(result).toBe(result.toLowerCase());
      })
    );
  });

  test('strips a -latest or -YYYYMMDD suffix from a plain name', () => {
    const base = fc.stringMatching(/^[a-z][a-z0-9.]{0,12}$/u);
    const suffix = fc.oneof(
      fc.constant('-latest'),
      fc.integer({ min: 10_000_000, max: 99_999_999 }).map((date) => `-${date}`)
    );
    fc.assert(
      fc.property(base, suffix, (name, tail) => {
        expect(normaliseModelName(`${name}${tail}`)).toBe(name);
      })
    );
  });
});
