import { describe, expect, test } from 'bun:test';

import { BUILTIN_DEFAULTS, type Settings } from '../../src/config/settings.ts';
import {
  EXPIRY_MARGIN_MS,
  PING_OFFSET_MS,
  RETRY_DELAY_MS,
  TTL_MS,
} from '../../src/constants/keepalive.ts';
import type { CacheUsage, ModelRef, Ttl } from '../../src/models/cache.ts';
import type { KeepaliveSnapshot, RequestKind } from '../../src/models/keepalive.ts';
import type { SavingsReadout } from '../../src/models/savings.ts';
import { KeepaliveEngine } from '../../src/services/keepalive-engine.ts';

const MIN = 60_000;
const MODEL: ModelRef = { providerID: 'anthropic', id: 'claude-sonnet-5-5' };

const write1h: CacheUsage = {
  inputTokens: 100,
  cacheReadTokens: 0,
  cacheWriteTokens: 80_000,
  outputTokens: 0,
  write5mTokens: 0,
  write1hTokens: 80_000,
};
const write5m: CacheUsage = { ...write1h, write5mTokens: 80_000, write1hTokens: 0 };
const writeNoBreakdown: CacheUsage = {
  ...write1h,
  outputTokens: 0,
  write5mTokens: undefined,
  write1hTokens: undefined,
};
const pureRead: CacheUsage = {
  inputTokens: 100,
  cacheReadTokens: 80_000,
  cacheWriteTokens: 0,
  outputTokens: 0,
  write5mTokens: 0,
  write1hTokens: 0,
};
const noCache: CacheUsage = {
  inputTokens: 80_100,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  write5mTokens: 0,
  write1hTokens: 0,
};
const smallWrite: CacheUsage = {
  inputTokens: 1000,
  cacheReadTokens: 0,
  cacheWriteTokens: 30_000,
  outputTokens: 0,
  write5mTokens: 0,
  write1hTokens: 30_000,
};
const hit: CacheUsage = { ...pureRead, cacheReadTokens: 80_100 };
const miss: CacheUsage = {
  inputTokens: 100,
  cacheReadTokens: 1000,
  cacheWriteTokens: 79_000,
  outputTokens: 0,
  write5mTokens: 0,
  write1hTokens: 79_000,
};

/** Records every ledger call; `readout` returns whatever the test sets. */
function fakeLedger() {
  const calls: [string, ...unknown[]][] = [];
  const readoutCalls: string[] = [];
  let value: SavingsReadout | null = null;
  return {
    calls,
    readoutCalls,
    setReadout(next: SavingsReadout | null) {
      value = next;
    },
    deps: {
      stretchStarted: (sessionID: string) => {
        calls.push(['stretchStarted', sessionID]);
      },
      pingCharged: async (...args: unknown[]) => {
        calls.push(['pingCharged', ...args]);
      },
      stretchRescued: async (...args: unknown[]) => {
        calls.push(['stretchRescued', ...args]);
      },
      readout: (sessionID: string) => {
        readoutCalls.push(sessionID);
        return value;
      },
    },
  };
}

type Behavior =
  | { kind: 'respond'; usage?: CacheUsage; ok?: boolean }
  | { kind: 'reject' }
  | { kind: 'notok-then-reject' }
  | { kind: 'silent' }
  | { kind: 'hold' }
  | { kind: 'respond-then-hold' };

function harness(
  options: { settings?: Partial<Settings>; child?: boolean; requestedTtl?: Ttl } = {}
) {
  let clock = 0;
  let nextHandle = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const settings: Settings = { ...BUILTIN_DEFAULTS, ...options.settings };
  const pings: { sessionID: string; at: number }[] = [];
  const changes: KeepaliveSnapshot[] = [];
  const queue: Behavior[] = [];
  const held: (() => void)[] = [];
  let isChildCalls = 0;
  let isChildResult = options.child ?? false;
  let isChildFails = false;
  let settingsGate: (() => Promise<void>) | undefined;
  let settingsFails = false;
  const requested = options.requestedTtl ?? '1h';
  const ledger = fakeLedger();

  const flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  };

  const engine = new KeepaliveEngine({
    now: () => clock,
    setTimer: (fn, ms) => {
      const handle = nextHandle++;
      timers.set(handle, { at: clock + ms, fn });
      return handle;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
    ping,
    settings: async () => {
      if (settingsGate) await settingsGate();
      if (settingsFails) throw new Error('settings unavailable');
      return { ...settings };
    },
    isChild: async () => {
      isChildCalls++;
      if (isChildFails) throw new Error('lookup failed');
      return isChildResult;
    },
    onChange: (snapshot) => changes.push(snapshot),
    savings: ledger.deps,
  });

  async function ping(sessionID: string): Promise<void> {
    pings.push({ sessionID, at: clock });
    const behavior: Behavior = queue.shift() ?? { kind: 'respond' };
    engine.requestSent(sessionID, { requestedTtl: requested, isPing: true });
    switch (behavior.kind) {
      case 'reject': {
        throw new Error('network');
      }
      case 'silent': {
        return;
      }
      case 'hold': {
        await new Promise<void>((resolve) => held.push(resolve));
        await engine.responseObserved(sessionID, {
          usage: hit,
          ok: true,
          isPing: true,
          kind: 'generate',
        });
        return;
      }
      case 'respond-then-hold': {
        await engine.responseObserved(sessionID, {
          usage: hit,
          ok: true,
          isPing: true,
          kind: 'generate',
        });
        await new Promise<void>((resolve) => held.push(resolve));
        return;
      }
      case 'notok-then-reject': {
        await engine.responseObserved(sessionID, {
          usage: undefined,
          ok: false,
          isPing: true,
          kind: 'generate',
        });
        throw new Error('http 500');
      }
      case 'respond': {
        await engine.responseObserved(sessionID, {
          usage: behavior.usage ?? hit,
          ok: behavior.ok ?? true,
          isPing: true,
          kind: 'generate',
        });
        return;
      }
      default: {
        throw new Error(`unknown behavior: ${String(behavior satisfies never)}`);
      }
    }
  }

  const runDue = async (stepClock: boolean, target: number) => {
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, t]) => t.at <= target)
        .toSorted((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      timers.delete(due[0]);
      if (stepClock) clock = Math.max(clock, due[1].at);
      due[1].fn();
      await flush();
    }
  };

  return {
    engine,
    ledger,
    settings,
    pings,
    changes,
    queue,
    held,
    get clock() {
      return clock;
    },
    get timerCount() {
      return timers.size;
    },
    get isChildCalls() {
      return isChildCalls;
    },
    setChild(value: boolean) {
      isChildResult = value;
    },
    failChildLookup(value: boolean) {
      isChildFails = value;
    },
    failSettings(value: boolean) {
      settingsFails = value;
    },
    gateSettings(gate: (() => Promise<void>) | undefined) {
      settingsGate = gate;
    },
    flush,
    /** Moves the clock forward, running timers in due order as the clock reaches each. */
    async advance(ms: number) {
      const target = clock + ms;
      await runDue(true, target);
      clock = target;
      await flush();
    },
    /** Moves the clock in one jump (a stalled event loop), then runs whatever is due. */
    async jump(ms: number) {
      clock += ms;
      await runDue(false, clock);
      await flush();
    },
    async request(
      sessionID: string,
      usage: CacheUsage | undefined,
      ttl: Ttl | null = requested,
      extra: { kind?: RequestKind; stopReason?: string; split?: boolean; model?: ModelRef } = {}
    ) {
      const model = extra.model ?? MODEL;
      engine.requestSent(sessionID, {
        requestedTtl: ttl,
        isPing: false,
        kind: extra.kind,
        split: extra.split,
        model,
      });
      await flush();
      await engine.responseObserved(sessionID, {
        usage,
        ok: usage !== undefined,
        isPing: false,
        kind: extra.kind ?? 'primary',
        stopReason: extra.stopReason,
        model,
      });
      await flush();
    },
  };
}

