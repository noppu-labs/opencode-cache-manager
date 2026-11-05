import { describe, expect, test } from 'bun:test';

import { TTL_MS } from '../../src/constants/keepalive.ts';
import type { KeepaliveRecord } from '../../src/models/keepalive.ts';
import {
  KEEPALIVE_KEY_PREFIX,
  KeepaliveStore,
  type KeepaliveOwner,
} from '../../src/services/keepalive-store.ts';

const NOW = 1_000_000_000;

const record: KeepaliveRecord = {
  contextTokens: 80_000,
  firstPrimaryContext: null,
  lastCache: { read: 79_000, total: 80_000 },
  lastPing: 'hit',
  lastRequestAt: NOW - 60_000,
  model: { id: 'claude-sonnet-5-5', providerID: 'anthropic' },
  originalExpiry: NOW + 100_000,
  pingsUsed: 2,
  prefix1hTokens: null,
  requestedTtl: '5m',
  split: false,
  stretchCharged: true,
  stretchHits: 2,
  ttl: '5m',
  ttlSource: 'detected',
};

function storage(pageSize = 100) {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async (key: string) => data.get(key),
    remove: async (key: string) => {
      data.delete(key);
    },
    scan: async ({ prefix, after }: { prefix: string; after?: string }) => {
      const keys = [...data.keys()].filter((key) => key.startsWith(prefix)).toSorted();
      const start = after === undefined ? 0 : keys.indexOf(after) + 1;
      const page = keys.slice(start, start + pageSize);
      const next = start + pageSize < keys.length ? page.at(-1) : undefined;
      return {
        entries: page.map((key) => ({ key, value: data.get(key) })),
        ...(next === undefined ? {} : { next }),
      };
    },
    set: async (key: string, value: unknown) => {
      data.set(key, value);
    },
  };
}

const MY_PID = 100;
const OTHER_PID = 200;

