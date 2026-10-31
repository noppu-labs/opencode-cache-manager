import { PERCENT, THOUSAND } from '../constants/units.ts';
import type { KeepaliveSnapshot } from '../models/keepalive.ts';
import {
  formatCompactTokens,
  formatMultiple,
  formatRemaining,
  formatUsd,
} from '../utils/format.ts';

type Tone = 'base' | 'muted' | 'success' | 'warning' | 'error';
interface SidebarLine {
  text: string;
  tone: Tone;
  bold?: boolean;
  /** Prefix the row with a bullet in this tone; other rows are indented to match. */
  bullet?: Tone;
  /** Value column, left-aligned after the padded label; muted unless `rightTone` is set. */
  right?: string;
  rightTone?: Tone;
}

/** Width of the label column (bullet/indent plus label), so values line up across rows. */
const LABEL_WIDTH = 14;

const SECTION_HEADER = 'Cache';
const HEADER: SidebarLine = { bold: true, text: SECTION_HEADER, tone: 'base' };

/** Suffix of the pings row for the last ping's outcome. */
const PING_OUTCOMES: Record<NonNullable<KeepaliveSnapshot['lastPing']>, string> = {
  failed: ' ✗ failed',
  hit: ' ✓ hit',
  miss: ' ✗ miss',
};

const defaultClock = (ms: number): string =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', hour12: false, minute: '2-digit' });

const thousands = (tokens: number): string => `${Math.round(tokens / THOUSAND)}k`;

function cachedLine(cache: NonNullable<KeepaliveSnapshot['lastCache']>): SidebarLine {
  const ratio = (cache.read / cache.total) * PERCENT;
  const percent = cache.read < cache.total ? Math.floor(ratio) : Math.round(ratio);
  return {
    right: `${percent}% · ${formatCompactTokens(cache.read)} / ${formatCompactTokens(cache.total)}`,
    text: 'cached',
    tone: 'base',
  };
}

/** The keepalive rows of a warm cache: why pings stopped, or the next ping and the pings used so far. */
function keepaliveRows(
  snapshot: KeepaliveSnapshot,
  now: number,
  formatClock: (ms: number) => string
): SidebarLine[] {
  if (snapshot.skipReason === 'missed') {
    return [
      { right: 'stopped · last ping missed', rightTone: 'error', text: 'keepalive', tone: 'base' },
    ];
  }
  if (snapshot.skipReason === 'busy') {
    return [{ right: 'waiting · session busy', text: 'keepalive', tone: 'base' }];
  }
  if (snapshot.skipReason === 'small-context') {
    return [
      {
        right: `off · ${thousands(snapshot.contextTokens ?? 0)} < ${thousands(snapshot.minContextTokens)}`,
        text: 'keepalive',
        tone: 'base',
      },
    ];
  }
  if (snapshot.skipReason === 'disabled') {
    return [{ right: 'off · disabled', text: 'keepalive', tone: 'base' }];
  }
  return pingLines(snapshot, now, formatClock);
}

/** The session's `saved` and `return` rows; empty when hidden, not loaded, or before the first ping. */
function keepaliveLines(
  snapshot: KeepaliveSnapshot,
  now: number,
  formatClock: (ms: number) => string
): SidebarLine[] {
  return [...keepaliveRows(snapshot, now, formatClock), ...savingsLines(snapshot)];
}

function savingsLines(snapshot: KeepaliveSnapshot): SidebarLine[] {
  const { savings } = snapshot;
  if (!snapshot.showSavings || savings === null || savings.pings === 0) return [];
  if (savings.rescues === 0) return [{ right: 'nothing yet', text: 'saved', tone: 'base' }];
  const rewrites = `${savings.rescues} ${savings.rescues === 1 ? 'rewrite' : 'rewrites'}`;
  const saved =
    savings.priced && savings.netUsd !== null
      ? `${formatUsd(savings.netUsd)} · ${rewrites}`
      : `${rewrites} · ${formatCompactTokens(savings.avoidedTokens)}`;
  const lines: SidebarLine[] = [{ right: saved, text: 'saved', tone: 'base' }];
  if (savings.returnRatio !== null) {
    lines.push({
      right: `${formatMultiple(savings.returnRatio)} ping cost`,
      text: 'return',
      tone: 'base',
    });
  }
  return lines;
}

