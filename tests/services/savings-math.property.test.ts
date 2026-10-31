import { describe, expect, test } from 'bun:test';

import fc from 'fast-check';

import {
  avoidedUnits,
  avoidedUsd,
  pingUnits,
  pingUsd,
  readPrice,
  toReadout,
  writePrice,
} from '../../src/services/savings-math.ts';
import { cacheUsage, ledgerTotals, modelPrice, ttl } from '../helpers/arbitraries.ts';

const tokens = fc.integer({ max: 1e9, min: 0 });

function expectNonNegativeFinite(value: number): void {
  expect(Number.isFinite(value)).toBe(true);
  expect(value).toBeGreaterThanOrEqual(0);
}

describe('savings math properties', () => {
  test('every pricing function returns a finite number >= 0', () => {
    fc.assert(
      fc.property(cacheUsage, ttl, modelPrice, tokens, (usage, t, price, count) => {
        expectNonNegativeFinite(pingUnits(usage, t));
        expectNonNegativeFinite(pingUsd(usage, t, price));
        expectNonNegativeFinite(avoidedUnits(count, t));
        expectNonNegativeFinite(avoidedUsd(count, t, price));
        expectNonNegativeFinite(writePrice(price, t));
        expectNonNegativeFinite(readPrice(price));
      })
    );
  });

  test('priced readout nets avoided against ping cost', () => {
    fc.assert(
      fc.property(ledgerTotals, (totals) => {
        const clean = { ...totals, pings: Math.max(1, totals.pings), unpricedEvents: 0 };
        expect(toReadout(clean, null).netUsd).toBe(clean.avoidedUsd - clean.pingUsd);
      })
    );
  });

  test('any unpriced event hides the dollar figures', () => {
    fc.assert(
      fc.property(ledgerTotals, fc.integer({ max: 5, min: 1 }), (totals, unpriced) => {
        const readout = toReadout({ ...totals, unpricedEvents: unpriced }, 1);
        expect(readout.netUsd).toBeNull();
        expect(readout.stretchUsd).toBeNull();
      })
    );
  });

  test('return ratio is null or finite and non-negative', () => {
    fc.assert(
      fc.property(ledgerTotals, (totals) => {
        const ratio = toReadout(totals, null).returnRatio;
        if (ratio !== null) {
          expectNonNegativeFinite(ratio);
        }
      })
    );
  });
});
