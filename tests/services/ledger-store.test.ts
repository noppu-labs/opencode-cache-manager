import { describe, expect, test } from 'bun:test';

import { EMPTY_TOTALS } from '../../src/constants/savings.ts';
import type { LedgerTotals } from '../../src/models/savings.ts';
import { LEDGER_KEY_PREFIX, LedgerStore } from '../../src/services/ledger-store.ts';
import { memoryKv } from '../helpers/memory-kv.ts';

const addPing = (totals: LedgerTotals): LedgerTotals => ({ ...totals, pings: totals.pings + 1 });

describe('LedgerStore', () => {
  test('peek is undefined before load', () => {
    const { kv } = memoryKv();
    expect(new LedgerStore(kv).peek('ses_a')).toBeUndefined();
  });

  test('a missing entry loads as empty totals', async () => {
    const { kv } = memoryKv();
    const store = new LedgerStore(kv);
    expect(await store.load('ses_a')).toEqual(EMPTY_TOTALS);
    expect(store.peek('ses_a')).toEqual(EMPTY_TOTALS);
  });

  test('update persists so a fresh store loads the same totals', async () => {
    const { kv, data } = memoryKv();
    await new LedgerStore(kv).update('ses_a', addPing);
    expect(data.has(`${LEDGER_KEY_PREFIX}ses_a`)).toBe(true);
    expect(await new LedgerStore(kv).load('ses_a')).toEqual({ ...EMPTY_TOTALS, pings: 1 });
  });

  test('update on an unloaded session builds on the stored totals', async () => {
    const { kv, data } = memoryKv();
    data.set('ledger/ses_a', { ...EMPTY_TOTALS, pings: 4 });
    const totals = await new LedgerStore(kv).update('ses_a', addPing);
    expect(totals.pings).toBe(5);
  });

  test('update never mutates the previous totals', async () => {
    const { kv } = memoryKv();
    const store = new LedgerStore(kv);
    await store.update('ses_a', addPing);
    expect(EMPTY_TOTALS.pings).toBe(0);
  });

  test.each([
    ['a string', 'junk'],
    ['a wrong-typed field', { ...EMPTY_TOTALS, pings: 'x' }],
    ['a NaN field', { ...EMPTY_TOTALS, pings: Number.NaN }],
    ['an infinite field', { ...EMPTY_TOTALS, avoidedUsd: Number.POSITIVE_INFINITY }],
    ['a negative field', { ...EMPTY_TOTALS, rescues: -1 }],
    ['a missing field', { version: 1, pings: 2 }],
    ['another version', { ...EMPTY_TOTALS, version: 2 }],
  ])('%s loads as empty totals', async (_name, stored) => {
    const { kv, data } = memoryKv();
    data.set('ledger/ses_a', stored);
    expect(await new LedgerStore(kv).load('ses_a')).toEqual(EMPTY_TOTALS);
  });

  test('extra unknown fields are ignored', async () => {
    const { kv, data } = memoryKv();
    data.set('ledger/ses_a', { ...EMPTY_TOTALS, pings: 3, extra: true });
    expect(await new LedgerStore(kv).load('ses_a')).toEqual({ ...EMPTY_TOTALS, pings: 3 });
  });

  test('a rejecting get loads as empty totals', async () => {
    const { kv } = memoryKv();
    kv.get = async () => {
      throw new Error('read failed');
    };
    expect(await new LedgerStore(kv).load('ses_a')).toEqual(EMPTY_TOTALS);
  });

  test('concurrent loads share one read', async () => {
    const { kv } = memoryKv();
    let reads = 0;
    const original = kv.get;
    kv.get = async (key) => {
      reads += 1;
      return original(key);
    };
    const store = new LedgerStore(kv);
    await Promise.all([store.load('ses_a'), store.load('ses_a')]);
    expect(reads).toBe(1);
  });

  test('update keeps the totals in memory when persisting fails', async () => {
    const { kv } = memoryKv();
    kv.set = async () => {
      throw new Error('disk full');
    };
    const store = new LedgerStore(kv);
    const totals = await store.update('ses_a', addPing);
    expect(totals.pings).toBe(1);
    expect(store.peek('ses_a')?.pings).toBe(1);
  });

  test('a throwing change resolves with the unchanged totals and later updates still apply', async () => {
    const { kv } = memoryKv();
    const store = new LedgerStore(kv);
    await store.update('ses_a', addPing);
    const failed = await store.update('ses_a', () => {
      throw new Error('bad change');
    });
    expect(failed).toEqual({ ...EMPTY_TOTALS, pings: 1 });
    expect(await store.update('ses_a', addPing)).toEqual({ ...EMPTY_TOTALS, pings: 2 });
  });

  test('concurrent updates on a fresh session both apply', async () => {
    const { kv, data } = memoryKv();
    const store = new LedgerStore(kv);
    await Promise.all([store.update('ses_a', addPing), store.update('ses_a', addPing)]);
    expect(store.peek('ses_a')?.pings).toBe(2);
    expect((data.get('ledger/ses_a') as LedgerTotals).pings).toBe(2);
  });

  test('sessions are independent', async () => {
    const { kv } = memoryKv();
    const store = new LedgerStore(kv);
    await store.update('ses_a', addPing);
    expect((await store.load('ses_b')).pings).toBe(0);
  });
});
