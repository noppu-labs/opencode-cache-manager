import { describe, expect, test } from 'bun:test';

import { BUILTIN_DEFAULTS, type Settings } from '../../src/config/settings.ts';
import { EXPIRY_MARGIN_MS, PING_OFFSET_MS, TTL_MS } from '../../src/constants/keepalive.ts';
import { SAVINGS_EXPIRY_MARGIN_MS } from '../../src/constants/savings.ts';
import type { CacheUsage, ModelRef } from '../../src/models/cache.ts';
import type { KeepaliveRecord } from '../../src/models/keepalive.ts';
import { KeepaliveEngine } from '../../src/services/keepalive-engine.ts';
import { useDebugTrace } from '../helpers/debug-log.ts';

const MODEL: ModelRef = { id: 'claude-sonnet-5-5', providerID: 'anthropic' };
const CONTEXT = 80_000;
const write: CacheUsage = {
  cacheReadTokens: 0,
  cacheWriteTokens: CONTEXT,
  inputTokens: 100,
  outputTokens: 0,
  write1hTokens: 0,
  write5mTokens: CONTEXT,
};
const hit: CacheUsage = {
  cacheReadTokens: CONTEXT,
  cacheWriteTokens: 0,
  inputTokens: 100,
  outputTokens: 0,
  write1hTokens: 0,
  write5mTokens: 0,
};

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

/** Storage and a clock that outlive any one engine, as they outlive a plugin reload. */
function world(settings: Partial<Settings> = {}) {
  let clock = 1_000_000;
  const records = new Map<string, KeepaliveRecord>();
  const rescues: unknown[][] = [];
  let writes = 0;

  function boot() {
    const timers = new Map<number, { at: number; fn: () => void }>();
    let nextHandle = 1;
    const pings: number[] = [];
    const engine: KeepaliveEngine = new KeepaliveEngine({
      clearTimer: (handle) => {
        timers.delete(handle as number);
      },
      isChild: async () => false,
      now: () => clock,
      onChange: () => {},
      persist: {
        remove: (sessionID) => {
          writes++;
          records.delete(sessionID);
        },
        save: (sessionID, record) => {
          writes++;
          records.set(sessionID, record);
        },
      },
      ping: async (sessionID) => {
        pings.push(clock);
        engine.requestSent(sessionID, { isPing: true, requestedTtl: '5m' });
        await engine.responseObserved(sessionID, {
          isPing: true,
          kind: 'generate',
          model: MODEL,
          ok: true,
          usage: hit,
        });
      },
      savings: {
        pingCharged: async () => {},
        readout: () => null,
        stretchRescued: async (...args: unknown[]) => {
          rescues.push(args);
        },
        stretchStarted: () => {},
      },
      setTimer: (fn, ms) => {
        const handle = nextHandle++;
        timers.set(handle, { at: clock + ms, fn });
        return handle;
      },
      settings: async () => ({ ...BUILTIN_DEFAULTS, ...settings }),
    });

    return {
      async advance(ms: number) {
        const target = clock + ms;
        for (;;) {
          const due = [...timers.entries()]
            .filter(([, timer]) => timer.at <= target)
            .toSorted((a, b) => a[1].at - b[1].at)[0];
          if (due === undefined) break;
          timers.delete(due[0]);
          clock = Math.max(clock, due[1].at);
          due[1].fn();
          await flush();
        }
        clock = target;
        await flush();
      },
      engine,
      pings,
      async request(sessionID: string, usage: CacheUsage = write) {
        engine.requestSent(sessionID, {
          isPing: false,
          kind: 'primary',
          model: MODEL,
          requestedTtl: '5m',
        });
        await flush();
        await engine.responseObserved(sessionID, {
          isPing: false,
          kind: 'primary',
          model: MODEL,
          ok: true,
          usage,
        });
        await flush();
      },
      /** The plugin reloads: this engine goes away and a new one restores from storage. */
      async reload() {
        engine.dispose();
        const next = boot();
        for (const [sessionID, record] of records) await next.engine.restore(sessionID, record);
        await flush();
        return next;
      },
    };
  }

  return {
    boot,
    records,
    rescues,
    get clock() {
      return clock;
    },
    get writes() {
      return writes;
    },
  };
}

