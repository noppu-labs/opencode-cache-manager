import { describe, expect, spyOn, test } from 'bun:test';

import type { ModelPrice } from '../../src/models/savings';
import {
  PriceBook,
  selectTier,
  toCatalogModels,
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

  test('concurrent lookups of one missing model all see the shared reload', async () => {
    let calls = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const book = new PriceBook({
      listModels: async () => {
        calls += 1;
        if (calls === 1) {
          return [];
        }
        await gate;
        return [model('claude-x', [cost(3)])];
      },
    });
    await book.prefetch();
    const first = book.lookup(ref, 1);
    const second = book.lookup(ref, 1);
    release();
    expect((await first)?.input).toBe(3);
    expect((await second)?.input).toBe(3);
    expect(calls).toBe(2);
  });

  test('without a catalog the fallback is not consulted', async () => {
    let asked = 0;
    const book = new PriceBook({
      listModels: () => Promise.reject(new Error('down')),
      fallback: () => {
        asked += 1;
        return Promise.resolve(FALLBACK_PRICE);
      },
    });
    expect(await book.lookup(ref, 1)).toBeUndefined();
    expect(asked).toBe(0);
  });

  test('a failed reload keeps the old catalog', async () => {
    let calls = 0;
    const book = new PriceBook({
      listModels: () => {
        calls += 1;
        return calls === 1
          ? Promise.resolve([model('claude-x', [cost(3)])])
          : Promise.reject(new Error('down'));
      },
    });
    expect((await book.lookup(ref, 1))?.input).toBe(3);
    expect(await book.lookup({ providerID: 'anthropic', id: 'other' }, 1)).toBeUndefined();
    expect((await book.lookup(ref, 1))?.input).toBe(3);
  });

  test('a catalog entry with no cost goes to the fallback', async () => {
    const book = new PriceBook({
      listModels: () => Promise.resolve([model('claude-x', [])]),
      fallback: () => Promise.resolve(FALLBACK_PRICE),
    });
    expect(await book.lookup(ref, 1)).toEqual(FALLBACK_PRICE);
  });

  test('a catalog load that never settles counts as failed after the timeout, and the next lookup retries', async () => {
    let calls = 0;
    const book = new PriceBook({
      listModels: async () => {
        calls += 1;
        return calls === 1 ? new Promise<never>(() => {}) : [model('claude-x', [cost(3)])];
      },
      loadTimeoutMs: 5,
    });
    expect(await book.lookup(ref, 1)).toBeUndefined();
    expect((await book.lookup(ref, 1))?.input).toBe(3);
    expect(calls).toBe(2);
  });

  test('a catalog load that settles in time clears its timeout', async () => {
    const clear = spyOn(globalThis, 'clearTimeout');
    try {
      const book = new PriceBook({
        listModels: async () => [model('claude-x', [cost(3)])],
        loadTimeoutMs: 60_000,
      });
      expect((await book.lookup(ref, 1))?.input).toBe(3);
      expect(clear).toHaveBeenCalled();
    } finally {
      clear.mockRestore();
    }
  });

  test('prefetch never rejects', async () => {
    const book = new PriceBook({ listModels: () => Promise.reject(new Error('down')) });
    await book.prefetch();
  });
});

describe('toCatalogModels', () => {
  const info = (overrides: Record<string, unknown> = {}) => ({
    id: 'claude-x',
    modelID: 'claude-x-20260101',
    providerID: 'anthropic',
    name: 'Claude X',
    enabled: true,
    cost: [cost(3), cost(6, 200_000)],
    ...overrides,
  });

  test('keeps the id, provider ID and cost entries of each model', () => {
    expect(toCatalogModels([info()])).toEqual([
      { id: 'claude-x', providerID: 'anthropic', cost: [cost(3), cost(6, 200_000)] },
    ]);
  });

  test('skips models without a string id, provider ID or a cost array', () => {
    const models = [
      info({ id: 1 }),
      info({ providerID: undefined }),
      info({ cost: 'free' }),
      null,
      'claude-x',
      info({ id: 'claude-y' }),
    ];
    expect(toCatalogModels(models).map((entry) => entry.id)).toEqual(['claude-y']);
  });

  test('drops cost entries that do not have the catalog shape', () => {
    const malformed = [
      { input: '3', output: 15, cache: { read: 0.3, write: 3.75 } },
      { input: 3, output: 15 },
      { input: 3, output: 15, cache: { read: 0.3 } },
      { input: 3, output: 15, cache: { read: 0.3, write: 3.75 }, tier: { type: 'other', size: 1 } },
      { input: 3, output: 15, cache: { read: 0.3, write: 3.75 }, tier: { type: 'context' } },
      7,
    ];
    const [entry] = toCatalogModels([info({ cost: [...malformed, cost(4, 100_000)] })]);
    expect(entry?.cost).toEqual([cost(4, 100_000)]);
  });

  test('a list that is not an array maps to no models', () => {
    expect(toCatalogModels(undefined)).toEqual([]);
    expect(toCatalogModels({ data: [info()] })).toEqual([]);
  });
});
