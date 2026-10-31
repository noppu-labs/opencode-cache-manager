import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';

import { fetchJson } from '../../src/utils/fetch-json.ts';

describe('fetchJson', () => {
  let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>;

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  test('resolves with the parsed body', async () => {
    fetchSpy.mockResolvedValue(Response.json({ a: 1 }));
    expect(await fetchJson('https://example.test/api.json', 1000)).toEqual({ a: 1 });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://example.test/api.json');
  });

  test('aborts the request once the timeout passes', async () => {
    fetchSpy.mockResolvedValue(Response.json({}));
    await fetchJson('https://example.test/api.json', 5);
    const signal = fetchSpy.mock.calls[0]?.[1]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
    await Bun.sleep(20);
    expect(signal?.aborted).toBe(true);
  });

  test('rejects on a non-2xx status', async () => {
    fetchSpy.mockResolvedValue(Response.json({ error: 'down' }, { status: 503 }));
    await expect(fetchJson('https://example.test/api.json', 1000)).rejects.toThrow('503');
  });
});
