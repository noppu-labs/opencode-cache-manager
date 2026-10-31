import { describe, expect, test } from 'bun:test';

import type { ModelPrice } from '../../src/models/savings';
import {
  PriceBook,
  selectTier,
  type CatalogCost,
  type CatalogModel,
} from '../../src/services/model-prices';

const cost = (input: number, size?: number, output = input * 5): CatalogCost => ({
  ...(size === undefined ? {} : { tier: { type: 'context' as const, size } }),
  input,
  output,
  cache: { read: input / 10, write: input * 1.25 },
});

const model = (id: string, costs: CatalogCost[], providerID = 'anthropic'): CatalogModel => ({
  id,
  providerID,
  cost: costs,
});

const ref = { providerID: 'anthropic', id: 'claude-x' };
const FALLBACK_PRICE: ModelPrice = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 };

describe('selectTier', () => {
  const tiers = [cost(3), cost(6, 200_000)];

  test('picks the largest tier at or below the context size', () => {
    expect(selectTier(tiers, 250_000)?.input).toBe(6);
    expect(selectTier(tiers, 200_000)?.input).toBe(6);
  });

  test('picks the untiered entry below every tier', () => {
    expect(selectTier(tiers, 150_000)?.input).toBe(3);
  });

  test('picks the smallest tier when only tiered entries exist and none fit', () => {
    const only = [cost(9, 1_000_000), cost(6, 200_000)];
    expect(selectTier(only, 100_000)?.input).toBe(6);
  });

  test('returns undefined for no entries', () => {
    expect(selectTier([], 1)).toBeUndefined();
  });
});

describe('PriceBook.lookup', () => {
  test('maps the catalog entry matching provider and id', async () => {
    const book = new PriceBook({
      listModels: () =>
        Promise.resolve([
          model('claude-x', [cost(3, undefined, 15)], 'other'),
          model('claude-x', [cost(3, undefined, 15)]),
        ]),
    });
    expect(await book.lookup(ref, 1000)).toEqual({
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75,
    });
  });

  test('uses the tier for the context size', async () => {
    const book = new PriceBook({
      listModels: () => Promise.resolve([model('claude-x', [cost(3), cost(6, 200_000)])]),
    });
    expect((await book.lookup(ref, 300_000))?.input).toBe(6);
    expect((await book.lookup(ref, 100))?.input).toBe(3);
  });

  test('a zero input price falls to the fallback, or undefined without one', async () => {
    const listModels = () => Promise.resolve([model('claude-x', [cost(0)])]);
    expect(await new PriceBook({ listModels }).lookup(ref, 1)).toBeUndefined();
    const calls: (readonly string[])[] = [];
    const book = new PriceBook({
      listModels,
      fallback: (names) => {
        calls.push(names);
        return Promise.resolve(FALLBACK_PRICE);
      },
    });
    expect(await book.lookup(ref, 1)).toEqual(FALLBACK_PRICE);
    expect(calls).toEqual([['claude-x']]);
  });

  test('a non-finite or negative price field makes the entry unusable', async () => {
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      const entry: CatalogCost = { input: 3, output: 15, cache: { read: bad, write: 1 } };
      const book = new PriceBook({
        listModels: () => Promise.resolve([model('claude-x', [entry])]),
      });
      expect(await book.lookup(ref, 1)).toBeUndefined();
    }
  });

  test('a missing model asks the fallback with the reported model first', async () => {
    const calls: (readonly string[])[] = [];
    const book = new PriceBook({
      listModels: () => Promise.resolve([]),
      fallback: (names) => {
        calls.push(names);
        return Promise.resolve(FALLBACK_PRICE);
      },
    });
    expect(await book.lookup(ref, 1, 'claude-x-20260101')).toEqual(FALLBACK_PRICE);
    await book.lookup(ref, 1, 'claude-x');
    await book.lookup(ref, 1, '');
    expect(calls).toEqual([['claude-x-20260101', 'claude-x'], ['claude-x'], ['claude-x']]);
  });

  test('a throwing fallback resolves undefined', async () => {
    const book = new PriceBook({
      listModels: () => Promise.resolve([]),
      fallback: () => Promise.reject(new Error('offline')),
    });
    expect(await book.lookup(ref, 1)).toBeUndefined();
  });

  test('a throwing listModels resolves undefined and is retried later', async () => {
    let calls = 0;
    const book = new PriceBook({
      listModels: () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new Error('down'))
          : Promise.resolve([model('claude-x', [cost(3)])]);
      },
    });
    expect(await book.lookup(ref, 1)).toBeUndefined();
    expect((await book.lookup(ref, 1))?.input).toBe(3);
    expect(calls).toBe(2);
  });

  test('caches the catalog, and reloads once for a model it does not list', async () => {
    let calls = 0;
    let models = [model('claude-x', [cost(3)])];
    const book = new PriceBook({
      listModels: () => {
        calls += 1;
        return Promise.resolve(models);
      },
    });
    await book.lookup(ref, 1);
    await book.lookup(ref, 1);
    await book.lookup(ref, 1);
    expect(calls).toBe(1);

    const fresh = { providerID: 'anthropic', id: 'claude-new' };
    expect(await book.lookup(fresh, 1)).toBeUndefined();
    expect(calls).toBe(2);
    expect(await book.lookup(fresh, 1)).toBeUndefined();
    expect(calls).toBe(2);

    models = [...models, model('claude-new', [cost(7)])];
    expect(await book.lookup({ providerID: 'anthropic', id: 'claude-newer' }, 1)).toBeUndefined();
    expect(calls).toBe(3);
    expect((await book.lookup(fresh, 1))?.input).toBe(7);
  });

  test('concurrent lookups share one listModels call', async () => {
    let calls = 0;
    const book = new PriceBook({
      listModels: async () => {
        calls += 1;
        await Promise.resolve();
        return [model('claude-x', [cost(3)])];
      },
    });
    const prices = await Promise.all([book.lookup(ref, 1), book.lookup(ref, 1), book.prefetch()]);
    expect(prices[0]?.input).toBe(3);
    expect(calls).toBe(1);
  });

  test('prefetch never rejects', async () => {
    const book = new PriceBook({ listModels: () => Promise.reject(new Error('down')) });
    await book.prefetch();
  });
});