describe('keepalive engine: scheduling', () => {
  test('1h detected: pings at 50m, 100m, ... and stops after maxPings', async () => {
    const h = harness();
    await h.request('s1', write1h);
    expect(h.engine.snapshot('s1')).toMatchObject({
      ttl: '1h',
      ttlSource: 'detected',
      lastRequestAt: 0,
      expiresAt: TTL_MS['1h'],
      nextPingAt: 50 * MIN,
      pingsUsed: 0,
      maxPings: 5,
      minContextTokens: 50_000,
      skipReason: null,
      contextTokens: 80_100,
    });

    await h.advance(50 * MIN - 1);
    expect(h.pings).toHaveLength(0);
    await h.advance(1);
    expect(h.pings).toEqual([{ sessionID: 's1', at: 50 * MIN }]);
    expect(h.engine.snapshot('s1')).toMatchObject({
      pingsUsed: 1,
      lastPing: 'hit',
      lastRequestAt: 50 * MIN,
      nextPingAt: 100 * MIN,
    });

    await h.advance(50 * MIN);
    expect(h.pings.map((p) => p.at)).toEqual([50 * MIN, 100 * MIN]);

    await h.advance(150 * MIN);
    expect(h.pings.map((p) => p.at)).toEqual([50, 100, 150, 200, 250].map((m) => m * MIN));
    expect(h.engine.snapshot('s1')).toMatchObject({
      pingsUsed: 5,
      lastPing: 'hit',
      skipReason: 'exhausted',
      nextPingAt: null,
    });

    await h.advance(5 * 60 * MIN);
    expect(h.pings).toHaveLength(5);
    expect(h.timerCount).toBe(0);
  });

  test('5m session pings every 4m', async () => {
    const h = harness();
    await h.request('s1', write5m, '5m');
    expect(h.engine.snapshot('s1')).toMatchObject({
      ttl: '5m',
      ttlSource: 'detected',
      nextPingAt: 4 * MIN,
    });
    await h.advance(12 * MIN);
    expect(h.pings.map((p) => p.at)).toEqual([4 * MIN, 8 * MIN, 12 * MIN]);
    expect(h.engine.snapshot('s1').pingsUsed).toBe(3);
  });

  test('hybrid requested falls back to 5m schedule', async () => {
    const h = harness();
    await h.request('s1', writeNoBreakdown, '5m');
    expect(h.engine.snapshot('s1')).toMatchObject({
      ttl: '5m',
      ttlSource: 'requested',
      expiresAt: TTL_MS['5m'],
      nextPingAt: PING_OFFSET_MS['5m'],
    });
    await h.advance(4 * MIN);
    expect(h.pings).toHaveLength(1);
  });

  test('30m requested pings at 25m and stays requested without a breakdown', async () => {
    const h = harness();
    await h.request('s1', writeNoBreakdown, '30m');
    expect(h.engine.snapshot('s1')).toMatchObject({
      ttl: '30m',
      ttlSource: 'requested',
      expiresAt: TTL_MS['30m'],
      nextPingAt: 25 * MIN,
    });
    await h.advance(25 * MIN - 1);
    expect(h.pings).toHaveLength(0);
    await h.advance(1);
    expect(h.pings).toEqual([{ sessionID: 's1', at: 25 * MIN }]);
    expect(h.engine.snapshot('s1')).toMatchObject({
      ttl: '30m',
      ttlSource: 'requested',
      lastPing: 'hit',
    });
  });

  test('a detected Claude 1h gives way to a requested 30m after a switch to GPT', async () => {
    const h = harness();
    await h.request('s1', write1h, '1h');
    expect(h.engine.snapshot('s1')).toMatchObject({ ttl: '1h', ttlSource: 'detected' });
    await h.advance(10 * MIN);
    await h.request('s1', writeNoBreakdown, '30m');
    expect(h.engine.snapshot('s1')).toMatchObject({
      ttl: '30m',
      ttlSource: 'requested',
      expiresAt: 10 * MIN + TTL_MS['30m'],
      nextPingAt: 35 * MIN,
    });
    await h.advance(25 * MIN);
    expect(h.pings).toEqual([{ sessionID: 's1', at: 35 * MIN }]);
  });

  test('12h requested pings at 10h and stays requested without a breakdown', async () => {
    const h = harness();
    await h.request('s1', writeNoBreakdown, '12h');
    expect(h.engine.snapshot('s1')).toMatchObject({
      ttl: '12h',
      ttlSource: 'requested',
      expiresAt: TTL_MS['12h'],
      nextPingAt: 600 * MIN,
    });
    await h.advance(600 * MIN - 1);
    expect(h.pings).toHaveLength(0);
    await h.advance(1);
    expect(h.pings).toEqual([{ sessionID: 's1', at: 600 * MIN }]);
    expect(h.engine.snapshot('s1')).toMatchObject({
      ttl: '12h',
      ttlSource: 'requested',
      lastPing: 'hit',
    });
  });

  test('granted 1h overrides requested 5m', async () => {
    const h = harness();
    await h.request('s1', write1h, '5m');
    expect(h.engine.snapshot('s1')).toMatchObject({
      ttl: '1h',
      ttlSource: 'detected',
      nextPingAt: PING_OFFSET_MS['1h'],
    });
    await h.advance(4 * MIN);
    expect(h.pings).toHaveLength(0);
  });

  test('pure read keeps previous ttl', async () => {
    const h = harness();
    await h.request('s1', write1h);
    await h.advance(10 * MIN);
    await h.request('s1', pureRead, '5m');
    expect(h.engine.snapshot('s1')).toMatchObject({
      ttl: '1h',
      ttlSource: 'detected',
      lastRequestAt: 10 * MIN,
      nextPingAt: 60 * MIN,
      pingsUsed: 0,
    });
  });

  test('a pure read with no ttl seen yet falls back to the requested ttl', async () => {
    const h = harness();
    await h.request('s1', pureRead, '5m');
    expect(h.engine.snapshot('s1')).toMatchObject({
      ttl: '5m',
      ttlSource: 'requested',
      nextPingAt: 4 * MIN,
    });
  });

  test('no ping before cache activity is seen', async () => {
    const h = harness();
    expect(h.engine.snapshot('s1')).toMatchObject({
      ttl: null,
      ttlSource: null,
      contextTokens: null,
      skipReason: 'no-cache-seen',
      nextPingAt: null,
      minContextTokens: BUILTIN_DEFAULTS.minContextTokens,
    });
    h.engine.requestSent('s1', { requestedTtl: '5m', isPing: false });
    await h.flush();
    expect(h.engine.snapshot('s1')).toMatchObject({
      ttl: null,
      contextTokens: null,
      skipReason: 'no-cache-seen',
    });

    await h.engine.responseObserved('s1', {
      usage: noCache,
      ok: true,
      isPing: false,
      kind: 'primary',
    });
    await h.flush();
    expect(h.engine.snapshot('s1')).toMatchObject({
      ttl: null,
      contextTokens: 80_100,
      skipReason: 'no-cache-seen',
      nextPingAt: null,
    });
    await h.advance(120 * MIN);
    expect(h.pings).toHaveLength(0);
  });

  test('small context skips', async () => {
    const h = harness();
    await h.request('s1', smallWrite);
    expect(h.engine.snapshot('s1')).toMatchObject({
      contextTokens: 31_000,
      skipReason: 'small-context',
      nextPingAt: null,
    });
    await h.advance(120 * MIN);
    expect(h.pings).toHaveLength(0);
  });

  test('child session never pinged', async () => {
    const h = harness({ child: true });
    await h.request('c1', write1h);
    await h.request('c1', write1h);
    expect(h.engine.snapshot('c1')).toMatchObject({ skipReason: 'child', nextPingAt: null });
    expect(h.isChildCalls).toBe(1);
    await h.advance(120 * MIN);
    expect(h.pings).toHaveLength(0);
  });

  test('keepalive disabled, then reevaluate after enabling schedules a ping', async () => {
    const h = harness({ settings: { keepalive: false } });
    await h.request('s1', write1h);
    expect(h.engine.snapshot('s1')).toMatchObject({ skipReason: 'disabled', nextPingAt: null });
    await h.advance(30 * MIN);
    expect(h.pings).toHaveLength(0);

    h.settings.keepalive = true;
    await h.engine.reevaluate();
    expect(h.engine.snapshot('s1')).toMatchObject({ skipReason: null, nextPingAt: 50 * MIN });
    await h.advance(20 * MIN);
    expect(h.pings).toEqual([{ sessionID: 's1', at: 50 * MIN }]);
  });

  test('changing minContextTokens via reevaluate updates the snapshot field', async () => {
    const h = harness();
    await h.request('s1', write1h);
    expect(h.engine.snapshot('s1').minContextTokens).toBe(50_000);

    h.settings.minContextTokens = 100_000;
    await h.engine.reevaluate('s1');
    expect(h.engine.snapshot('s1')).toMatchObject({
      minContextTokens: 100_000,
      skipReason: 'small-context',
    });
    expect(h.changes.at(-1)).toMatchObject({ minContextTokens: 100_000 });
  });

  test('lowering maxPings below used ends the run', async () => {
    const h = harness();
    await h.request('s1', write1h);
    await h.advance(100 * MIN);
    expect(h.engine.snapshot('s1').pingsUsed).toBe(2);

    h.settings.maxPings = 1;
    await h.engine.reevaluate('s1');
    expect(h.engine.snapshot('s1')).toMatchObject({
      skipReason: 'exhausted',
      nextPingAt: null,
      maxPings: 1,
    });
    expect(h.timerCount).toBe(0);
    await h.advance(120 * MIN);
    expect(h.pings).toHaveLength(2);
  });

  test('two sessions are scheduled independently', async () => {
    const h = harness();
    await h.request('a', write1h);
    await h.advance(2 * MIN);
    await h.request('b', write5m, '5m');

    await h.advance(4 * MIN);
    expect(h.pings).toEqual([{ sessionID: 'b', at: 6 * MIN }]);
    expect(h.engine.snapshot('a')).toMatchObject({ pingsUsed: 0, nextPingAt: 50 * MIN });
    expect(h.engine.snapshot('b')).toMatchObject({
      pingsUsed: 1,
      lastRequestAt: 6 * MIN,
      nextPingAt: 10 * MIN,
    });

    await h.request('a', pureRead);
    await h.advance(4 * MIN);
    expect(h.pings.map((p) => `${p.sessionID}@${p.at / MIN}`)).toEqual(['b@6', 'b@10']);
    expect(h.engine.snapshot('a')).toMatchObject({ lastRequestAt: 6 * MIN, nextPingAt: 56 * MIN });
  });
});

