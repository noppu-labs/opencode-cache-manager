import type { KeepaliveSnapshot } from '../models/keepalive.ts';
import { formatCompactTokens, formatRemaining } from '../utils/format.ts';

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

const defaultClock = (ms: number): string =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', hour12: false, minute: '2-digit' });

const thousands = (tokens: number): string => `${Math.round(tokens / 1000)}k`;

function cachedLine(cache: NonNullable<KeepaliveSnapshot['lastCache']>): SidebarLine {
  const ratio = (cache.read / cache.total) * 100;
  const percent = cache.read < cache.total ? Math.floor(ratio) : Math.round(ratio);
  return {
    right: `${percent}% · ${formatCompactTokens(cache.read)} / ${formatCompactTokens(cache.total)}`,
    text: 'cached',
    tone: 'base',
  };
}

/** Lines for the sidebar cache section; an empty array means render nothing. */
function sidebarLines(
  s: KeepaliveSnapshot | undefined,
  now: number,
  formatClock: (ms: number) => string = defaultClock
): SidebarLine[] {
  const waiting: SidebarLine[] = [HEADER, { text: 'waiting for first response', tone: 'muted' }];
  // No snapshot yet (e.g. after a restart) still shows the section, so the user can see the plugin is there.
  if (s === undefined || s.lastRequestAt === null) return waiting;
  if (s.skipReason === 'child') return [];
  if (s.skipReason === 'implicit') {
    const keepalive: SidebarLine = {
      right: 'n/a · implicit cache',
      text: 'keepalive',
      tone: 'base',
    };
    return s.lastCache === null
      ? [HEADER, keepalive]
      : [HEADER, cachedLine(s.lastCache), keepalive];
  }
  if (s.skipReason === 'no-cache-seen' && s.contextTokens !== null) return [];
  if (s.ttl === null) return waiting;

  const ttl: SidebarLine = { right: `${s.ttl} (${s.ttlSource})`, text: 'ttl', tone: 'base' };
  const cached: SidebarLine[] = s.lastCache === null ? [] : [cachedLine(s.lastCache)];
  if (s.expiresAt === null) return [HEADER, ttl, ...cached];

  if (now >= s.expiresAt) {
    return [
      HEADER,
      { bullet: 'error', right: 'expired', text: 'status', tone: 'base' },
      ...cached,
      { right: `${formatRemaining(now - s.expiresAt)} ago`, text: 'expired', tone: 'base' },
      ttl,
    ];
  }
  const lines: SidebarLine[] = [
    HEADER,
    {
      bullet: s.skipReason === 'exhausted' ? 'warning' : 'success',
      right: 'warm',
      text: 'status',
      tone: 'base',
    },
    ...cached,
    {
      right: `${formatClock(s.expiresAt)} (${formatRemaining(s.expiresAt - now)})`,
      text: 'expires',
      tone: 'base',
    },
    ttl,
  ];

  if (s.skipReason === 'missed') {
    lines.push({
      right: 'stopped · last ping missed',
      rightTone: 'error',
      text: 'keepalive',
      tone: 'base',
    });
  } else if (s.skipReason === 'busy') {
    lines.push({ right: 'waiting · session busy', text: 'keepalive', tone: 'base' });
  } else if (s.skipReason === 'small-context') {
    lines.push({
      right: `off · ${thousands(s.contextTokens ?? 0)} < ${thousands(s.minContextTokens)}`,
      text: 'keepalive',
      tone: 'base',
    });
  } else if (s.skipReason === 'disabled') {
    lines.push({ right: 'off · disabled', text: 'keepalive', tone: 'base' });
  } else {
    if (s.nextPingAt !== null) {
      lines.push({
        right: `${formatClock(s.nextPingAt)} (${formatRemaining(s.nextPingAt - now)})`,
        text: 'next ping',
        tone: 'base',
      });
    } else if (s.skipReason === 'exhausted') {
      lines.push({ right: 'none', text: 'next ping', tone: 'base' });
    }
    const outcome =
      s.lastPing === 'hit'
        ? ' ✓ hit'
        : s.lastPing === 'miss'
          ? ' ✗ miss'
          : s.lastPing === 'failed'
            ? ' ✗ failed'
            : '';
    const pings: SidebarLine = {
      right: `${s.pingsUsed}/${s.maxPings}${outcome}`,
      text: 'pings',
      tone: 'base',
    };
    if (s.lastPing !== null) pings.rightTone = s.lastPing === 'hit' ? 'success' : 'error';
    lines.push(pings);
  }
  return lines;
}

export type { Tone, SidebarLine };
export { LABEL_WIDTH, SECTION_HEADER, sidebarLines };
