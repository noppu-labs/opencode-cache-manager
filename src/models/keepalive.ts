import type { Ttl } from './cache.ts';

/** Cache reads and total prompt tokens of one response. */
interface CacheReadout {
  read: number;
  total: number;
}

type SkipReason =
  | 'disabled'
  | 'small-context'
  | 'child'
  | 'implicit'
  | 'busy'
  | 'exhausted'
  | 'no-cache-seen'
  | 'missed';

/** OpenCode's request kind for a model call. */
type RequestKind = 'primary' | 'compaction' | 'title' | 'generate';

type KeepaliveSnapshot = {
  sessionID: string;
  ttl: Ttl | null;
  ttlSource: 'detected' | 'requested' | null;
  lastRequestAt: number | null;
  expiresAt: number | null;
  nextPingAt: number | null;
  pingsUsed: number;
  maxPings: number;
  minContextTokens: number;
  lastPing: 'hit' | 'miss' | 'failed' | null;
  skipReason: SkipReason | null;
  contextTokens: number | null;
  /** Cache reads and total prompt tokens of the latest non-ping response; null before one arrives. */
  lastCache: CacheReadout | null;
};

export type { CacheReadout, SkipReason, RequestKind, KeepaliveSnapshot };
