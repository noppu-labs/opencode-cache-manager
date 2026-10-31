import { describe, expect, test } from 'bun:test';

import fc from 'fast-check';

import { LedgerStore } from '../../src/services/ledger-store.ts';
import { SavingsLedger } from '../../src/services/savings-ledger.ts';
import { avoidedUnits, avoidedUsd, pingUnits, pingUsd } from '../../src/services/savings-math.ts';
import { cacheUsage, modelPrice, ttl } from '../helpers/arbitraries.ts';
import { memoryKv } from '../helpers/memory-kv.ts';

const model = { ref: { id: 'm', providerID: 'p' } };
const event = fc.oneof(
  fc.record({ kind: fc.constant('ping' as const), t: ttl, usage: cacheUsage }),
  fc.record({
    kind: fc.constant('rescue' as const),
    t: ttl,
    tokens: fc.integer({ max: 1e6, min: 0 }),
  })
);

describe('SavingsLedger properties', () => {
  test('totals equal the savings-math sums over the same events', async () => {
    await fc.assert(
      fc.asyncProperty(modelPrice, fc.array(event, { maxLength: 12 }), async (price, events) => {
        const store = new LedgerStore(memoryKv().kv);
        const ledger = new SavingsLedger({
          onChange: () => {},
          prices: { lookup: async () => price },
          store,
        });
        for (const e of events) {
          await (e.kind === 'ping'
            ? ledger.pingCharged('s', model, e.usage, e.t)
            : ledger.stretchRescued('s', model, e.tokens, e.t, e.tokens));
        }
        const pings = events.flatMap((e) => (e.kind === 'ping' ? [e] : []));
        const rescues = events.flatMap((e) => (e.kind === 'rescue' ? [e] : []));
        const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
        const totals = await store.load('s');
        expect(totals.pings).toBe(pings.length);
        expect(totals.rescues).toBe(rescues.length);
        expect(totals.pingUnits).toBeCloseTo(sum(pings.map((e) => pingUnits(e.usage, e.t))), 3);
        expect(totals.pingUsd).toBeCloseTo(sum(pings.map((e) => pingUsd(e.usage, e.t, price))), 3);
        expect(totals.avoidedUnits).toBeCloseTo(
          sum(rescues.map((e) => avoidedUnits(e.tokens, e.t))),
          3
        );
        expect(totals.avoidedUsd).toBeCloseTo(
          sum(rescues.map((e) => avoidedUsd(e.tokens, e.t, price))),
          3
        );
        expect(totals.avoidedTokens).toBe(sum(rescues.map((e) => e.tokens)));
        const readout = ledger.readout('s');
        if (readout?.netUsd !== null && readout !== null) {
          expect(readout.netUsd).toBeCloseTo(totals.avoidedUsd - totals.pingUsd, 6);
        }
      })
    );
  });
});