describe('keepalive engine: ping outcomes', () => {
  test('miss stops keepalive until next real request', async () => {
    const h = harness();
    await h.request('s1', write1h);
    await h.advance(50 * MIN);
    await h.advance(50 * MIN);
    expect(h.engine.snapshot('s1')).toMatchObject({ lastPing: 'hit', pingsUsed: 2 });

    // Third ping misses: read 1 000 of an 80 100-token context
    h.queue.push({ kind: 'respond', usage: miss });
    await h.advance(50 * MIN);
    expect(h.pings).toHaveLength(3);
    expect(h.engine.snapshot('s1')).toMatchObject({
      lastPing: 'miss',
      skipReason: 'missed',
      nextPingAt: null,
      lastRequestAt: 100 * MIN,
    });
    await h.advance(5 * 60 * MIN);
    expect(h.pings).toHaveLength(3);

    h.engine.requestSent('s1', { requestedTtl: '1h', isPing: false });
    expect(h.engine.snapshot('s1')).toMatchObject({
      lastPing: null,
      pingsUsed: 0,
      skipReason: null,
    });
    await h.flush();
    await h.engine.responseObserved('s1', {
      usage: write1h,
      ok: true,
      isPing: false,
      kind: 'primary',
    });
    await h.flush();
    expect(h.engine.snapshot('s1')).toMatchObject({
      lastPing: null,
      skipReason: null,
      pingsUsed: 0,
      nextPingAt: h.clock + 50 * MIN,
    });
    await h.advance(50 * MIN);
    expect(h.pings).toHaveLength(4);
  });

  test('hit threshold is 90% of the context seen before the ping', async () => {
    const h = harness();
    await h.request('s1', write1h);
    const context = 80_100;
    h.queue.push({ kind: 'respond', usage: { ...hit, cacheReadTokens: 0.9 * context } });
    await h.advance(50 * MIN);
    expect(h.engine.snapshot('s1').lastPing).toBe('hit');
    h.queue.push({ kind: 'respond', usage: { ...hit, cacheReadTokens: 0.9 * context - 1 } });
    await h.advance(50 * MIN);
    expect(h.engine.snapshot('s1').lastPing).toBe('miss');
  });

  test('a ping does not change the tracked context size', async () => {
    const h = harness();
    await h.request('s1', write1h);
    h.queue.push({
      kind: 'respond',
      usage: { ...hit, inputTokens: 10_000, cacheReadTokens: 90_000 },
    });
    await h.advance(50 * MIN);
    expect(h.engine.snapshot('s1').contextTokens).toBe(80_100);
  });

  test('failed ping retries within expiry, else stops', async () => {
    const h = harness();
    await h.request('s1', write5m, '5m');

    h.queue.push(
      { kind: 'reject' },
      { kind: 'respond', usage: { ...write5m, cacheReadTokens: 80_100 } }
    );
    await h.advance(4 * MIN);
    expect(h.engine.snapshot('s1')).toMatchObject({
      lastPing: 'failed',
      pingsUsed: 1,
      lastRequestAt: 0,
      nextPingAt: 4 * MIN + RETRY_DELAY_MS,
    });
    await h.advance(RETRY_DELAY_MS - 1);
    expect(h.pings).toHaveLength(1);
    await h.advance(1);
    expect(h.pings.map((p) => p.at)).toEqual([4 * MIN, 4 * MIN + RETRY_DELAY_MS]);
    expect(h.engine.snapshot('s1')).toMatchObject({ lastPing: 'hit', pingsUsed: 2 });

    // Fresh run: 240s ping fails, 270s retry fails, next retry (300s) is past 285s
    const g = harness();
    await g.request('s1', write5m, '5m');
    g.queue.push({ kind: 'reject' }, { kind: 'reject' }, { kind: 'reject' });
    await g.advance(10 * MIN);
    expect(g.pings.map((p) => p.at)).toEqual([4 * MIN, 4 * MIN + RETRY_DELAY_MS]);
    expect(g.engine.snapshot('s1')).toMatchObject({
      lastPing: 'failed',
      pingsUsed: 2,
      nextPingAt: null,
    });
    expect(4 * MIN + 2 * RETRY_DELAY_MS).toBeGreaterThan(TTL_MS['5m'] - EXPIRY_MARGIN_MS);
    expect(g.timerCount).toBe(0);
  });

  test('a failure is counted once whether the response is not ok, the call rejects, or both', async () => {
    const h = harness();
    await h.request('s1', write1h);
    h.queue.push({ kind: 'notok-then-reject' });
    await h.advance(50 * MIN);
    expect(h.engine.snapshot('s1')).toMatchObject({ lastPing: 'failed', pingsUsed: 1 });
    expect(h.timerCount).toBe(1);
    await h.advance(RETRY_DELAY_MS);
    expect(h.pings).toHaveLength(2);
    expect(h.engine.snapshot('s1')).toMatchObject({ lastPing: 'hit', pingsUsed: 2 });

    const g = harness();
    await g.request('s1', write1h);
    g.queue.push({ kind: 'respond', ok: false, usage: undefined });
    await g.advance(50 * MIN);
    expect(g.engine.snapshot('s1')).toMatchObject({
      lastPing: 'failed',
      pingsUsed: 1,
      lastRequestAt: 0,
    });
  });

  test('a ping that resolves without a response being observed counts as failed', async () => {
    const h = harness();
    await h.request('s1', write1h);
    h.queue.push({ kind: 'silent' });
    await h.advance(50 * MIN);
    expect(h.engine.snapshot('s1')).toMatchObject({
      lastPing: 'failed',
      pingsUsed: 1,
      lastRequestAt: 0,
      nextPingAt: 50 * MIN + RETRY_DELAY_MS,
    });
  });

  test('retries count toward maxPings', async () => {
    const h = harness({ settings: { maxPings: 2 } });
    await h.request('s1', write1h);
    h.queue.push({ kind: 'reject' });
    await h.advance(50 * MIN + RETRY_DELAY_MS);
    expect(h.pings).toHaveLength(2);
    expect(h.engine.snapshot('s1')).toMatchObject({
      pingsUsed: 2,
      lastPing: 'hit',
      skipReason: 'exhausted',
    });
    await h.advance(5 * 60 * MIN);
    expect(h.pings).toHaveLength(2);
  });
});