/** The ` ($0.05)` cost of the current stretch's pings; empty when hidden or unpriced. */
function stretchCost(snapshot: KeepaliveSnapshot): string {
  const { savings } = snapshot;
  if (!snapshot.showSavings || savings === null || !savings.priced) return '';
  return savings.stretchUsd === null ? '' : ` (${formatUsd(savings.stretchUsd)})`;
}

function pingLines(
  snapshot: KeepaliveSnapshot,
  now: number,
  formatClock: (ms: number) => string
): SidebarLine[] {
  const lines: SidebarLine[] = [];
  if (snapshot.nextPingAt !== null) {
    lines.push({
      right: `${formatClock(snapshot.nextPingAt)} (${formatRemaining(snapshot.nextPingAt - now)})`,
      text: 'next ping',
      tone: 'base',
    });
  } else if (snapshot.skipReason === 'exhausted') {
    lines.push({ right: 'none', text: 'next ping', tone: 'base' });
  }
  const outcome = snapshot.lastPing === null ? '' : PING_OUTCOMES[snapshot.lastPing];
  const pings: SidebarLine = {
    right: `${snapshot.pingsUsed}/${snapshot.maxPings}${outcome}${stretchCost(snapshot)}`,
    text: 'pings',
    tone: 'base',
  };
  if (snapshot.lastPing !== null) {
    pings.rightTone = snapshot.lastPing === 'hit' ? 'success' : 'error';
  }
  lines.push(pings);
  return lines;
}

/** Lines for the sidebar cache section; an empty array means render nothing. */
function sidebarLines(
  snapshot: KeepaliveSnapshot | undefined,
  now: number,
  formatClock: (ms: number) => string = defaultClock
): SidebarLine[] {
  const waiting: SidebarLine[] = [HEADER, { text: 'waiting for first response', tone: 'muted' }];
  // No snapshot yet (e.g. after a restart) still shows the section, so the user can see the plugin is there.
  if (snapshot === undefined || snapshot.lastRequestAt === null) return waiting;
  if (snapshot.skipReason === 'child') return [];
  if (snapshot.skipReason === 'implicit') {
    const keepalive: SidebarLine = {
      right: 'n/a · implicit cache',
      text: 'keepalive',
      tone: 'base',
    };
    return snapshot.lastCache === null
      ? [HEADER, keepalive]
      : [HEADER, cachedLine(snapshot.lastCache), keepalive];
  }
  if (snapshot.skipReason === 'no-cache-seen' && snapshot.contextTokens !== null) return [];
  if (snapshot.ttl === null) return waiting;

  const ttl: SidebarLine = {
    right: `${snapshot.ttl} (${snapshot.ttlSource})`,
    text: 'ttl',
    tone: 'base',
  };
  const cached: SidebarLine[] = snapshot.lastCache === null ? [] : [cachedLine(snapshot.lastCache)];
  if (snapshot.expiresAt === null) return [HEADER, ttl, ...cached];

  if (now >= snapshot.expiresAt) {
    return [
      HEADER,
      { bullet: 'error', right: 'expired', text: 'status', tone: 'base' },
      ...cached,
      { right: `${formatRemaining(now - snapshot.expiresAt)} ago`, text: 'expired', tone: 'base' },
      ttl,
      ...savingsLines(snapshot),
    ];
  }
  return [
    HEADER,
    {
      bullet: snapshot.skipReason === 'exhausted' ? 'warning' : 'success',
      right: 'warm',
      text: 'status',
      tone: 'base',
    },
    ...cached,
    {
      right: `${formatClock(snapshot.expiresAt)} (${formatRemaining(snapshot.expiresAt - now)})`,
      text: 'expires',
      tone: 'base',
    },
    ttl,
    ...keepaliveLines(snapshot, now, formatClock),
  ];
}

export type { Tone, SidebarLine };
export { LABEL_WIDTH, SECTION_HEADER, sidebarLines };
