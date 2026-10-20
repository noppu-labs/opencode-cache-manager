import { describe, expect, test } from "bun:test";
import { formatRemaining, sidebarLines, type SidebarLine } from "../display.ts";
import type { KeepaliveSnapshot } from "../keepalive.ts";

const NOW = 1_000_000_000;
const MIN = 60_000;
const clock = (_ms: number) => "HH:MM";

function snap(overrides: Partial<KeepaliveSnapshot> = {}): KeepaliveSnapshot {
  return {
    sessionID: "ses_1",
    ttl: "5m",
    ttlSource: "detected",
    lastRequestAt: NOW - MIN,
    expiresAt: NOW + 4 * MIN,
    nextPingAt: null,
    pingsUsed: 0,
    maxPings: 5,
    minContextTokens: 50_000,
    lastPing: null,
    skipReason: null,
    contextTokens: 80_000,
    ...overrides,
  };
}

const lines = (s: KeepaliveSnapshot | undefined): SidebarLine[] => sidebarLines(s, NOW, clock);

const TITLE: SidebarLine = { text: "Cache", tone: "base", bold: true };
const HEADER: SidebarLine[] = [TITLE, { text: "ttl", tone: "base", right: "5m (detected)" }];
const noResponse = {
  ttl: null,
  ttlSource: null,
  expiresAt: null,
  skipReason: "no-cache-seen",
} as const;

describe("formatRemaining", () => {
  test("minutes, seconds and hours", () => {
    expect(formatRemaining(3_120_000)).toBe("52m");
    expect(formatRemaining(3 * MIN)).toBe("3m");
    expect(formatRemaining(45_000)).toBe("45s");
    expect(formatRemaining(3_900_000)).toBe("1h 05m");
    expect(formatRemaining(2 * 3_600_000)).toBe("2h 00m");
  });

  test("clamps negative durations to zero seconds", () => {
    expect(formatRemaining(-5)).toBe("0s");
  });
});

describe("sidebarLines", () => {
  const WAITING: SidebarLine[] = [TITLE, { text: "waiting for first response", tone: "muted" }];

  test("waits without a snapshot, e.g. right after a restart", () => {
    expect(lines(undefined)).toEqual(WAITING);
  });

  test("waits before any request was sent", () => {
    expect(lines(snap({ ...noResponse, lastRequestAt: null, contextTokens: null }))).toEqual(WAITING);
  });

  test("renders nothing for child sessions", () => {
    expect(lines(snap({ skipReason: "child" }))).toEqual([]);
  });

  test("renders nothing when a response arrived without cache activity", () => {
    expect(lines(snap({ ...noResponse, contextTokens: 1_200 }))).toEqual([]);
  });

  test("shows a waiting line while the first response is outstanding", () => {
    expect(lines(snap({ ...noResponse, contextTokens: null }))).toEqual(WAITING);
  });

  test("header is a bold title and a two-column ttl row", () => {
    expect(lines(snap({ ttl: "1h", ttlSource: "requested" })).slice(0, 2)).toEqual([
      TITLE,
      { text: "ttl", tone: "base", right: "1h (requested)" },
    ]);
  });

  test("an expired cache shows only the header and an error line", () => {
    expect(lines(snap({ expiresAt: NOW - 5 * MIN, skipReason: "missed", nextPingAt: NOW + 1 }))).toEqual([
      ...HEADER,
      { text: "○ expired 5m ago", tone: "error" },
    ]);
    expect(lines(snap({ expiresAt: NOW }))[2]).toEqual({ text: "○ expired 0s ago", tone: "error" });
  });

  test("warm with a scheduled ping", () => {
    expect(lines(snap({ nextPingAt: NOW + 3 * MIN, pingsUsed: 0 }))).toEqual([
      ...HEADER,
      { text: "● warm, expires HH:MM (4m)", tone: "success" },
      { text: "  next ping   HH:MM (3m)", tone: "muted" },
      { text: "  pings       0/5", tone: "muted" },
    ]);
  });

  test("pings line ticks on a hit, and flags a miss or failure", () => {
    const base = { nextPingAt: NOW + MIN, pingsUsed: 2 };
    expect(lines(snap({ ...base, lastPing: "hit" }))[4]).toEqual({ text: "  pings       2/5 ✓ hit", tone: "success" });
    expect(lines(snap({ ...base, lastPing: "miss" }))[4]).toEqual({ text: "  pings       2/5 ✗ miss", tone: "error" });
    expect(lines(snap({ ...base, lastPing: "failed" }))[4]).toEqual({ text: "  pings       2/5 ✗ failed", tone: "error" });
  });

  test("a failed ping with nothing scheduled still shows the pings line", () => {
    expect(lines(snap({ pingsUsed: 1, lastPing: "failed" }))).toEqual([
      ...HEADER,
      { text: "● warm, expires HH:MM (4m)", tone: "success" },
      { text: "  pings       1/5 ✗ failed", tone: "error" },
    ]);
  });

  test("exhausted pings turn the warm line to a warning and show next ping none", () => {
    expect(lines(snap({ skipReason: "exhausted", pingsUsed: 5, lastPing: "hit" }))).toEqual([
      ...HEADER,
      { text: "● warm, expires HH:MM (4m)", tone: "warning" },
      { text: "  next ping   none", tone: "muted" },
      { text: "  pings       5/5 ✓ hit", tone: "success" },
    ]);
  });

  test("small context explains why keepalive is off", () => {
    expect(lines(snap({ skipReason: "small-context", contextTokens: 31_000 }))).toEqual([
      ...HEADER,
      { text: "● warm, expires HH:MM (4m)", tone: "success" },
      { text: "  keepalive   off · 31k < 50k", tone: "muted" },
    ]);
  });

  test("small context rounds thousands to the nearest k", () => {
    expect(lines(snap({ skipReason: "small-context", contextTokens: 30_600, minContextTokens: 49_600 }))[3]!.text).toBe(
      "  keepalive   off · 31k < 50k",
    );
  });

  test("disabled keepalive", () => {
    expect(lines(snap({ skipReason: "disabled" }))).toEqual([
      ...HEADER,
      { text: "● warm, expires HH:MM (4m)", tone: "success" },
      { text: "  keepalive   off · disabled", tone: "muted" },
    ]);
  });

  test("a missed ping stops keepalive", () => {
    expect(lines(snap({ skipReason: "missed", pingsUsed: 1, lastPing: "miss" }))).toEqual([
      ...HEADER,
      { text: "● warm, expires HH:MM (4m)", tone: "success" },
      { text: "  keepalive stopped · last ping missed", tone: "error" },
    ]);
  });

  test("a busy session is waiting rather than pinged", () => {
    expect(lines(snap({ skipReason: "busy" }))).toEqual([
      ...HEADER,
      { text: "● warm, expires HH:MM (4m)", tone: "success" },
      { text: "  keepalive   waiting · session busy", tone: "muted" },
    ]);
  });

  test("uses the injected clock for HH:MM", () => {
    const seen: number[] = [];
    sidebarLines(snap({ nextPingAt: NOW + 3 * MIN }), NOW, (ms) => (seen.push(ms), "09:05"));
    expect(seen).toEqual([NOW + 4 * MIN, NOW + 3 * MIN]);
  });

  test("default clock renders local 24h HH:MM", () => {
    const out = sidebarLines(snap(), NOW);
    expect(out[2]!.text).toMatch(/^● warm, expires \d{2}:\d{2} \(4m\)$/);
  });
});