/** This process, in `directory`, with the given other processes still running. */
const owner = (directory = '/repo', pid = MY_PID, alive: number[] = [MY_PID]): KeepaliveOwner => ({
  directory,
  isAlive: (candidate) => alive.includes(candidate),
  pid,
});

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('KeepaliveStore', () => {
  test('a saved record comes back for the directory that saved it', async () => {
    const kv = storage();
    new KeepaliveStore(kv, owner()).save('s1', record);
    await settle();

    const restored = await new KeepaliveStore(kv, owner()).restorable(NOW);

    expect(restored).toEqual([{ record, sessionID: 's1' }]);
  });

  test('another directory does not restore it, and leaves it stored', async () => {
    const kv = storage();
    new KeepaliveStore(kv, owner()).save('s1', record);
    await settle();

    expect(await new KeepaliveStore(kv, owner('/other')).restorable(NOW)).toEqual([]);
    expect(kv.data.has(`${KEEPALIVE_KEY_PREFIX}s1`)).toBe(true);
  });

  test('a reload in the same process resumes it', async () => {
    const kv = storage();
    new KeepaliveStore(kv, owner()).save('s1', record);
    await settle();

    expect(await new KeepaliveStore(kv, owner()).restorable(NOW)).toHaveLength(1);
  });

  test('another running process in the same directory leaves it alone', async () => {
    const kv = storage();
    new KeepaliveStore(kv, owner('/repo', OTHER_PID)).save('s1', record);
    await settle();

    const mine = new KeepaliveStore(kv, owner('/repo', MY_PID, [MY_PID, OTHER_PID]));

    expect(await mine.restorable(NOW)).toEqual([]);
    expect(kv.data.get(`${KEEPALIVE_KEY_PREFIX}s1`)).toMatchObject({ pid: OTHER_PID });
  });

  test('a process that has gone is succeeded by this one, which claims the record', async () => {
    const kv = storage();
    new KeepaliveStore(kv, owner('/repo', OTHER_PID)).save('s1', record);
    await settle();

    const restored = await new KeepaliveStore(kv, owner('/repo', MY_PID, [MY_PID])).restorable(NOW);

    expect(restored).toEqual([{ record, sessionID: 's1' }]);
    expect(kv.data.get(`${KEEPALIVE_KEY_PREFIX}s1`)).toMatchObject({ pid: MY_PID });
  });

  test('a claimed record is not claimed a second time by the process after it', async () => {
    const kv = storage();
    new KeepaliveStore(kv, owner('/repo', OTHER_PID)).save('s1', record);
    await settle();

    await new KeepaliveStore(kv, owner('/repo', MY_PID, [MY_PID])).restorable(NOW);
    const third = new KeepaliveStore(kv, owner('/repo', 300, [MY_PID, 300]));

    expect(await third.restorable(NOW)).toEqual([]);
  });

  test('a gone process in another directory stays stored for its own directory', async () => {
    const kv = storage();
    new KeepaliveStore(kv, owner('/repo', OTHER_PID)).save('s1', record);
    await settle();

    expect(await new KeepaliveStore(kv, owner('/other', MY_PID, [MY_PID])).restorable(NOW)).toEqual(
      []
    );
    expect(kv.data.get(`${KEEPALIVE_KEY_PREFIX}s1`)).toMatchObject({ pid: OTHER_PID });
  });

  test('a record whose cache has expired is dropped, whichever directory owns it', async () => {
    const kv = storage();
    const store = new KeepaliveStore(kv, owner());
    store.save('s1', { ...record, lastRequestAt: NOW - TTL_MS['5m'] });
    await settle();

    expect(await new KeepaliveStore(kv, owner('/other')).restorable(NOW)).toEqual([]);
    expect(kv.data.size).toBe(0);
  });

  test('a record still inside its TTL is kept', async () => {
    const kv = storage();
    new KeepaliveStore(kv, owner()).save('s1', {
      ...record,
      lastRequestAt: NOW - TTL_MS['5m'] + 1,
    });
    await settle();

    expect(await new KeepaliveStore(kv, owner()).restorable(NOW)).toHaveLength(1);
  });

  test.each([
    ['not an object', 'garbage'],
    ['an unknown version', { version: 99 }],
    ['a missing field', { directory: '/repo', pid: MY_PID, version: 1 }],
    ['a missing owner', { ...record, directory: '/repo', version: 1 }],
    [
      'a TTL naming an inherited property',
      { ...record, directory: '/repo', pid: MY_PID, ttl: 'constructor', version: 1 },
    ],
    ['an unknown TTL', { ...record, directory: '/repo', pid: MY_PID, ttl: '9h', version: 1 }],
    [
      'a non-numeric request time',
      { ...record, directory: '/repo', pid: MY_PID, lastRequestAt: 'x', version: 1 },
    ],
  ])('%s is dropped rather than restored', async (_name, stored) => {
    const kv = storage();
    kv.data.set(`${KEEPALIVE_KEY_PREFIX}s1`, stored);

    expect(await new KeepaliveStore(kv, owner()).restorable(NOW)).toEqual([]);
    expect(kv.data.size).toBe(0);
  });

  test('reads every page of a long scan', async () => {
    const kv = storage(2);
    const store = new KeepaliveStore(kv, owner());
    for (const id of ['a', 'b', 'c', 'd', 'e']) store.save(id, record);
    await settle();

    const restored = await new KeepaliveStore(kv, owner()).restorable(NOW);

    expect(restored.map((entry) => entry.sessionID)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  test('a storage failure restores nothing and does not reject', async () => {
    const kv = storage();
    kv.scan = async () => {
      throw new Error('storage down');
    };

    expect(await new KeepaliveStore(kv, owner()).restorable(NOW)).toEqual([]);
  });

  test('a save then a remove leaves nothing, even when the save is the slower write', async () => {
    const kv = storage();
    const { set } = kv;
    kv.set = async (key, value) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      await set(key, value);
    };
    const store = new KeepaliveStore(kv, owner());

    store.save('s1', record);
    store.remove('s1');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(kv.data.size).toBe(0);
  });

  test('a failed write neither throws nor blocks the next one', async () => {
    const kv = storage();
    const { set } = kv;
    let fail = true;
    kv.set = async (key, value) => {
      if (fail) {
        fail = false;
        throw new Error('disk full');
      }
      await set(key, value);
    };
    const store = new KeepaliveStore(kv, owner());

    store.save('s1', record);
    store.save('s1', { ...record, pingsUsed: 3 });
    await settle();

    const [entry] = await store.restorable(NOW);
    expect(entry?.record.pingsUsed).toBe(3);
  });
});