describe('keepalive engine: races and lifecycle', () => {
  test('does not ping when the timer fires after expiry', async () => {
    const h = harness();
    await h.request('s1', write5m, '5m');
    expect(h.engine.snapshot('s1').nextPingAt).toBe(4 * MIN);

    await h.jump(6 * MIN);
    expect(h.pings).toHaveLength(0);
    expect(h.engine.snapshot('s1')).toMatchObject({ nextPingAt: null, pingsUsed: 0 });
    expect(h.timerCount).toBe(0);
  });

  test('a real request during an in-flight ping wins', async () => {
    const h = harness();
    await h.request('s1', write1h);
    h.queue.push({ kind: 'hold' });
    await h.advance(50 * MIN);
    expect(h.pings).toHaveLength(1);
    expect(h.held).toHaveLength(1);

    await h.advance(2 * MIN);
    await h.request('s1', hit);
    const before = h.engine.snapshot('s1');
    expect(before).toMatchObject({ lastRequestAt: 52 * MIN, pingsUsed: 0, lastPing: null });

    h.held[0]();
    await h.flush();
    expect(h.engine.snapshot('s1')).toEqual(before);
    expect(h.pings).toHaveLength(1);
  });

  test('a stale ping that fails late does not mark the session failed', async () => {
    const h = harness();
    await h.request('s1', write1h);
    h.queue.push({ kind: 'hold' });
    await h.advance(50 * MIN);
    await h.request('s1', hit);
    const before = h.engine.snapshot('s1');
    await h.engine.responseObserved('s1', {
      usage: undefined,
      ok: false,
      isPing: true,
      kind: 'generate',
    });
    expect(h.engine.snapshot('s1')).toEqual(before);
  });

  test('a late async schedule from an older request never arms a timer', async () => {
    const h = harness();
    await h.request('s1', write1h);

    const gates: (() => void)[] = [];
    h.gateSettings(() => new Promise<void>((resolve) => gates.push(resolve)));
    h.engine.requestSent('s1', { requestedTtl: '1h', isPing: false });
    await h.advance(MIN);
    h.engine.requestSent('s1', { requestedTtl: '1h', isPing: false });
    expect(h.timerCount).toBe(0);
    expect(gates).toHaveLength(2);

    gates[1]();
    await h.flush();
    gates[0]();
    await h.flush();
    expect(h.timerCount).toBe(1);
    expect(h.engine.snapshot('s1')).toMatchObject({
      lastRequestAt: MIN,
      nextPingAt: MIN + 50 * MIN,
    });

    h.gateSettings(undefined);
    await h.advance(49 * MIN);
    expect(h.pings).toHaveLength(0);
    await h.advance(MIN);
    expect(h.pings).toEqual([{ sessionID: 's1', at: 51 * MIN }]);
  });

  test('reevaluate during an in-flight ping does not start a second ping', async () => {
    const h = harness();
    await h.request('s1', write1h);
    h.queue.push({ kind: 'hold' });
    await h.advance(50 * MIN);
    await h.engine.reevaluate('s1');
    await h.advance(MIN);
    expect(h.pings).toHaveLength(1);
    h.held[0]();
    await h.flush();
    expect(h.engine.snapshot('s1')).toMatchObject({
      lastPing: 'hit',
      pingsUsed: 1,
      nextPingAt: 100 * MIN,
    });
  });

  test('dispose clears all timers', async () => {
    const h = harness();
    await h.request('a', write1h);
    await h.request('b', write5m, '5m');
    expect(h.timerCount).toBe(2);
    h.engine.dispose();
    expect(h.timerCount).toBe(0);
    await h.advance(120 * MIN);
    expect(h.pings).toHaveLength(0);
  });

  test('onChange fires only when the snapshot changes', async () => {
    const h = harness();
    await h.request('s1', write1h);
    await h.engine.reevaluate('s1');
    await h.engine.reevaluate('s1');
    expect(h.changes.length).toBeGreaterThan(0);
    for (let i = 1; i < h.changes.length; i++) {
      expect(JSON.stringify(h.changes[i])).not.toBe(JSON.stringify(h.changes[i - 1]));
    }
    const count = h.changes.length;
    await h.engine.reevaluate('s1');
    expect(h.changes).toHaveLength(count);
    expect(h.changes.at(-1)).toEqual(h.engine.snapshot('s1'));
  });
});

