import { describe, expect, test } from 'bun:test';

import fc from 'fast-check';

import type { KeepaliveRecord } from '../../src/models/keepalive.ts';
import { KEEPALIVE_KEY_PREFIX, KeepaliveStore } from '../../src/services/keepalive-store.ts';

const NOW = 1_000_000_000;
const PID = 100;
const owner = { directory: '/repo', isAlive: (pid: number) => pid === PID, pid: PID };

function storage(seed: [string, unknown][] = []) {
  const data = new Map<string, unknown>(seed);
  return {
    data,
    get: async (key: string) => data.get(key),
    remove: async (key: string) => {
      data.delete(key);
    },
    scan: async ({ prefix }: { prefix: string }) => ({
      entries: [...data.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ key, value })),
    }),
    set: async (key: string, value: unknown) => {
      data.set(key, value);
    },
  };
}

const count = fc.nat();
const ttl = fc.constantFrom('5m' as const, '1h' as const, '30m' as const, '12h' as const);
const validRecord: fc.Arbitrary<KeepaliveRecord> = fc.record({
  contextTokens: fc.option(count),
  firstPrimaryContext: fc.option(count),
  lastCache: fc.option(fc.record({ read: count, total: count })),
  lastPing: fc.constantFrom('hit' as const, 'miss' as const, 'failed' as const, null),
  // Inside every TTL, so expiry never drops it.
  lastRequestAt: fc.integer({ max: NOW, min: NOW - 1000 }),
  model: fc.option(fc.record({ id: fc.string(), providerID: fc.string() })),
  originalExpiry: fc.option(count),
  pingsUsed: count,
  prefix1hTokens: fc.option(count),
  requestedTtl: ttl,
  split: fc.boolean(),
  stretchCharged: fc.boolean(),
  stretchHits: count,
  ttl,
  ttlSource: fc.constantFrom('detected' as const, 'requested' as const, null),
});

describe('KeepaliveStore properties', () => {
  test('whatever is in storage, restoring never rejects and hands back only what it validated', async () => {
    await fc.assert(
      fc.asyncProperty(fc.dictionary(fc.string(), fc.jsonValue()), async (stored) => {
        const seed = Object.entries(stored).map(([key, value]): [string, unknown] => [
          `${KEEPALIVE_KEY_PREFIX}${key}`,
          value,
        ]);
        const restored = await new KeepaliveStore(storage(seed), owner).restorable(NOW);

        for (const { record } of restored) {
          expect(typeof record.lastRequestAt).toBe('number');
          expect(typeof record.pingsUsed).toBe('number');
        }
      })
    );
  });

  test('a valid record comes back exactly as it was saved', async () => {
    await fc.assert(
      fc.asyncProperty(validRecord, async (record) => {
        const kv = storage();
        new KeepaliveStore(kv, owner).save('s1', record);
        for (let i = 0; i < 3; i++) await Promise.resolve();

        expect(await new KeepaliveStore(kv, owner).restorable(NOW)).toEqual([
          { record, sessionID: 's1' },
        ]);
      })
    );
  });

  test('corrupting any one field of a stored record never restores the corrupt value', async () => {
    await fc.assert(
      fc.asyncProperty(
        validRecord,
        fc.constantFrom<keyof KeepaliveRecord>(
          'lastRequestAt',
          'pingsUsed',
          'requestedTtl',
          'stretchHits',
          'ttl'
        ),
        async (record, field) => {
          const kv = storage([
            [
              `${KEEPALIVE_KEY_PREFIX}s1`,
              { ...record, [field]: 'corrupt', directory: '/repo', pid: PID, version: 1 },
            ],
          ]);

          expect(await new KeepaliveStore(kv, owner).restorable(NOW)).toEqual([]);
          expect(kv.data.size).toBe(0);
        }
      )
    );
  });
});
