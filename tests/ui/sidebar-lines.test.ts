import { describe, expect, test } from 'bun:test';

import type { KeepaliveSnapshot } from '../../src/models/keepalive.ts';
import { sidebarLines, type SidebarLine } from '../../src/ui/sidebar-lines.ts';

const NOW = 1_000_000_000;
const MIN = 60_000;
const clock = (_ms: number) => 'HH:MM';

function snap(overrides: Partial<KeepaliveSnapshot> = {}): KeepaliveSnapshot {
  return {
    sessionID: 'ses_1',
    ttl: '5m',
    ttlSource: 'detected',
    lastRequestAt: NOW - MIN,
    expiresAt: NOW + 4 * MIN,
    nextPingAt: null,
    pingsUsed: 0,
    maxPings: 5,
    minContextTokens: 50_000,
    lastPing: null,
    skipReason: null,
    contextTokens: 80_000,
    lastCache: null,
    ...overrides,
  };
}

const lines = (s: KeepaliveSnapshot | undefined): SidebarLine[] => sidebarLines(s, NOW, clock);

const TITLE: SidebarLine = { text: 'Cache', tone: 'base', bold: true };
const WARM: SidebarLine[] = [
  { text: 'status', tone: 'base', bullet: 'success', right: 'warm' },
  { text: 'expires', tone: 'base', right: 'HH:MM (4m)' },
];
const TTL: SidebarLine = { text: 'ttl', tone: 'base', right: '5m (detected)' };
const HEADER: SidebarLine[] = [TITLE, ...WARM, TTL];
const noResponse = {
  ttl: null,
  ttlSource: null,
  expiresAt: null,
  skipReason: 'no-cache-seen',
} as const;

describe('sidebarLines', () => {
  const WAITING: SidebarLine[] = [TITLE, { text: 'waiting for first response', tone: 'muted' }];

  test('waits without a snapshot, e.g. right after a restart', () => {
    expect(lines(undefined)).toEqual(WAITING);
  });

  test('waits before any request was sent', () => {
    expect(lines(snap({ ...noResponse, lastRequestAt: null, contextTokens: null }))).toEqual(
      WAITING
    );
  });

  test('renders nothing for child sessions', () => {
    expect(lines(snap({ skipReason: 'child' }))).toEqual([]);
  });

  test('renders nothing when a response arrived without cache activity', () => {
    expect(lines(snap({ ...noResponse, contextTokens: 1_200 }))).toEqual([]);
  });

  test('shows a waiting line while the first response is outstanding', () => {
    expect(lines(snap({ ...noResponse, contextTokens: null }))).toEqual(WAITING);
  });

  test('status row comes first, then the ttl row', () => {
    expect(lines(snap({ ttl: '1h', ttlSource: 'requested' })).slice(0, 4)).toEqual([
      TITLE,
      ...WARM,
      { text: 'ttl', tone: 'base', right: '1h (requested)' },
    ]);
  });

  test.each(['30m', '12h'] as const)(
    'the ttl row shows the OpenAI lifetime %s as requested',
    (ttl) => {
      expect(
        lines(snap({ ttl, ttlSource: 'requested' })).find((line) => line.text === 'ttl')
      ).toEqual({
        text: 'ttl',
        tone: 'base',
        right: `${ttl} (requested)`,
      });
    }
  );

  test('an expired cache shows an error status and the ttl row only', () => {
    expect(
      lines(snap({ expiresAt: NOW - 5 * MIN, skipReason: 'missed', nextPingAt: NOW + 1 }))
    ).toEqual([
      TITLE,
      { text: 'status', tone: 'base', bullet: 'error', right: 'expired' },
      { text: 'expired', tone: 'base', right: '5m ago' },
      TTL,
    ]);
    expect(lines(snap({ expiresAt: NOW }))[2]).toEqual({
      text: 'expired',
      tone: 'base',
      right: '0s ago',
    });
  });

  test('warm with a scheduled ping', () => {
    expect(lines(snap({ nextPingAt: NOW + 3 * MIN, pingsUsed: 0 }))).toEqual([
      ...HEADER,
      { text: 'next ping', tone: 'base', right: 'HH:MM (3m)' },
      { text: 'pings', tone: 'base', right: '0/5' },
    ]);
  });

  test('pings row ticks on a hit, and flags a miss or failure', () => {
    const base = { nextPingAt: NOW + MIN, pingsUsed: 2 };
    expect(lines(snap({ ...base, lastPing: 'hit' }))[5]).toEqual({
      text: 'pings',
      tone: 'base',
      right: '2/5 ✓ hit',
      rightTone: 'success',
    });
    expect(lines(snap({ ...base, lastPing: 'miss' }))[5]).toEqual({
      text: 'pings',
      tone: 'base',
      right: '2/5 ✗ miss',
      rightTone: 'error',
    });
    expect(lines(snap({ ...base, lastPing: 'failed' }))[5]).toEqual({
      text: 'pings',
      tone: 'base',
      right: '2/5 ✗ failed',
      rightTone: 'error',
    });
  });

  test('a failed ping with nothing scheduled still shows the pings row', () => {
    expect(lines(snap({ pingsUsed: 1, lastPing: 'failed' }))).toEqual([
      ...HEADER,
      { text: 'pings', tone: 'base', right: '1/5 ✗ failed', rightTone: 'error' },
    ]);
  });

  test('exhausted pings turn the status to a warning and show next ping none', () => {
    expect(lines(snap({ skipReason: 'exhausted', pingsUsed: 5, lastPing: 'hit' }))).toEqual([
      TITLE,
      { ...WARM[0], bullet: 'warning' },
      WARM[1],
      TTL,
      { text: 'next ping', tone: 'base', right: 'none' },
      { text: 'pings', tone: 'base', right: '5/5 ✓ hit', rightTone: 'success' },
    ]);
  });

  test('small context explains why keepalive is off', () => {
    expect(lines(snap({ skipReason: 'small-context', contextTokens: 31_000 }))).toEqual([
      ...HEADER,
      { text: 'keepalive', tone: 'base', right: 'off · 31k < 50k' },
    ]);
  });

  test('small context rounds thousands to the nearest k', () => {
    expect(
      lines(
        snap({ skipReason: 'small-context', contextTokens: 30_600, minContextTokens: 49_600 })
      )[4].right
    ).toBe('off · 31k < 50k');
  });

  test('disabled keepalive', () => {
    expect(lines(snap({ skipReason: 'disabled' }))).toEqual([
      ...HEADER,
      { text: 'keepalive', tone: 'base', right: 'off · disabled' },
    ]);
  });

  test('a missed ping stops keepalive', () => {
    expect(lines(snap({ skipReason: 'missed', pingsUsed: 1, lastPing: 'miss' }))).toEqual([
      ...HEADER,
      { text: 'keepalive', tone: 'base', right: 'stopped · last ping missed', rightTone: 'error' },
    ]);
  });

  test('a busy session is waiting rather than pinged', () => {
    expect(lines(snap({ skipReason: 'busy' }))).toEqual([
      ...HEADER,
      { text: 'keepalive', tone: 'base', right: 'waiting · session busy' },
    ]);
  });

  test('uses the injected clock for HH:MM', () => {
    const seen: number[] = [];
    sidebarLines(snap({ nextPingAt: NOW + 3 * MIN }), NOW, (ms) => (seen.push(ms), '09:05'));
    expect(seen).toEqual([NOW + 4 * MIN, NOW + 3 * MIN]);
  });

  test('default clock renders local 24h HH:MM', () => {
    const out = sidebarLines(snap(), NOW);
    expect(out[2].right).toMatch(/^\d{2}:\d{2} \(4m\)$/);
  });
});

