import { describe, expect, test } from 'bun:test';

import type { RawCacheTtlRpcClient } from '../../src/rpc.ts';
import { withLocation } from '../../src/ui/located-rpc.ts';

function rawClient() {
  const calls: { method: string; input: unknown; options: unknown }[] = [];
  const record =
    (method: string, output: unknown = {}) =>
    async (input: unknown, options?: unknown) => {
      calls.push({ method, input, options });
      return output;
    };
  const events = {
    subscribe: () =>
      (async function* subscribe() {
        // Yields no events.
      })(),
  };
  const rpc = {
    getSettings: record('getSettings', { global: {}, session: null }),
    setGlobal: record('setGlobal'),
    setSession: record('setSession'),
    resetSession: record('resetSession'),
    getKeepalive: record('getKeepalive'),
    events,
  } as unknown as RawCacheTtlRpcClient;
  return { rpc, calls, events };
}

const locations: Record<string, { directory: string }> = { ses_a: { directory: '/work/a' } };
const locate = (sessionID: string | undefined) =>
  (sessionID === undefined ? undefined : locations[sessionID]) ?? { directory: '/work/default' };

describe('withLocation', () => {
  test("session calls target the session's directory", async () => {
    const { rpc, calls } = rawClient();
    const client = withLocation(rpc, locate);
    await client.getKeepalive({ sessionID: 'ses_a' });
    await client.getSettings({ sessionID: 'ses_a' });
    await client.setSession({ sessionID: 'ses_a', patch: { mode: '1h' } });
    await client.resetSession({ sessionID: 'ses_a' });
    expect(calls.map((c) => [c.method, c.options])).toEqual([
      ['getKeepalive', { location: { directory: '/work/a' } }],
      ['getSettings', { location: { directory: '/work/a' } }],
      ['setSession', { location: { directory: '/work/a' } }],
      ['resetSession', { location: { directory: '/work/a' } }],
    ]);
  });

  test('calls without a session use the fallback location', async () => {
    const { rpc, calls } = rawClient();
    const client = withLocation(rpc, locate);
    await client.setGlobal({ patch: { mode: '5m' } });
    await client.getSettings({});
    expect(calls.map((c) => c.options)).toEqual([
      { location: { directory: '/work/default' } },
      { location: { directory: '/work/default' } },
    ]);
  });

  test('passes inputs through unchanged', async () => {
    const { rpc, calls } = rawClient();
    await withLocation(rpc, locate).setSession({ sessionID: 'ses_a', patch: { maxPings: 3 } });
    expect(calls[0].input).toEqual({ sessionID: 'ses_a', patch: { maxPings: 3 } });
  });

  test('omits options when no location is known', async () => {
    const { rpc, calls } = rawClient();
    await withLocation(rpc, () => undefined).getKeepalive({ sessionID: 'ses_x' });
    expect(calls[0].options).toBeUndefined();
  });

  test('keeps the events client', () => {
    const { rpc, events } = rawClient();
    expect(withLocation(rpc, locate).events).toBe(events);
  });
});