describe('keepalive engine: review fixes', () => {
  test('a failed real request does not extend expiry', async () => {
    /*
     * With maxPings 1, the single allowed ping may fire at 4m (scheduled from the
     * confirmed t=0 request); nothing may be sent later than expiry - margin.
     */
    const h = harness({ settings: { maxPings: 1 } });
    await h.request('s1', write5m, '5m');
    expect(h.engine.snapshot('s1')).toMatchObject({ lastRequestAt: 0, expiresAt: 5 * MIN });

    await h.advance(3 * MIN);
    h.engine.requestSent('s1', { requestedTtl: '5m', isPing: false });
    await h.flush();
    await h.engine.responseObserved('s1', {
      usage: undefined,
      ok: false,
      isPing: false,
      kind: 'primary',
    });
    await h.flush();
    expect(h.engine.snapshot('s1')).toMatchObject({
      lastRequestAt: 0,
      expiresAt: 5 * MIN,
      pingsUsed: 0,
      nextPingAt: 4 * MIN,
    });

    await h.advance(20 * MIN);
    expect(h.pings.length).toBeLessThanOrEqual(1);
    for (const ping of h.pings) {
      expect(ping.at).toBeLessThanOrEqual(TTL_MS['5m'] - EXPIRY_MARGIN_MS);
    }
  });

  test('a failed real request after expiry schedules nothing', async () => {
    const h = harness();
    await h.request('s1', write5m, '5m');
    await h.jump(6 * MIN);
    h.engine.requestSent('s1', { requestedTtl: '5m', isPing: false });
    await h.flush();
    await h.engine.responseObserved('s1', {
      usage: undefined,
      ok: false,
      isPing: false,
      kind: 'primary',
    });
    await h.flush();
    expect(h.engine.snapshot('s1')).toMatchObject({ lastRequestAt: 0, nextPingAt: null });
    await h.advance(30 * MIN);
    expect(h.pings).toHaveLength(0);
  });

  test('a failed first request leaves nothing confirmed and an ok one confirms its send time', async () => {
    const h = harness();
    h.engine.requestSent('s1', { requestedTtl: '5m', isPing: false });
    await h.flush();
    await h.engine.responseObserved('s1', {
      usage: undefined,
      ok: false,
      isPing: false,
      kind: 'primary',
    });
    await h.flush();
    expect(h.engine.snapshot('s1')).toMatchObject({
      lastRequestAt: null,
      expiresAt: null,
      nextPingAt: null,
    });

    await h.advance(MIN);
    h.engine.requestSent('s1', { requestedTtl: '5m', isPing: false });
    await h.advance(30_000);
    await h.engine.responseObserved('s1', {
      usage: write5m,
      ok: true,
      isPing: false,
      kind: 'primary',
    });
    await h.flush();
    expect(h.engine.snapshot('s1')).toMatchObject({
      lastRequestAt: MIN,
      expiresAt: 6 * MIN,
      nextPingAt: 5 * MIN,
    });
  });

  test('a rejected settings lookup never leaves a stale nextPingAt advertised', async () => {
    const h = harness();
    await h.request('s1', write1h);
    expect(h.engine.snapshot('s1').nextPingAt).toBe(50 * MIN);

    h.failSettings(true);
    await h.engine.reevaluate('s1');
    expect(h.engine.snapshot('s1').nextPingAt).toBeNull();
    expect(h.timerCount).toBe(0);
    await h.advance(20 * MIN);
    expect(h.pings).toHaveLength(0);

    h.failSettings(false);
    await h.engine.reevaluate('s1');
    expect(h.engine.snapshot('s1').nextPingAt).toBe(50 * MIN);
  });

  test('a rejected isChild lookup is treated as child for that computation and retried', async () => {
    const h = harness();
    h.failChildLookup(true);
    await h.request('s1', write1h);
    expect(h.engine.snapshot('s1')).toMatchObject({ skipReason: 'child', nextPingAt: null });
    expect(h.timerCount).toBe(0);
    const failedCalls = h.isChildCalls;
    expect(failedCalls).toBeGreaterThan(1);

    h.failChildLookup(false);
    await h.engine.reevaluate('s1');
    expect(h.isChildCalls).toBe(failedCalls + 1);
    expect(h.engine.snapshot('s1')).toMatchObject({ skipReason: null, nextPingAt: 50 * MIN });

    await h.engine.reevaluate('s1');
    await h.request('s1', pureRead);
    expect(h.isChildCalls).toBe(failedCalls + 1);
  });

  test('dispose while a schedule computation is pending', async () => {
    const h = harness();
    await h.request('s1', write1h);
    const gates: (() => void)[] = [];
    h.gateSettings(() => new Promise<void>((resolve) => gates.push(resolve)));
    h.engine.requestSent('s1', { requestedTtl: '1h', isPing: false });
    const reevaluation = h.engine.reevaluate('s1');
    await h.flush();
    expect(gates.length).toBeGreaterThan(0);

    h.engine.dispose();
    const changesAtDispose = h.changes.length;
    for (const open of gates) open();
    await reevaluation;
    await h.advance(120 * MIN);
    expect(h.timerCount).toBe(0);
    expect(h.pings).toHaveLength(0);
    expect(h.changes).toHaveLength(changesAtDispose);
  });

  test('dispose while a ping is in flight', async () => {
    const h = harness();
    await h.request('s1', write1h);
    h.queue.push({ kind: 'hold' });
    await h.advance(50 * MIN);
    expect(h.pings).toHaveLength(1);

    h.engine.dispose();
    const changesAtDispose = h.changes.length;
    h.held[0]();
    await h.flush();
    await h.advance(120 * MIN);
    expect(h.timerCount).toBe(0);
    expect(h.pings).toHaveLength(1);
    expect(h.changes).toHaveLength(changesAtDispose);
  });

  test('a timer firing inside the last 15s before expiry does not ping', async () => {
    const h = harness();
    await h.request('s1', write5m, '5m');
    await h.jump(TTL_MS['5m'] - 10_000);
    expect(h.pings).toHaveLength(0);
    expect(h.engine.snapshot('s1')).toMatchObject({ nextPingAt: null, pingsUsed: 0 });
    expect(h.timerCount).toBe(0);
  });

  test('a timer firing exactly at expiry - margin still pings', async () => {
    const h = harness();
    await h.request('s1', write5m, '5m');
    await h.jump(TTL_MS['5m'] - EXPIRY_MARGIN_MS);
    expect(h.pings).toEqual([{ sessionID: 's1', at: TTL_MS['5m'] - EXPIRY_MARGIN_MS }]);
  });
});

describe('keepalive engine: busy sessions', () => {
  test('a primary response stopping for tool_use is not pinged until the next real request', async () => {
    const h = harness();
    await h.request('s1', write1h, '1h', { stopReason: 'tool_use' });
    expect(h.engine.snapshot('s1')).toMatchObject({ skipReason: 'busy', nextPingAt: null });
    await h.advance(55 * MIN);
    expect(h.pings).toHaveLength(0);

    await h.request('s1', write1h, '1h', { stopReason: 'end_turn' });
    expect(h.engine.snapshot('s1')).toMatchObject({
      skipReason: null,
      nextPingAt: h.clock + 50 * MIN,
    });
    await h.advance(50 * MIN);
    expect(h.pings).toHaveLength(1);
  });

  test('the busy flag clears as soon as the next real request is sent', async () => {
    const h = harness();
    await h.request('s1', write1h, '1h', { stopReason: 'tool_use' });
    h.engine.requestSent('s1', { requestedTtl: '1h', isPing: false });
    await h.flush();
    expect(h.engine.snapshot('s1').skipReason).toBe(null);
  });

  test('only primary responses mark a session busy', async () => {
    const h = harness();
    await h.request('s1', write1h);
    await h.request('s1', write1h, '1h', { kind: 'generate', stopReason: 'tool_use' });
    await h.request('s1', write1h, '1h', { kind: 'title', stopReason: 'tool_use' });
    expect(h.engine.snapshot('s1').skipReason).toBe(null);
  });

  test('busy is checked right after child', async () => {
    const child = harness({ child: true });
    await child.request('s1', write1h, '1h', { stopReason: 'tool_use' });
    expect(child.engine.snapshot('s1').skipReason).toBe('child');

    const off = harness({ settings: { keepalive: false } });
    await off.request('s1', write1h, '1h', { stopReason: 'tool_use' });
    expect(off.engine.snapshot('s1').skipReason).toBe('busy');
  });
});

