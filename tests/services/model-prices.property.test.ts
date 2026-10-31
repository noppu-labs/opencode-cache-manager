import { describe, expect, test } from 'bun:test';

import fc from 'fast-check';

import { selectTier, toCatalogModels, type CatalogCost } from '../../src/services/model-prices.ts';

const tieredCost: fc.Arbitrary<CatalogCost> = fc.record({
  cache: fc.record({ read: fc.nat(), write: fc.nat() }),
  input: fc.nat(),
  output: fc.nat(),
  tier: fc.record({ size: fc.nat({ max: 1_000_000 }), type: fc.constant('context' as const) }),
});

const anyCost: fc.Arbitrary<CatalogCost> = fc.oneof(
  tieredCost,
  fc.record({
    cache: fc.record({ read: fc.nat(), write: fc.nat() }),
    input: fc.nat(),
    output: fc.nat(),
  })
);

describe('toCatalogModels properties', () => {
  test('never throws and only returns entries with string ids', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (data) => {
        for (const entry of toCatalogModels(data)) {
          expect(typeof entry.id).toBe('string');
          expect(typeof entry.providerID).toBe('string');
        }
      })
    );
  });
});

describe('selectTier properties', () => {
  test('returns a member of its input, or undefined for no input', () => {
    fc.assert(
      fc.property(fc.array(anyCost), fc.nat({ max: 2_000_000 }), (costs, tokens) => {
        const picked = selectTier(costs, tokens);
        if (picked === undefined) {
          expect(costs).toHaveLength(0);
        } else {
          expect(costs).toContain(picked);
        }
      })
    );
  });

  test('the selected tier size never shrinks as the context grows', () => {
    fc.assert(
      fc.property(
        fc.array(tieredCost, { minLength: 1 }),
        fc.nat({ max: 2_000_000 }),
        fc.nat({ max: 2_000_000 }),
        (costs, first, second) => {
          const [low, high] = first <= second ? [first, second] : [second, first];
          const sizeAt = (tokens: number): number => selectTier(costs, tokens)?.tier?.size ?? -1;
          const smallest = Math.min(...costs.map((entry) => entry.tier?.size ?? 0));
          // Below every tier the smallest tier is the fallback, so compare only where some tier fits.
          fc.pre(low >= smallest);
          expect(sizeAt(high)).toBeGreaterThanOrEqual(sizeAt(low));
        }
      )
    );
  });
});