describe('keepalive engine: surviving a plugin reload', () => {
  test('an armed ping still fires at its original time', async () => {
    const w = world();
    const first = w.boot();
    await first.request('s1');
    const due = first.engine.snapshot('s1').nextPingAt;
    await first.advance(60_000);

    const second = await first.reload();

    expect(second.engine.snapshot('s1').nextPingAt).toBe(due);
    await second.advance(PING_OFFSET_MS['5m'] - 60_000);
    expect(second.pings).toEqual([due!]);
    expect(first.pings).toEqual([]);
  });

  test('the restored session reads as it did before the reload', async () => {
    const w = world();
    const first = w.boot();
    await first.request('s1');
    await first.advance(PING_OFFSET_MS['5m']);
    const before = first.engine.snapshot('s1');

    const second = await first.reload();

    expect(second.engine.snapshot('s1')).toMatchObject({
      contextTokens: before.contextTokens,
      expiresAt: before.expiresAt,
      lastPing: 'hit',
      lastRequestAt: before.lastRequestAt,
      nextPingAt: before.nextPingAt,
      pingsUsed: 1,
      skipReason: null,
      ttl: '5m',
      ttlSource: 'detected',
    });
  });

  test('a ping that fell due during the reload goes out straight away', async () => {
    const w = world();
    const first = w.boot();
    await first.request('s1');
    const due = first.engine.snapshot('s1').nextPingAt!;
    first.engine.dispose();
    await first.advance(PING_OFFSET_MS['5m'] + 1000);

    const second = w.boot();
    await second.engine.restore('s1', w.records.get('s1')!);
    await second.advance(0);

    expect(second.pings).toEqual([due + 1000]);
  });

  test('past the expiry cutoff it says so and sends nothing', async () => {
    const w = world();
    const first = w.boot();
    await first.request('s1');
    first.engine.dispose();
    await first.advance(TTL_MS['5m'] - EXPIRY_MARGIN_MS + 1);

    const second = w.boot();
    await second.engine.restore('s1', w.records.get('s1')!);
    await second.advance(60_000);

    expect(second.pings).toEqual([]);
    expect(second.engine.snapshot('s1').skipReason).toBe('too-late');
  });

  test('pings already used still count against the limit', async () => {
    const w = world({ maxPings: 2 });
    const first = w.boot();
    await first.request('s1');
    await first.advance(PING_OFFSET_MS['5m']);

    const second = await first.reload();
    await second.advance(PING_OFFSET_MS['5m']);
    await second.advance(PING_OFFSET_MS['5m']);

    expect(first.pings).toHaveLength(1);
    expect(second.pings).toHaveLength(1);
    expect(second.engine.snapshot('s1').skipReason).toBe('exhausted');
  });

  test('a session that turned keepalive off in the meantime is not pinged', async () => {
    const w = world();
    const first = w.boot();
    await first.request('s1');
    const record = w.records.get('s1')!;
    first.engine.dispose();

    const off = world({ keepalive: false }).boot();
    await off.engine.restore('s1', record);
    await off.advance(PING_OFFSET_MS['5m']);

    expect(off.pings).toEqual([]);
    expect(off.engine.snapshot('s1').skipReason).toBe('disabled');
  });

  test('a real request during the restore wins over the stored record', async () => {
    const w = world();
    const first = w.boot();
    await first.request('s1');
    const stale = w.records.get('s1')!;
    first.engine.dispose();
    await first.advance(60_000);

    const second = w.boot();
    await second.request('s1');
    const live = second.engine.snapshot('s1');
    await second.engine.restore('s1', stale);

    expect(second.engine.snapshot('s1').lastRequestAt).toBe(live.lastRequestAt);
  });

  test('a disposed engine restores nothing', async () => {
    const w = world();
    const first = w.boot();
    await first.request('s1');
    const record = w.records.get('s1')!;
    first.engine.dispose();

    const second = w.boot();
    second.engine.dispose();
    await second.engine.restore('s1', record);
    await second.advance(PING_OFFSET_MS['5m']);

    expect(second.pings).toEqual([]);
  });

  test('a rescue is still counted when the stretch crossed a reload', async () => {
    const w = world();
    const first = w.boot();
    await first.request('s1');
    await first.advance(PING_OFFSET_MS['5m']);
    const second = await first.reload();
    await second.advance(TTL_MS['5m'] + SAVINGS_EXPIRY_MARGIN_MS + 1000 - PING_OFFSET_MS['5m']);

    await second.request('s1', hit);

    expect(w.rescues).toHaveLength(1);
  });
});