describe('keepalive engine: final review fixes', () => {
  test('a missed ping keeps the previous expiry anchor', async () => {
    const h = harness();
    await h.request('s1', write1h);
    h.queue.push({ kind: 'respond', usage: miss });
    await h.advance(50 * MIN);
    expect(h.engine.snapshot('s1')).toMatchObject({
      lastPing: 'miss',
      lastRequestAt: 0,
      expiresAt: TTL_MS['1h'],
    });
  });

  test("a hit still moves the anchor to the ping's send time", async () => {
    const h = harness();
    await h.request('s1', write1h);
    await h.advance(50 * MIN);
    expect(h.engine.snapshot('s1')).toMatchObject({ lastPing: 'hit', lastRequestAt: 50 * MIN });
  });

  test('title and non-ping generate responses do not overwrite the context size or the TTL', async () => {
    const h = harness();
    await h.request('s1', write1h);
    const small: CacheUsage = { ...write5m, cacheWriteTokens: 2000, write5mTokens: 2000 };
    await h.request('s1', small, '5m', { kind: 'title' });
    await h.request('s1', small, '5m', { kind: 'generate' });
    expect(h.engine.snapshot('s1')).toMatchObject({ ttl: '1h', contextTokens: 80_100 });

    await h.request('s1', write5m, '5m', { kind: 'compaction' });
    expect(h.engine.snapshot('s1')).toMatchObject({ ttl: '5m', contextTokens: 80_100 });
  });

  test('no new ping fires while the previous ping call is unsettled', async () => {
    const h = harness();
    await h.request('s1', write1h);
    h.queue.push({ kind: 'respond-then-hold' });
    await h.advance(50 * MIN);
    expect(h.pings).toHaveLength(1);
    expect(h.engine.snapshot('s1')).toMatchObject({ lastPing: 'hit', nextPingAt: 100 * MIN });

    await h.advance(52 * MIN);
    expect(h.pings).toHaveLength(1);

    h.held[0]();
    await h.flush();
    await h.advance(0);
    expect(h.pings).toHaveLength(2);
    expect(h.pings[1].at).toBe(102 * MIN);
  });
});

describe('keepalive engine: implicit-cache sessions', () => {
  test('a null requested TTL skips keepalive as implicit and records the latest cache', async () => {
    const h = harness();
    await h.request('s1', pureRead, null);
    expect(h.engine.snapshot('s1')).toMatchObject({
      ttl: null,
      ttlSource: null,
      skipReason: 'implicit',
      nextPingAt: null,
      lastCache: { read: 80_000, total: 80_100 },
    });
    await h.advance(50 * MIN);
    expect(h.timerCount).toBe(0);
    expect(h.pings).toHaveLength(0);
  });

  test('a later request with a TTL clears implicit and schedules', async () => {
    const h = harness();
    await h.request('s1', pureRead, null);
    await h.request('s1', write1h, '1h');
    expect(h.engine.snapshot('s1')).toMatchObject({
      ttl: '1h',
      skipReason: null,
      nextPingAt: 50 * MIN,
    });
    expect(h.timerCount).toBe(1);
  });

  test('a request with a TTL does not emit the implicit skip reason it is about to clear', async () => {
    const h = harness();
    await h.request('s1', pureRead, null);
    await h.advance(MIN);
    const before = h.changes.length;
    h.engine.requestSent('s1', { requestedTtl: '1h', isPing: false, kind: 'primary' });
    const emitted = h.changes.slice(before);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.skipReason).toBeNull();
  });

  test('a request without a TTL keeps an implicit session implicit', async () => {
    const h = harness();
    await h.request('s1', pureRead, null);
    await h.advance(MIN);
    h.engine.requestSent('s1', { requestedTtl: null, isPing: false, kind: 'primary' });
    expect(h.changes.at(-1)?.skipReason).toBe('implicit');
  });

  test('a title request with a TTL does not turn an implicit primary session into a scheduled one', async () => {
    const h = harness();
    h.engine.requestSent('s1', { requestedTtl: null, isPing: false, kind: 'primary' });
    h.engine.requestSent('s1', { requestedTtl: '1h', isPing: false, kind: 'title' });
    await h.engine.responseObserved('s1', {
      usage: pureRead,
      ok: true,
      isPing: false,
      kind: 'primary',
    });
    await h.flush();
    expect(h.engine.snapshot('s1')).toMatchObject({ skipReason: 'implicit', nextPingAt: null });
    expect(h.timerCount).toBe(0);
  });

  test('a title or generate request without a TTL does not turn a scheduled session implicit', async () => {
    const h = harness();
    for (const kind of ['title', 'generate'] as const) {
      const id = `s-${kind}`;
      h.engine.requestSent(id, { requestedTtl: '1h', isPing: false, kind: 'primary' });
      h.engine.requestSent(id, { requestedTtl: null, isPing: false, kind });
      await h.engine.responseObserved(id, {
        usage: write1h,
        ok: true,
        isPing: false,
        kind: 'primary',
      });
      await h.flush();
      expect(h.engine.snapshot(id)).toMatchObject({ skipReason: null, nextPingAt: 50 * MIN });
    }
  });

  test('a compaction request does decide the requested TTL', async () => {
    const h = harness();
    await h.request('s1', pureRead, '1h');
    await h.request('s1', pureRead, null, { kind: 'compaction' });
    expect(h.engine.snapshot('s1').skipReason).toBe('implicit');
  });

  test('an unmanaged primary response turns a kept-warm session implicit and fires no ping', async () => {
    const h = harness();
    h.engine.requestSent('s1', { requestedTtl: '1h', isPing: false, kind: 'primary' });
    await h.engine.responseObserved('s1', {
      usage: pureRead,
      ok: true,
      isPing: false,
      kind: 'primary',
      unmanaged: true,
    });
    await h.flush();
    expect(h.engine.snapshot('s1')).toMatchObject({ skipReason: 'implicit', nextPingAt: null });
    expect(h.timerCount).toBe(0);
    await h.advance(60 * MIN);
    expect(h.pings).toHaveLength(0);
  });

  test('unmanaged on a title response leaves the session scheduled', async () => {
    const h = harness();
    h.engine.requestSent('s1', { requestedTtl: '1h', isPing: false, kind: 'primary' });
    await h.engine.responseObserved('s1', {
      usage: write1h,
      ok: true,
      isPing: false,
      kind: 'primary',
    });
    await h.engine.responseObserved('s1', {
      usage: write1h,
      ok: true,
      isPing: false,
      kind: 'title',
      unmanaged: true,
    });
    await h.flush();
    expect(h.engine.snapshot('s1')).toMatchObject({ skipReason: null, nextPingAt: 50 * MIN });
  });

  test('implicit is checked right after child', async () => {
    const h = harness({ child: true });
    await h.request('s1', pureRead, null);
    expect(h.engine.snapshot('s1').skipReason).toBe('child');
  });

  test('lastCache follows primary responses and ignores pings and other kinds', async () => {
    const h = harness();
    expect(h.engine.snapshot('s1').lastCache).toBeNull();
    await h.request('s1', write1h);
    expect(h.engine.snapshot('s1').lastCache).toEqual({ read: 0, total: 80_100 });
    await h.request('s1', pureRead);
    expect(h.engine.snapshot('s1').lastCache).toEqual({ read: 80_000, total: 80_100 });
    const small = { ...pureRead, cacheReadTokens: 500, inputTokens: 100 };
    for (const kind of ['title', 'generate', 'compaction'] as const) {
      await h.request('s1', small, '1h', { kind });
      expect(h.engine.snapshot('s1').lastCache).toEqual({ read: 80_000, total: 80_100 });
    }

    await h.request('s1', pureRead);
    await h.advance(50 * MIN);
    expect(h.pings).toHaveLength(1);
    expect(h.engine.snapshot('s1')).toMatchObject({
      lastPing: 'hit',
      lastCache: { read: 80_000, total: 80_100 },
    });
  });

  test('lastCache stays null for a response without tokens', async () => {
    const h = harness();
    await h.request('s1', { ...noCache, inputTokens: 0 });
    expect(h.engine.snapshot('s1').lastCache).toBeNull();
  });
});

