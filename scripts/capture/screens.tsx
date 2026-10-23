/** @jsxImportSource @opentui/solid */
import { RGBA } from "@opentui/core";
import { testRender } from "@opentui/solid";
import type { KeepaliveSnapshot } from "../../src/models/keepalive.ts";
import { CacheLines, type SidebarPalette } from "../../src/ui/sidebar.tsx";
import { frameToAnsi, textRow } from "./ansi.ts";

export { SECTION_HEADER } from "../../src/ui/sidebar-lines.ts";

/** 14:00 UTC; the script pins Date.now and TZ to it so the clock times in the images are stable. */
export const CAPTURE_NOW = Date.UTC(2026, 9, 23, 14, 0, 0);

const MINUTE = 60_000;
const COLUMNS = 40;
/** Rows of the test terminal; the section is at most 7 lines tall. */
const HEIGHT = 8;

/** OpenCode's default theme ("opencode"), dark mode, from packages/tui/src/theme/assets/opencode.json. */
const OPENCODE_DARK = {
  text: "#eeeeee",
  textMuted: "#808080",
  success: "#7fd88f",
  warning: "#f5a742",
  error: "#e06c75",
} as const;
/** Captions annotate an image and are not TUI output, so they use a gray the sidebar never draws. */
const CAPTION_COLOR = "#606060";

const PALETTE: SidebarPalette = {
  base: RGBA.fromHex(OPENCODE_DARK.text),
  muted: RGBA.fromHex(OPENCODE_DARK.textMuted),
  success: RGBA.fromHex(OPENCODE_DARK.success),
  warning: RGBA.fromHex(OPENCODE_DARK.warning),
  error: RGBA.fromHex(OPENCODE_DARK.error),
};

const BASE: KeepaliveSnapshot = {
  sessionID: "ses_capture",
  ttl: "1h",
  ttlSource: "detected",
  lastRequestAt: CAPTURE_NOW - 8 * MINUTE,
  expiresAt: CAPTURE_NOW + 52 * MINUTE,
  nextPingAt: CAPTURE_NOW + 42 * MINUTE,
  pingsUsed: 2,
  maxPings: 5,
  minContextTokens: 50_000,
  lastPing: "hit",
  skipReason: null,
  contextTokens: 120_000,
  lastCache: { read: 141_300, total: 152_900 },
};

const snapshot = (overrides: Partial<KeepaliveSnapshot>): KeepaliveSnapshot => ({ ...BASE, ...overrides });

interface Block {
  /** Drawn above the block in the caption colour; not part of the TUI. */
  caption?: string;
  snapshot: KeepaliveSnapshot | undefined;
}

/** The hero image: a 1h cache being kept warm, two pings in. */
const HERO: readonly Block[] = [{ snapshot: BASE }];

/** Every other state the section can show, in the order the README lists them. */
const STATES: readonly Block[] = [
  { caption: "Before the first response", snapshot: undefined },
  {
    caption: "5m cache, first ping pending",
    snapshot: snapshot({
      ttl: "5m",
      ttlSource: "requested",
      lastRequestAt: CAPTURE_NOW - MINUTE,
      expiresAt: CAPTURE_NOW + 4 * MINUTE,
      nextPingAt: CAPTURE_NOW + 3 * MINUTE,
      pingsUsed: 0,
      lastPing: null,
    }),
  },
  {
    caption: "Ping failed, retrying in 30s",
    snapshot: snapshot({ nextPingAt: CAPTURE_NOW + 30_000, pingsUsed: 3, lastPing: "failed" }),
  },
  {
    caption: "Pings used up; the cache will expire",
    snapshot: snapshot({ skipReason: "exhausted", nextPingAt: null, pingsUsed: 5, expiresAt: CAPTURE_NOW + 9 * MINUTE }),
  },
  {
    caption: "Last ping missed the cache",
    snapshot: snapshot({ skipReason: "missed", nextPingAt: null, pingsUsed: 3, lastPing: "miss" }),
  },
  { caption: "Waiting on a tool call", snapshot: snapshot({ skipReason: "busy", nextPingAt: null }) },
  {
    caption: "Context below the minimum",
    snapshot: snapshot({ skipReason: "small-context", nextPingAt: null, pingsUsed: 0, lastPing: null, contextTokens: 31_000 }),
  },
  {
    caption: "Keepalive turned off",
    snapshot: snapshot({ skipReason: "disabled", nextPingAt: null, pingsUsed: 0, lastPing: null }),
  },
  {
    caption: "Provider-managed cache (no TTL to keep warm)",
    snapshot: snapshot({
      ttl: null,
      ttlSource: null,
      expiresAt: null,
      nextPingAt: null,
      pingsUsed: 0,
      lastPing: null,
      skipReason: "implicit",
      lastCache: { read: 14_000, total: 16_000 },
    }),
  },
  {
    caption: "Cache expired",
    snapshot: snapshot({ expiresAt: CAPTURE_NOW - 12 * MINUTE, nextPingAt: null, pingsUsed: 5, skipReason: "exhausted" }),
  },
];

export const SCREENS = { sidebar: HERO, "sidebar-states": STATES } as const;
export type ScreenName = keyof typeof SCREENS;
export const SCREEN_NAMES = Object.keys(SCREENS) as ScreenName[];

export function isScreenName(name: string): name is ScreenName {
  return name in SCREENS;
}

async function renderBlock(block: Block): Promise<string[]> {
  const setup = await testRender(() => <CacheLines palette={() => PALETTE} snapshot={() => block.snapshot} />, {
    width: COLUMNS,
    height: HEIGHT,
  });
  try {
    await setup.flush();
    return frameToAnsi(setup.captureSpans());
  } finally {
    setup.renderer.destroy();
  }
}

/** Renders the screen's blocks top to bottom, one blank row apart, as ANSI rows. */
export async function renderScreen(name: ScreenName): Promise<string[]> {
  const rows: string[] = [];
  for (const block of SCREENS[name]) {
    // @opentui/solid attaches its engine to the latest test renderer, so each block renders and is destroyed before the next starts.
    const body = await renderBlock(block);
    if (rows.length > 0) rows.push("");
    if (block.caption !== undefined) rows.push(textRow([{ text: `# ${block.caption}`, fg: CAPTION_COLOR }]));
    rows.push(...body);
  }
  return rows;
}
