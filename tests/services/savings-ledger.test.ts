import { describe, expect, test } from 'bun:test';

import type { CacheUsage } from '../../src/models/cache.ts';
import type { ModelPrice } from '../../src/models/savings.ts';
import { LedgerStore } from '../../src/services/ledger-store.ts';
import { SavingsLedger } from '../../src/services/savings-ledger.ts';
import { avoidedUsd, pingUsd } from '../../src/services/savings-math.ts';
import { memoryKv } from '../helpers/memory-kv.ts';

const usage: CacheUsage = {
  cacheReadTokens: 20_000,
  cacheWriteTokens: 0,
  inputTokens: 100,
  outputTokens: 5,
  write1hTokens: undefined,
  write5mTokens: undefined,
};
const price: ModelPrice = { cacheRead: 0.3, cacheWrite: 3.75, input: 3, output: 15 };
const model = { ref: { id: 'claude-sonnet-4-5', providerID: 'anthropic' } };

function setup(lookup?: (tokens: number) => Promise<ModelPrice | undefined>) {
  const store = new LedgerStore(memoryKv().kv);
  const lookups: number[] = [];
  const changes: string[] = [];
  const ledger = new SavingsLedger({
    onChange: (id) => changes.push(id),
    prices: {
      lookup: async (_ref, tokens) => {
        lookups.push(tokens);
        return lookup === undefined ? price : lookup(tokens);
      },
    },
    store,
  });
  return { changes, ledger, lookups, store };
}

describe('SavingsLedger', () => {
  test('a priced ping adds totals and the stretch cost', async () => {
    const { changes, ledger, lookups, store } = setup();
    await store.load('s');
    await ledger.pingCharged('s', model, usage, '5m');
    const totals = store.peek('s');
    expect(totals?.pings).toBe(1);
    expect(totals?.pingUsd).toBeCloseTo(pingUsd(usage, '5m', price));
    expect(totals?.pingUnits).toBeGreaterThan(0);
    expect(ledger.readout('s')?.stretchUsd).toBeCloseTo(pingUsd(usage, '5m', price));
    expect(lookups).toEqual([20_100]);
    expect(changes).toContain('s');
  });

  test('an unpriced ping counts as unpriced with no dollars', async () => {
    const { ledger, store } = setup(async () => undefined);
    await store.load('s');
    await ledger.pingCharged('s', model, usage, '5m');
    expect(store.peek('s')?.unpricedEvents).toBe(1);
    expect(store.peek('s')?.pingUsd).toBe(0);
    expect(ledger.readout('s')).toMatchObject({ priced: false, stretchUsd: null });
  });

  test('stretchStarted resets the stretch cost and keeps totals', async () => {
    const { ledger, store } = setup();
    await store.load('s');
    await ledger.pingCharged('s', model, usage, '5m');
    ledger.stretchStarted('s');
    await ledger.pingCharged('s', model, usage, '5m').then(() => undefined);
    expect(ledger.readout('s')?.pings).toBe(2);
    ledger.stretchStarted('s');
    await Bun.sleep(0);
    expect(ledger.readout('s')).toMatchObject({ pings: 2, stretchUsd: null });
  });

  test('a ping still pricing when the stretch starts counts toward the old stretch', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { ledger, store } = setup(async () => {
      await gate;
      return price;
    });
    await store.load('s');
    const ping = ledger.pingCharged('s', model, usage, '5m');
    ledger.stretchStarted('s');
    release();
    await ping;
    await Bun.sleep(0);
    expect(ledger.readout('s')?.stretchUsd).toBeNull();
    expect(store.peek('s')?.pings).toBe(1);
  });

  test('a rescue adds avoided totals priced at its own context size', async () => {
    const { ledger, lookups, store } = setup();
    await store.load('s');
    await ledger.stretchRescued('s', model, 50_000, '1h', 60_000);
    const totals = store.peek('s');
    expect(totals).toMatchObject({ avoidedTokens: 50_000, rescues: 1, unpricedEvents: 0 });
    expect(totals?.avoidedUsd).toBeCloseTo(avoidedUsd(50_000, '1h', price));
    expect(totals?.avoidedUnits).toBeGreaterThan(0);
    expect(lookups).toEqual([60_000]);
  });

  test('one unpriced event keeps the session unpriced', async () => {
    let calls = 0;
    const { ledger, store } = setup(async () => (calls++ === 0 ? undefined : price));
    await store.load('s');
    await ledger.pingCharged('s', model, usage, '5m');
    await ledger.pingCharged('s', model, usage, '5m');
    expect(ledger.readout('s')?.priced).toBe(false);
  });

  test('readout on an unloaded session is null, then onChange fires once the load settles', async () => {
    const { changes, ledger } = setup();
    expect(ledger.readout('s')).toBeNull();
    expect(ledger.readout('s')).toBeNull();
    await Bun.sleep(5);
    expect(changes).toEqual(['s']);
    expect(ledger.readout('s')).not.toBeNull();
  });
});