describe('keepalive engine: requested TTL without a write breakdown', () => {
  const mixedWrite = { ...writeNoBreakdown };
  const readOnly: CacheUsage = {
    inputTokens: 100,
    cacheReadTokens: 80_000,
    cacheWriteTokens: 500,
    outputTokens: 0,
    write5mTokens: undefined,
    write1hTokens: undefined,
  };

  test('1h then 5m: the TTL and expiry follow the latest request', async () => {
    const h = harness();
    await h.request('s1', mixedWrite, '1h');
    expect(h.engine.snapshot('s1')).toMatchObject({
      ttl: '1h',
      ttlSource: 'requested',
      expiresAt: TTL_MS['1h'],
    });
    await h.advance(10 * MIN);
    await h.request('s1', readOnly, '5m');
    expect(h.engine.snapshot('s1')).toMatchObject({
      ttl: '5m',
      ttlSource: 'requested',
      expiresAt: 10 * MIN + TTL_MS['5m'],
    });
  });

  test('5m then 1h: the TTL and expiry follow the latest request', async () => {
    const h = harness();
    await h.request('s1', mixedWrite, '5m');
    expect(h.engine.snapshot('s1')).toMatchObject({ ttl: '5m', expiresAt: TTL_MS['5m'] });
    await h.advance(2 * MIN);
    await h.request('s1', readOnly, '1h');
    expect(h.engine.snapshot('s1')).toMatchObject({
      ttl: '1h',
      ttlSource: 'requested',
      expiresAt: 2 * MIN + TTL_MS['1h'],
    });
  });

  test('a detected TTL is not overridden by a later requested one', async () => {
    const h = harness();
    await h.request('s1', write1h, '1h');
    await h.request('s1', readOnly, '5m');
    expect(h.engine.snapshot('s1')).toMatchObject({ ttl: '1h', ttlSource: 'detected' });
  });
});

