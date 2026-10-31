/** @jsxImportSource @opentui/solid */
/* oxlint-disable eslint/no-magic-numbers -- sample snapshots for the README images: the numbers are the fixture data */
import { RGBA } from '@opentui/core';
import { testRender } from '@opentui/solid';

import type { KeepaliveSnapshot } from '../../src/models/keepalive.ts';
import { CacheLines, type SidebarPalette } from '../../src/ui/sidebar.tsx';
import { frameToAnsi, textRow } from './ansi.ts';

/** 14:00 UTC; the script pins Date.now and TZ to it so the clock times in the images are stable. */
const CAPTURE_NOW = Date.UTC(2026, 9, 23, 14, 0, 0);

const MINUTE = 60_000;
const COLUMNS = 40;
/** Rows of the test terminal; the section is at most 7 lines tall. */
const HEIGHT = 8;

/** OpenCode's default theme ("opencode"), dark mode, from packages/tui/src/theme/assets/opencode.json. */
const OPENCODE_DARK = {
  error: '#e06c75',
  success: '#7fd88f',
  text: '#eeeeee',
  textMuted: '#808080',
  warning: '#f5a742',
} as const;
/** Captions annotate an image and are not TUI output, so they use a gray the sidebar never draws. */
const CAPTION_COLOR = '#606060';

const PALETTE: SidebarPalette = {
  base: RGBA.fromHex(OPENCODE_DARK.text),
  error: RGBA.fromHex(OPENCODE_DARK.error),
  muted: RGBA.fromHex(OPENCODE_DARK.textMuted),
  success: RGBA.fromHex(OPENCODE_DARK.success),
  warning: RGBA.fromHex(OPENCODE_DARK.warning),
};

const BASE: KeepaliveSnapshot = {
  contextTokens: 120_000,
  expiresAt: CAPTURE_NOW + 52 * MINUTE,
  lastCache: { read: 141_300, total: 152_900 },
  lastPing: 'hit',
  lastRequestAt: CAPTURE_NOW - 8 * MINUTE,
  maxPings: 5,
  minContextTokens: 50_000,
  nextPingAt: CAPTURE_NOW + 42 * MINUTE,
  pingsUsed: 2,
  savings: null,
  sessionID: 'ses_capture',
  showSavings: true,
  skipReason: null,
  ttl: '1h',
  ttlSource: 'detected',
};

const snapshot = (overrides: Partial<KeepaliveSnapshot>): KeepaliveSnapshot => ({
  ...BASE,
  ...overrides,
});

interface Block {
  /** Drawn above the block in the caption colour; not part of the TUI. */
  caption?: string;
  snapshot: KeepaliveSnapshot | undefined;
}

/** The hero image: a 1h cache being kept warm, two pings in. */
const HERO: readonly Block[] = [{ snapshot: BASE }];

/** Every other state the section can show, in the order the README lists them. */
const STATES: readonly Block[] = [
  { caption: 'Before the first response', snapshot: undefined },
  {
    caption: '5m cache, first ping pending',
    snapshot: snapshot({
      expiresAt: CAPTURE_NOW + 4 * MINUTE,
      lastPing: null,
      lastRequestAt: CAPTURE_NOW - MINUTE,
      nextPingAt: CAPTURE_NOW + 3 * MINUTE,
      pingsUsed: 0,
      ttl: '5m',
      ttlSource: 'requested',
    }),
  },
  {
    caption: 'OpenAI GPT-5.6+, 30m cache',
    snapshot: snapshot({
      expiresAt: CAPTURE_NOW + 26 * MINUTE,
      lastCache: { read: 88_000, total: 97_000 },
      lastRequestAt: CAPTURE_NOW - 4 * MINUTE,
      nextPingAt: CAPTURE_NOW + 21 * MINUTE,
      pingsUsed: 1,
      ttl: '30m',
      ttlSource: 'requested',
    }),
  },
  {
    caption: 'Ping failed, retrying in 30s',
    snapshot: snapshot({ lastPing: 'failed', nextPingAt: CAPTURE_NOW + 30_000, pingsUsed: 3 }),
  },
  {
    caption: 'Pings used up; the cache will expire',
    snapshot: snapshot({
      expiresAt: CAPTURE_NOW + 9 * MINUTE,
      nextPingAt: null,
      pingsUsed: 5,
      skipReason: 'exhausted',
    }),
  },
  {
    caption: 'Last ping missed the cache',
    snapshot: snapshot({ lastPing: 'miss', nextPingAt: null, pingsUsed: 3, skipReason: 'missed' }),
  },
  {
    caption: 'Waiting on a tool call',
    snapshot: snapshot({ nextPingAt: null, skipReason: 'busy' }),
  },
  {
    caption: 'Context below the minimum',
    snapshot: snapshot({
      contextTokens: 31_000,
      lastPing: null,
      nextPingAt: null,
      pingsUsed: 0,
      skipReason: 'small-context',
    }),
  },
  {
    caption: 'Keepalive turned off',
    snapshot: snapshot({ lastPing: null, nextPingAt: null, pingsUsed: 0, skipReason: 'disabled' }),
  },
  {
    caption: 'Provider-managed cache (no TTL to keep warm)',
    snapshot: snapshot({
      expiresAt: null,
      lastCache: { read: 14_000, total: 16_000 },
      lastPing: null,
      nextPingAt: null,
      pingsUsed: 0,
      skipReason: 'implicit',
      ttl: null,
      ttlSource: null,
    }),
  },
  {
    caption: 'Cache expired',
    snapshot: snapshot({
      expiresAt: CAPTURE_NOW - 12 * MINUTE,
      nextPingAt: null,
      pingsUsed: 5,
      skipReason: 'exhausted',
    }),
  },
];

const SCREENS = { 'sidebar': HERO, 'sidebar-states': STATES } as const;
type ScreenName = keyof typeof SCREENS;
const SCREEN_NAMES: ScreenName[] = Object.keys(SCREENS).filter((name): name is ScreenName =>
  isScreenName(name)
);

function isScreenName(name: string): name is ScreenName {
  return name in SCREENS;
}

async function renderBlock(block: Block): Promise<string[]> {
  const setup = await testRender(
    () => <CacheLines palette={() => PALETTE} snapshot={() => block.snapshot} />,
    {
      height: HEIGHT,
      width: COLUMNS,
    }
  );
  try {
    await setup.flush();
    return frameToAnsi(setup.captureSpans());
  } finally {
    setup.renderer.destroy();
  }
}

/** Renders the screen's blocks top to bottom, one blank row apart, as ANSI rows. */
async function renderScreen(name: ScreenName): Promise<string[]> {
  const rows: string[] = [];
  for (const block of SCREENS[name]) {
    // @opentui/solid attaches its engine to the latest test renderer, so each block renders and is destroyed before the next starts.
    const body = await renderBlock(block);
    if (rows.length > 0) rows.push('');
    if (block.caption !== undefined) {
      rows.push(textRow([{ fg: CAPTION_COLOR, text: `# ${block.caption}` }]));
    }
    rows.push(...body);
  }
  return rows;
}

export type { ScreenName };
export { CAPTURE_NOW, SCREENS, SCREEN_NAMES, isScreenName, renderScreen };
export { SECTION_HEADER } from '../../src/ui/sidebar-lines.ts';