describe('keepalive engine: what it stores', () => {
  test('nothing before a ping is armed', async () => {
    const w = world();
    const engine = w.boot();
    engine.engine.requestSent('s1', { isPing: false, kind: 'primary', requestedTtl: '5m' });
    await flush();

    expect(w.records.size).toBe(0);
    expect(w.writes).toBe(0);
  });

  test('a record once a ping is armed', async () => {
    const w = world();
    await w.boot().request('s1');

    expect(w.records.get('s1')).toMatchObject({
      contextTokens: CONTEXT + 100,
      model: MODEL,
      pingsUsed: 0,
      requestedTtl: '5m',
      ttl: '5m',
    });
  });

  test('the record goes when keepalive stops for the session', async () => {
    const w = world({ maxPings: 1 });
    const engine = w.boot();
    await engine.request('s1');
    expect(w.records.has('s1')).toBe(true);

    await engine.advance(PING_OFFSET_MS['5m']);

    expect(engine.engine.snapshot('s1').skipReason).toBe('exhausted');
    expect(w.records.has('s1')).toBe(false);
  });

  test('a small session is never stored', async () => {
    const w = world({ minContextTokens: CONTEXT * 2 });
    await w.boot().request('s1');

    expect(w.records.size).toBe(0);
  });

  test('restoring writes nothing when nothing changed', async () => {
    const w = world();
    const first = w.boot();
    await first.request('s1');
    const before = w.writes;

    await first.reload();

    expect(w.writes).toBe(before);
  });

  test('a store that throws does not stop the schedule', async () => {
    const pings: string[] = [];
    let timer: (() => void) | undefined;
    const engine: KeepaliveEngine = new KeepaliveEngine({
      clearTimer: () => {},
      isChild: async () => false,
      now: () => 0,
      onChange: () => {},
      persist: {
        remove: () => {
          throw new Error('storage down');
        },
        save: () => {
          throw new Error('storage down');
        },
      },
      ping: async (sessionID) => {
        pings.push(sessionID);
      },
      setTimer: (fn) => {
        timer = fn;
        return 1;
      },
      settings: async () => BUILTIN_DEFAULTS,
    });

    engine.requestSent('s1', { isPing: false, kind: 'primary', requestedTtl: '5m' });
    await flush();
    await engine.responseObserved('s1', { isPing: false, kind: 'primary', ok: true, usage: write });
    await flush();
    timer?.();

    expect(pings).toEqual(['s1']);
  });
});

describe('debug log', () => {
  const trace = useDebugTrace();

  test('engine.restore logs the record and what the engine already knew', async () => {
    const w = world();
    const first = w.boot();
    await first.request('s1');
    const record = w.records.get('s1')!;
    const second = w.boot();

    await second.engine.restore('s1', record);
    await second.engine.restore('s1', record);
    second.engine.dispose();
    await second.engine.restore('s2', record);

    const { lastRequestAt, pingsUsed } = record;
    expect(trace.events().filter(({ ev }) => ev === 'engine.restore')).toMatchObject([
      { disposed: false, known: false, lastRequestAt, pingsUsed, sessionID: 's1' },
      { disposed: false, known: true, lastRequestAt, pingsUsed, sessionID: 's1' },
      { disposed: true, known: false, lastRequestAt, pingsUsed, sessionID: 's2' },
    ]);
  });
});