describe('keepalive engine: savings', () => {
  type H = ReturnType<typeof harness>;
  const callsOf = (h: H, name: string) => h.ledger.calls.filter(([call]) => call === name);
  const rescues = (h: H) => callsOf(h, 'stretchRescued');
  const priced = (ref: ModelRef = MODEL) => ({ ref, reportedModel: undefined });
  const hybridWrite: CacheUsage = {
    inputTokens: 100,
    cacheReadTokens: 0,
    cacheWriteTokens: 80_000,
    outputTokens: 0,
    write5mTokens: 60_000,
    write1hTokens: 20_000,
  };

  /** A 5m session at t=0 (context 80_100, original expiry 5m) with a hit ping at 4m. */
  async function pingedStretch(options: Parameters<typeof harness>[0] = {}) {
    const h = harness({ requestedTtl: '5m', ...options });
    await h.request('s1', write5m);
    await h.advance(4 * MIN);
    expect(h.engine.snapshot('s1').lastPing).toBe('hit');
    return h;
  }

  describe('rescued stretches', () => {
    test('a warm return after the original expiry counts its cache reads at the stretch TTL', async () => {
      const h = await pingedStretch();
      await h.advance(3 * MIN);
      await h.request('s1', pureRead);
      expect(rescues(h)).toEqual([['stretchRescued', 's1', priced(), 80_000, '5m', 80_100]]);
    });

    test('a return before the original expiry is no rescue', async () => {
      const h = await pingedStretch();
      await h.advance(MIN / 2);
      await h.request('s1', pureRead);
      expect(rescues(h)).toEqual([]);
    });

    test('a cold return is no rescue', async () => {
      const h = await pingedStretch();
      await h.advance(3 * MIN);
      await h.request('s1', miss);
      expect(rescues(h)).toEqual([]);
    });

    test('a rescue is priced with the model of the return response', async () => {
      const h = await pingedStretch();
      await h.advance(3 * MIN);
      h.engine.requestSent('s1', { requestedTtl: '5m', isPing: false, model: MODEL });
      await h.engine.responseObserved('s1', {
        usage: pureRead,
        ok: true,
        isPing: false,
        kind: 'primary',
        model: MODEL,
        reportedModel: 'claude-sonnet-5-5-20261001',
      });
      expect(rescues(h)).toEqual([
        [
          'stretchRescued',
          's1',
          { ref: MODEL, reportedModel: 'claude-sonnet-5-5-20261001' },
          80_000,
          '5m',
          80_100,
        ],
      ]);
    });

    test('a stretch whose only ping missed is no rescue', async () => {
      const h = harness({ requestedTtl: '5m' });
      await h.request('s1', write5m);
      h.queue.push({ kind: 'respond', usage: miss });
      await h.advance(4 * MIN);
      expect(h.engine.snapshot('s1').lastPing).toBe('miss');
      await h.advance(3 * MIN);
      await h.request('s1', pureRead);
      expect(rescues(h)).toEqual([]);
    });

    test('a stretch whose pings all failed is no rescue', async () => {
      const h = harness({ requestedTtl: '5m' });
      await h.request('s1', write5m);
      h.queue.push({ kind: 'reject' }, { kind: 'reject' });
      await h.advance(7 * MIN);
      expect(h.pings).toHaveLength(2);
      expect(h.engine.snapshot('s1').lastPing).toBe('failed');
      await h.request('s1', pureRead);
      expect(rescues(h)).toEqual([]);
    });

    test('a hit ping of an earlier stretch does not carry over', async () => {
      const h = await pingedStretch();
      await h.advance(MIN / 2);
      await h.request('s1', pureRead, '5m', { kind: 'title' });
      // After the original expiry, before the next ping.
      await h.advance(MIN);
      expect(h.pings).toHaveLength(1);
      await h.request('s1', pureRead);
      expect(rescues(h)).toEqual([]);
    });

    test('a return that fails is no rescue, and neither is the request after it', async () => {
      const h = await pingedStretch();
      await h.advance(3 * MIN);
      h.engine.requestSent('s1', { requestedTtl: '5m', isPing: false, model: MODEL });
      await h.engine.responseObserved('s1', {
        usage: undefined,
        ok: false,
        isPing: false,
        kind: 'primary',
        model: MODEL,
      });
      await h.request('s1', pureRead);
      expect(rescues(h)).toEqual([]);
    });

    test('a return overtaken by a second request before its response is no rescue', async () => {
      const h = await pingedStretch();
      await h.advance(3 * MIN);
      h.engine.requestSent('s1', { requestedTtl: '5m', isPing: false, model: MODEL });
      h.engine.requestSent('s1', { requestedTtl: '5m', isPing: false, model: MODEL });
      for (let i = 0; i < 2; i++) {
        await h.engine.responseObserved('s1', {
          usage: pureRead,
          ok: true,
          isPing: false,
          kind: 'primary',
          model: MODEL,
        });
      }
      expect(rescues(h)).toEqual([]);
    });

    test('a compaction can be the return', async () => {
      const h = await pingedStretch();
      await h.advance(3 * MIN);
      await h.request('s1', pureRead, '5m', { kind: 'compaction' });
      expect(rescues(h)).toEqual([['stretchRescued', 's1', priced(), 80_000, '5m', 80_100]]);
    });

    test('after a restart the first return is no rescue', async () => {
      const h = harness({ requestedTtl: '5m' });
      await h.advance(7 * MIN);
      await h.request('s1', pureRead);
      expect(h.ledger.calls).toEqual([]);
    });
  });

  describe('split caches', () => {
    test('Claude hybrid subtracts the 1h write', async () => {
      const h = harness({ requestedTtl: '5m' });
      await h.request('s1', hybridWrite, '5m', { split: true });
      await h.advance(MIN);
      // No 1h write on this turn: the prefix stays at 20_000.
      await h.request('s1', pureRead, '5m', { split: true });
      await h.advance(4 * MIN);
      expect(h.engine.snapshot('s1').lastPing).toBe('hit');
      await h.advance(3 * MIN);
      await h.request('s1', pureRead, '5m', { split: true });
      expect(rescues(h)).toEqual([['stretchRescued', 's1', priced(), 60_000, '5m', 80_100]]);
    });

    test('Claude hybrid keeps the largest 1h write when a later turn rewrites only part of it', async () => {
      const h = harness({ requestedTtl: '5m' });
      await h.request('s1', hybridWrite, '5m', { split: true });
      await h.advance(MIN);
      // A later system block changed: only its 2k segment is rewritten at 1h, then the messages at 5m.
      const partial: CacheUsage = {
        ...pureRead,
        cacheReadTokens: 18_000,
        cacheWriteTokens: 62_000,
        write1hTokens: 2000,
        write5mTokens: 60_000,
      };
      await h.request('s1', partial, '5m', { split: true });
      await h.advance(4 * MIN);
      expect(h.engine.snapshot('s1').lastPing).toBe('hit');
      await h.advance(3 * MIN);
      await h.request('s1', pureRead, '5m', { split: true });
      expect(rescues(h)).toEqual([['stretchRescued', 's1', priced(), 60_000, '5m', 80_100]]);
    });

    test('Claude hybrid without any 1h write seen is no rescue', async () => {
      const h = await pingedStretch();
      await h.advance(3 * MIN);
      await h.request('s1', pureRead, '5m', { split: true });
      expect(rescues(h)).toEqual([]);
    });

    test('a split stretch stays split when the return is not', async () => {
      const h = harness({ requestedTtl: '5m' });
      await h.request('s1', write5m, '5m', { split: true });
      await h.advance(7 * MIN);
      await h.request('s1', pureRead, '5m', { split: false });
      expect(rescues(h)).toEqual([]);
    });

    test('OpenAI hybrid never takes a zero context as the prefix', async () => {
      const h = harness({ requestedTtl: '30m', settings: { minContextTokens: 0 } });
      const empty: CacheUsage = {
        ...writeNoBreakdown,
        inputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
      };
      await h.request('s1', empty, '30m', { split: true });
      await h.advance(MIN);
      await h.request('s1', writeNoBreakdown, '30m', { split: true });
      await h.advance(25 * MIN);
      expect(h.engine.snapshot('s1').lastPing).toBe('hit');
      await h.advance(14 * MIN);
      await h.request('s1', hit, '30m', { split: true });
      expect(rescues(h)).toEqual([]);
    });

    test('OpenAI hybrid subtracts the context of the first primary response', async () => {
      const h = harness({ requestedTtl: '30m', settings: { minContextTokens: 0 } });
      const first: CacheUsage = {
        ...writeNoBreakdown,
        inputTokens: 1000,
        cacheWriteTokens: 30_000,
      };
      await h.request('s1', first, '30m', { split: true });
      await h.advance(MIN);
      await h.request('s1', writeNoBreakdown, '30m', { split: true });
      await h.advance(25 * MIN);
      expect(h.engine.snapshot('s1').lastPing).toBe('hit');
      await h.advance(14 * MIN);
      await h.request('s1', hit, '30m', { split: true });
      expect(rescues(h)).toEqual([
        ['stretchRescued', 's1', priced(), 80_100 - 31_000, '30m', 80_200],
      ]);
    });
  });

  describe('ping cost', () => {
    test('a hit and a miss ping are both charged at the stretch TTL', async () => {
      const h = harness({ requestedTtl: '5m' });
      await h.request('s1', write5m);
      h.queue.push({ kind: 'respond', usage: hit }, { kind: 'respond', usage: miss });
      await h.advance(8 * MIN);
      expect(callsOf(h, 'pingCharged')).toEqual([
        ['pingCharged', 's1', priced(), hit, '5m'],
        ['pingCharged', 's1', priced(), miss, '5m'],
      ]);
    });

    test('a failed ping without usage is not charged', async () => {
      const h = harness({ requestedTtl: '5m' });
      await h.request('s1', write5m);
      h.queue.push({ kind: 'reject' }, { kind: 'notok-then-reject' });
      await h.advance(5 * MIN);
      expect(h.pings).toHaveLength(2);
      expect(callsOf(h, 'pingCharged')).toEqual([]);
    });

    test('a ping answered after a real request is still charged, but its hit does not count', async () => {
      const h = harness({ requestedTtl: '5m' });
      await h.request('s1', write5m);
      h.queue.push({ kind: 'hold' });
      await h.advance(4 * MIN);
      await h.request('s1', pureRead);
      h.held.shift()?.();
      await h.flush();
      expect(callsOf(h, 'pingCharged')).toEqual([['pingCharged', 's1', priced(), hit, '5m']]);
      await h.advance(MIN + MIN / 2);
      await h.request('s1', pureRead);
      expect(rescues(h)).toEqual([]);
    });

    test('a real request after a charged ping starts a new stretch, in event order', async () => {
      const h = harness({ requestedTtl: '5m' });
      await h.request('s1', write5m);
      await h.request('s1', pureRead);
      expect(callsOf(h, 'stretchStarted')).toEqual([]);
      await h.advance(4 * MIN);
      await h.request('s1', pureRead);
      await h.request('s1', pureRead);
      expect(h.ledger.calls.map(([call]) => call)).toEqual(['pingCharged', 'stretchStarted']);
    });

    test('child and implicit sessions make no ledger calls and load no ledger', async () => {
      const h = harness({ child: true });
      await h.request('s1', write1h);
      await h.advance(60 * MIN);
      await h.request('s1', pureRead);
      await h.request('s2', write1h, null);
      await h.request('s2', pureRead, null);
      expect(h.pings).toHaveLength(0);
      expect(h.ledger.calls).toEqual([]);
      expect(h.ledger.readoutCalls).toEqual([]);
      expect(h.engine.snapshot('s1').savings).toBeNull();
    });
  });

  describe('snapshot', () => {
    const readout: SavingsReadout = {
      priced: true,
      pings: 2,
      rescues: 1,
      avoidedTokens: 80_000,
      netUsd: 0.12,
      returnRatio: 4,
      stretchUsd: 0.01,
    };

    test('showSavings follows the savings setting', async () => {
      const on = harness();
      await on.request('s1', write1h);
      expect(on.engine.snapshot('s1').showSavings).toBe(true);
      const off = harness({ settings: { savings: false } });
      await off.request('s1', write1h);
      expect(off.engine.snapshot('s1').showSavings).toBe(false);
    });

    test('with savings off the ledger is not read, and turning it on reads it again', async () => {
      const h = harness({ settings: { savings: false } });
      h.ledger.setReadout(readout);
      await h.request('s1', write1h);
      expect(h.engine.snapshot('s1').savings).toBeNull();
      expect(h.ledger.readoutCalls).toEqual([]);
      h.settings.savings = true;
      await h.engine.reevaluate('s1');
      expect(h.engine.snapshot('s1')).toMatchObject({ showSavings: true, savings: readout });
    });

    test('savings is the ledger readout of a managed session', async () => {
      const h = harness();
      await h.request('s1', write1h);
      expect(h.engine.snapshot('s1').savings).toBeNull();
      h.ledger.setReadout(readout);
      expect(h.engine.snapshot('s1').savings).toEqual(readout);
      expect(h.ledger.readoutCalls).toContain('s1');
    });

    test('refresh emits only when the readout changed', async () => {
      const h = harness();
      await h.request('s1', write1h);
      const before = h.changes.length;
      h.engine.refresh('s1');
      expect(h.changes).toHaveLength(before);
      h.ledger.setReadout(readout);
      h.engine.refresh('s1');
      expect(h.changes).toHaveLength(before + 1);
      expect(h.changes.at(-1)?.savings).toEqual(readout);
      h.engine.refresh('s1');
      expect(h.changes).toHaveLength(before + 1);
    });

    test('refresh of an unknown session does nothing', () => {
      const h = harness();
      h.engine.refresh('nope');
      expect(h.changes).toEqual([]);
      expect(h.ledger.readoutCalls).toEqual([]);
    });
  });
});
