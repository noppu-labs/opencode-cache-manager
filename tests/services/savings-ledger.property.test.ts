import { describe, expect, test } from 'bun:test';

import fc from 'fast-check';

import type { CacheUsage, Ttl } from '../../src/models/cache.ts';
import type { ModelPrice } from '../../src/models/savings.ts';
import { LedgerStore } from '../../src/services/ledger-store.ts';
import { SavingsLedger } from '../../src/services/savings-ledger.ts';
import { avoidedUnits, avoidedUsd, pingUnits, pingUsd } from '../../src/services/savings-math.ts';
import { cacheUsage, modelPrice, ttl } from '../helpers/arbitraries.ts';
import { memoryKv } from '../helpers/memory-kv.ts';

type Ev = { kind: 'ping'; t: Ttl; usage: CacheUsage } | { kind: 'rescue'; t: Ttl; tokens: number };
const model = { ref: { id: 'm', providerID: 'p' } };
const event = fc.oneof(
  fc.record({ kind: fc.constant('ping' as const), t: ttl, usage: cacheUsage }),
  fc.record({
    kind: fc.constant('rescue' as const),
    t: ttl,
    tokens: fc.integer({ max: 1e6, min: 0 }),
  })
);

const make = (lookup: () => Promise<ModelPrice | undefined>) => {
  const store = new LedgerStore(memoryKv().kv);
  const ledger = new SavingsLedger({ onChange: () => {}, prices: { lookup }, store });
  return { ledger, store };
};
const fire = (ledger: SavingsLedger, e: Ev): Promise<void> =>
  e.kind === 'ping'
    ? ledger.pingCharged('s', model, e.usage, e.t)
    : ledger.stretchRescued('s', model, e.tokens, e.t, e.tokens);

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

  test('a session with any unpriced event never yields a dollar readout', async () => {
    await fc.assert(
      fc.asyncProperty(
        modelPrice,
        fc.array(fc.tuple(event, fc.boolean()), { maxLength: 10 }),
        async (price, steps) => {
          let priced = true;
          const { ledger } = make(async () => (priced ? price : undefined));
          let unpriced = false;
          for (const [e, isPriced] of steps) {
            priced = isPriced;
            unpriced ||= !isPriced;
            await fire(ledger, e);
            const readout = ledger.readout('s');
            if (unpriced) {
              expect(readout).toMatchObject({ netUsd: null, priced: false, stretchUsd: null });
            }
          }
        }
      )
    );
  });

  test('no totals counter ever decreases', async () => {
    await fc.assert(
      fc.asyncProperty(
        modelPrice,
        fc.array(fc.tuple(event, fc.boolean()), { maxLength: 10 }),
        async (price, steps) => {
          let priced = true;
          const { ledger, store } = make(async () => (priced ? price : undefined));
          let previous = await store.load('s');
          for (const [e, isPriced] of steps) {
            priced = isPriced;
            await fire(ledger, e);
            const next = store.peek('s') ?? previous;
            for (const key of Object.keys(next) as (keyof typeof next)[]) {
              expect(next[key]).toBeGreaterThanOrEqual(previous[key]);
            }
            previous = next;
          }
        }
      )
    );
  });

  test('concurrent events give the same totals as sequential ones', async () => {
    await fc.assert(
      fc.asyncProperty(
        modelPrice,
        fc.array(fc.tuple(event, fc.boolean()), { maxLength: 10 }),
        async (price, steps) => {
          const run = async (concurrent: boolean) => {
            let index = 0;
            const flags = steps.map(([, p]) => p);
            // Lookups are consumed in event order because the chain serializes them.
            const { ledger, store } = make(async () => (flags[index++] ? price : undefined));
            const events = steps.map(([e]) => e);
            if (concurrent) await Promise.all(events.map((e) => fire(ledger, e)));
            else for (const e of events) await fire(ledger, e);
            return store.load('s');
          };
          expect(await run(true)).toEqual(await run(false));
        }
      )
    );
  });
});
