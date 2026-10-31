import { describe, expect, test } from 'bun:test';

import { MODELS_DEV_MAX_AGE_MS, MODELS_DEV_RETRY_MS } from '../../src/constants/savings.ts';
import { ModelsDevPrices, normaliseModelName } from '../../src/services/models-dev.ts';
import { memoryKv } from '../helpers/memory-kv.ts';

const cost = (input: number, extra: Record<string, number> = {}) => ({
  cost: { input, output: input * 5, cache_read: input / 10, cache_write: input * 1.25, ...extra },
});
const BODY = {
  anthropic: { models: { 'claude-sonnet-4-5': cost(3) } },
  openrouter: { models: { 'anthropic/claude-sonnet-4-5': cost(3.1), 'acme/foo': cost(1) } },
  other: { models: { foo: cost(2) } },
};
const c = (input: number) => ({
  cost: { cache_read: input / 10, cache_write: input * 1.25, input, output: input * 5 },
});
const PRUNED = {
  anthropic: { models: { 'claude-sonnet-4-5': c(3) } },
  openrouter: { models: { 'anthropic/claude-sonnet-4-5': c(3.1), 'acme/foo': c(1) } },
  other: { models: { foo: c(2) } },
};
const SONNET = { cacheRead: 0.3, cacheWrite: 3.75, input: 3, output: 15 };

function setup(responses: unknown[] | (() => Promise<unknown>) = [BODY]) {
  const { kv, data } = memoryKv();
  const clock = { t: 1_000_000 };
  const calls: string[] = [];
  const queue = Array.isArray(responses) ? [...responses] : undefined;
  const fetchJson = async (url: string) => {
    calls.push(url);
    if (queue === undefined) {
      return (responses as () => Promise<unknown>)();
    }
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) {
      throw next;
    }
    return next;
  };
  const make = () => new ModelsDevPrices({ fetchJson, kv, now: () => clock.t });
  return { calls, clock, data, kv, make, prices: make() };
}

