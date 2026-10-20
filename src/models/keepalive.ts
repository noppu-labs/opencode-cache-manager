import type { Ttl } from "./cache.ts";

export type SkipReason =
  | "disabled"
  | "small-context"
  | "child"
  | "busy"
  | "exhausted"
  | "no-cache-seen"
  | "missed";

/** OpenCode's request kind for a model call. */
export type RequestKind = "primary" | "compaction" | "title" | "generate";

export interface KeepaliveSnapshot {
  sessionID: string;
  ttl: Ttl | null;
  ttlSource: "detected" | "requested" | null;
  lastRequestAt: number | null;
  expiresAt: number | null;
  nextPingAt: number | null;
  pingsUsed: number;
  maxPings: number;
  minContextTokens: number;
  lastPing: "hit" | "miss" | "failed" | null;
  skipReason: SkipReason | null;
  contextTokens: number | null;
}
