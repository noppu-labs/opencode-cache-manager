import type { KeepaliveSnapshot } from "./keepalive.ts";

export type Tone = "base" | "muted" | "success" | "warning" | "error";
export interface SidebarLine {
  text: string;
  tone: Tone;
  bold?: boolean;
  /** Second column, rendered right-aligned; muted unless `rightTone` is set. */
  right?: string;
  rightTone?: Tone;
}

const HEADER: SidebarLine = { text: "Cache", tone: "base", bold: true };

const defaultClock = (ms: number): string =>
  new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

/** "52m", "3m", "45s"; "1h 05m" at 60 minutes and above. */
export function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  return `${Math.floor(totalMinutes / 60)}h ${String(totalMinutes % 60).padStart(2, "0")}m`;
}

const thousands = (tokens: number): string => `${Math.round(tokens / 1000)}k`;

/** Lines for the sidebar cache section; an empty array means render nothing. */
export function sidebarLines(
  s: KeepaliveSnapshot | undefined,
  now: number,
  formatClock: (ms: number) => string = defaultClock,
): SidebarLine[] {
  const waiting: SidebarLine[] = [HEADER, { text: "waiting for first response", tone: "muted" }];
  // No snapshot yet (e.g. after a restart) still shows the section, so the user can see the plugin is there.
  if (s === undefined || s.lastRequestAt === null) return waiting;
  if (s.skipReason === "child") return [];
  if (s.skipReason === "no-cache-seen" && s.contextTokens !== null) return [];
  if (s.ttl === null) return waiting;

  const ttl: SidebarLine = { text: "ttl", tone: "base", right: `${s.ttl} (${s.ttlSource})` };
  if (s.expiresAt === null) return [HEADER, ttl];

  if (now >= s.expiresAt) {
    return [HEADER, { text: "• expired", tone: "error", right: `${formatRemaining(now - s.expiresAt)} ago` }, ttl];
  }
  const lines: SidebarLine[] = [
    HEADER,
    {
      text: "• warm",
      tone: s.skipReason === "exhausted" ? "warning" : "success",
      right: `expires ${formatClock(s.expiresAt)} (${formatRemaining(s.expiresAt - now)})`,
    },
    ttl,
  ];

  if (s.skipReason === "missed") {
    lines.push({ text: "keepalive", tone: "base", right: "stopped · last ping missed", rightTone: "error" });
  } else if (s.skipReason === "busy") {
    lines.push({ text: "keepalive", tone: "base", right: "waiting · session busy" });
  } else if (s.skipReason === "small-context") {
    lines.push({
      text: "keepalive",
      tone: "base",
      right: `off · ${thousands(s.contextTokens ?? 0)} < ${thousands(s.minContextTokens)}`,
    });
  } else if (s.skipReason === "disabled") {
    lines.push({ text: "keepalive", tone: "base", right: "off · disabled" });
  } else {
    if (s.nextPingAt !== null) {
      lines.push({
        text: "next ping",
        tone: "base",
        right: `${formatClock(s.nextPingAt)} (${formatRemaining(s.nextPingAt - now)})`,
      });
    } else if (s.skipReason === "exhausted") {
      lines.push({ text: "next ping", tone: "base", right: "none" });
    }
    const outcome =
      s.lastPing === "hit" ? " ✓ hit" : s.lastPing === "miss" ? " ✗ miss" : s.lastPing === "failed" ? " ✗ failed" : "";
    const pings: SidebarLine = { text: "pings", tone: "base", right: `${s.pingsUsed}/${s.maxPings}${outcome}` };
    if (s.lastPing !== null) pings.rightTone = s.lastPing === "hit" ? "success" : "error";
    lines.push(pings);
  }
  return lines;
}