describe('normaliseModelName', () => {
  test('strips prefix, date suffix and -latest, lowercases', () => {
    expect(normaliseModelName('cc/claude-sonnet-4-5')).toBe('claude-sonnet-4-5');
    expect(normaliseModelName('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5');
    expect(normaliseModelName('gpt-5.6-latest')).toBe('gpt-5.6');
    expect(normaliseModelName('Claude-Sonnet-4-5')).toBe('claude-sonnet-4-5');
  });
});

describe('ModelsDevPrices.match', () => {
  test('prefers the original vendor over resellers', async () => {
    expect(await setup().prices.match(['claude-sonnet-4-5'])).toEqual(SONNET);
  });

  test('matches a dated, prefixed name', async () => {
    expect(await setup().prices.match(['cc/claude-sonnet-4-5-20250929'])).toEqual(SONNET);
  });

  test('same price across non-vendor listings is a match', async () => {
    const body = { a: { models: { m: cost(2) } }, b: { models: { 'x/m': cost(2) } } };
    expect(await setup([body]).prices.match(['m'])).toEqual({
      cacheRead: 0.2,
      cacheWrite: 2.5,
      input: 2,
      output: 10,
    });
  });

  test('differing non-vendor prices are no match; the next name is tried', async () => {
    const { prices } = setup();
    expect(await prices.match(['foo'])).toBeUndefined();
    expect(await prices.match(['foo', 'claude-sonnet-4-5'])).toEqual(SONNET);
  });

  test('unusable bodies give undefined', async () => {
    for (const body of ['<html>', {}, null, { a: { models: { m: {} } } }, { a: 5 }]) {
      expect(await setup([body]).prices.match(['m'])).toBeUndefined();
    }
  });

  test('invalid prices are rejected, missing cache prices become 0', async () => {
    const body = {
      anthropic: {
        models: {
          bad: { cost: { input: 0, output: 1 } },
          neg: { cost: { input: 1, output: -1 } },
          nocache: { cost: { input: 1, output: 5 } },
        },
      },
    };
    const { prices } = setup([body]);
    expect(await prices.match(['bad'])).toBeUndefined();
    expect(await prices.match(['neg'])).toBeUndefined();
    expect(await prices.match(['nocache'])).toEqual({
      cacheRead: 0,
      cacheWrite: 0,
      input: 1,
      output: 5,
    });
  });

  test('fetches once within the max age and persists to kv', async () => {
    const { calls, clock, data, make, prices } = setup();
    await prices.match(['claude-sonnet-4-5']);
    clock.t += MODELS_DEV_MAX_AGE_MS - 1;
    await prices.match(['claude-sonnet-4-5']);
    expect(calls).toEqual(['https://models.dev/api.json']);
    expect(data.get('models-dev')).toEqual({ body: PRUNED, fetchedAt: 1_000_000 });
    const fresh = make();
    expect(await fresh.match(['claude-sonnet-4-5'])).toEqual(SONNET);
    expect(calls).toHaveLength(1);
  });

  test('refetches after the max age; a failed refetch keeps the stale cache', async () => {
    const { calls, clock, prices } = setup([BODY, new Error('down')]);
    await prices.match(['claude-sonnet-4-5']);
    clock.t += MODELS_DEV_MAX_AGE_MS;
    expect(await prices.match(['claude-sonnet-4-5'])).toEqual(SONNET);
    expect(calls).toHaveLength(2);
  });

  test('a corrupt kv value is ignored', async () => {
    const { calls, data, prices } = setup();
    data.set('models-dev', 'garbage');
    expect(await prices.match(['claude-sonnet-4-5'])).toEqual(SONNET);
    expect(calls).toHaveLength(1);
  });

  test('rejected fetch with no cache is undefined and backs off', async () => {
    const { calls, clock, prices } = setup([new Error('down')]);
    expect(await prices.match(['m'])).toBeUndefined();
    expect(await prices.match(['m'])).toBeUndefined();
    expect(calls).toHaveLength(1);
    clock.t += MODELS_DEV_RETRY_MS;
    await prices.match(['m']);
    expect(calls).toHaveLength(2);
  });

  test('concurrent matches share one fetch', async () => {
    const { calls, prices } = setup();
    await Promise.all([prices.match(['a']), prices.match(['b'])]);
    expect(calls).toHaveLength(1);
  });

  test('persists only prices, dropping other fields and models without cost', async () => {
    const body = {
      anthropic: {
        id: 'anthropic',
        models: {
          'claude-sonnet-4-5': { ...cost(3), limit: { context: 1 }, name: 'Sonnet' },
          'nocost': { name: 'x' },
        },
      },
    };
    const { data, prices } = setup([body]);
    await prices.match(['claude-sonnet-4-5']);
    expect(data.get('models-dev')).toEqual({
      body: { anthropic: { models: { 'claude-sonnet-4-5': c(3) } } },
      fetchedAt: 1_000_000,
    });
  });

  test('concurrent first matches with a fresh stored value do not fetch', async () => {
    const { calls, data, prices } = setup();
    data.set('models-dev', { body: BODY, fetchedAt: 1_000_000 });
    const results = await Promise.all([
      prices.match(['claude-sonnet-4-5']),
      prices.match(['claude-sonnet-4-5']),
    ]);
    expect(results).toEqual([SONNET, SONNET]);
    expect(calls).toHaveLength(0);
  });

  test('a stored fetchedAt in the future counts as stale', async () => {
    const { calls, data, prices } = setup();
    data.set('models-dev', { body: BODY, fetchedAt: 9_000_000_000 });
    await prices.match(['claude-sonnet-4-5']);
    expect(calls).toHaveLength(1);
  });

  test('one provider listing a name at two prices is no clear match', async () => {
    const body = {
      anthropic: { models: { 'x-20250101': cost(1), 'x-20250202': cost(2) } },
      a: { models: { 'y': cost(1), 'p/y': cost(2) } },
    };
    const { prices } = setup([body]);
    expect(await prices.match(['x'])).toBeUndefined();
    expect(await prices.match(['y'])).toBeUndefined();
  });
});