describe('sidebarLines: cached line', () => {
  const cache = { read: 14_000, total: 16_000 };
  const CACHED: SidebarLine = { text: 'cached', tone: 'base', right: '87% · 14k / 16k' };

  test('sits directly under status on a warm cache', () => {
    const out = lines(snap({ lastCache: cache }));
    expect(out.slice(0, 4)).toEqual([TITLE, WARM[0], CACHED, WARM[1]]);
  });

  test('sits directly under status on an expired cache', () => {
    const out = lines(snap({ lastCache: cache, expiresAt: NOW - MIN }));
    expect(out[1].right).toBe('expired');
    expect(out[2]).toEqual(CACHED);
  });

  test('follows the ttl row when no expiry is known yet', () => {
    expect(lines(snap({ lastCache: cache, expiresAt: null }))).toEqual([TITLE, TTL, CACHED]);
  });

  test('a near-total read never rounds up to 100%', () => {
    const out = lines(snap({ lastCache: { read: 9_960, total: 10_000 } }));
    expect(out[2]?.right).toBe('99% · 10k / 10k');
  });

  test('a null lastCache adds no cached line', () => {
    expect(lines(snap()).some((l) => l.text === 'cached')).toBe(false);
  });

  test('shows a zero hit rate', () => {
    const out = lines(snap({ lastCache: { read: 0, total: 16_100 } }));
    expect(out[2]).toEqual({ text: 'cached', tone: 'base', right: '0% · 0 / 16.1k' });
  });

  test('formats the percentage and counts compactly', () => {
    const out = lines(snap({ lastCache: { read: 14_800, total: 16_100 } }));
    expect(out[2]).toEqual({ text: 'cached', tone: 'base', right: '91% · 14.8k / 16.1k' });
  });
});

describe('sidebarLines: implicit sessions', () => {
  const implicit = {
    ttl: null,
    ttlSource: null,
    expiresAt: null,
    nextPingAt: null,
    skipReason: 'implicit',
  } as const;
  const KEEPALIVE: SidebarLine = { text: 'keepalive', tone: 'base', right: 'n/a · implicit cache' };

  test('shows cached and an n/a keepalive row', () => {
    expect(lines(snap({ ...implicit, lastCache: { read: 14_000, total: 16_000 } }))).toEqual([
      TITLE,
      { text: 'cached', tone: 'base', right: '87% · 14k / 16k' },
      KEEPALIVE,
    ]);
  });

  test('shows only the n/a keepalive row after a request whose response reported no usage', () => {
    expect(lines(snap(implicit))).toEqual([TITLE, KEEPALIVE]);
  });

  test('waits for the first response while no request has been sent', () => {
    expect(lines(snap({ ...implicit, lastRequestAt: null }))).toEqual([
      TITLE,
      { text: 'waiting for first response', tone: 'muted' },
    ]);
  });

  test('renders nothing for a child session', () => {
    expect(lines(snap({ ...implicit, skipReason: 'child' }))).toEqual([]);
  });
});
