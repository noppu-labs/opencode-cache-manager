import { describe, expect, test } from 'bun:test';

import { EMPTY_TOTALS } from '../../src/constants/savings.ts';
import type { CacheUsage } from '../../src/models/cache.ts';
import type { LedgerTotals, ModelPrice } from '../../src/models/savings.ts';
import {
  avoidedUnits,
  avoidedUsd,
  pingUnits,
  pingUsd,
  readPrice,
  toReadout,
  writePrice,
} from '../../src/services/savings-math.ts';

const usage: CacheUsage = {
  cacheReadTokens: 80_000,
  cacheWriteTokens: 0,
  inputTokens: 100,
  outputTokens: 2,
  write1hTokens: undefined,
  write5mTokens: undefined,
};
const price: ModelPrice = { cacheRead: 0.3, cacheWrite: 3.75, input: 3, output: 15 };

describe('pingUnits / pingUsd', () => {
  test('units weigh read at 0.1 and output at 5', () => {
    expect(pingUnits(usage, '5m')).toBeCloseTo(8110);
  });

  test('usd prices each token kind', () => {
    expect(pingUsd(usage, '5m', price)).toBeCloseTo(0.02433);
  });

  test('cache writes count at the write multiplier and write price', () => {
    const written = { ...usage, cacheWriteTokens: 1000 };
    expect(pingUnits(written, '1h')).toBeCloseTo(8110 + 2000);
    expect(pingUsd(written, '5m', price)).toBeCloseTo(0.02433 + (1000 * 3.75) / 1e6);
    expect(pingUsd(written, '1h', price)).toBeCloseTo(0.02433 + (1000 * 6) / 1e6);
  });
});

describe('writePrice / readPrice', () => {
  test('catalog write price applies to default TTLs only', () => {
    expect(writePrice(price, '5m')).toBe(3.75);
    expect(writePrice(price, '30m')).toBe(3.75);
    expect(writePrice(price, '1h')).toBe(6);
    expect(writePrice(price, '12h')).toBe(7.5);
  });

  test('falls back to input times multiplier when the catalog has no write price', () => {
    expect(writePrice({ ...price, cacheWrite: 0 }, '5m')).toBeCloseTo(3.75);
  });

  test('read price falls back to a tenth of input', () => {
    expect(readPrice(price)).toBe(0.3);
    expect(readPrice({ ...price, cacheRead: 0 })).toBeCloseTo(0.3);
  });
});

describe('avoidedUnits / avoidedUsd', () => {
  test('units', () => {
    expect(avoidedUnits(100_000, '5m')).toBeCloseTo(115_000);
  });

  test('usd', () => {
    expect(avoidedUsd(100_000, '1h', price)).toBeCloseTo(0.57);
  });

  test('never negative when the write price is below the read price', () => {
    expect(avoidedUsd(100_000, '5m', { ...price, cacheRead: 5, cacheWrite: 1 })).toBe(0);
  });
});

describe('toReadout', () => {
  const priced: LedgerTotals = {
    ...EMPTY_TOTALS,
    avoidedTokens: 1000,
    avoidedUnits: 400,
    avoidedUsd: 0.5,
    pingUnits: 100,
    pingUsd: 0.1,
    pings: 4,
    rescues: 2,
  };

  test('priced readout uses dollars', () => {
    const readout = toReadout(priced, 0.02);
    expect(readout.priced).toBe(true);
    expect(readout.netUsd).toBeCloseTo(0.4);
    expect(readout.returnRatio).toBeCloseTo(5);
    expect(readout.stretchUsd).toBe(0.02);
    expect(readout.avoidedTokens).toBe(1000);
  });

  test('an unpriced event switches to units and hides money', () => {
    const readout = toReadout({ ...priced, unpricedEvents: 1 }, 0.02);
    expect(readout.priced).toBe(false);
    expect(readout.netUsd).toBeNull();
    expect(readout.stretchUsd).toBeNull();
    expect(readout.returnRatio).toBeCloseTo(4);
  });

  test('no rescues or no spend gives a null ratio', () => {
    expect(toReadout({ ...priced, rescues: 0 }, null).returnRatio).toBeNull();
    expect(toReadout({ ...priced, pingUnits: 0, unpricedEvents: 1 }, null).returnRatio).toBeNull();
    expect(toReadout({ ...priced, pingUsd: 0 }, null).returnRatio).toBeNull();
  });

  test('empty totals are unpriced with nothing to show', () => {
    const readout = toReadout(EMPTY_TOTALS, null);
    expect(readout).toMatchObject({ netUsd: null, priced: false, returnRatio: null });
  });

  test('EMPTY_TOTALS is frozen', () => {
    expect(Object.isFrozen(EMPTY_TOTALS)).toBe(true);
  });
});
