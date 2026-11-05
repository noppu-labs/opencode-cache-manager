import type { ModelRef, Ttl } from './cache.ts';
import type { SavingsReadout } from './savings.ts';

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
  | 'missed'
  /** No ping can reach the provider before the cache expires, so none is scheduled. */
  | 'too-late';

/** OpenCode's request kind for a model call. */
type RequestKind = 'primary' | 'compaction' | 'title' | 'generate';

// oxlint-disable-next-line typescript/consistent-type-definitions -- the host's RPC event payload must be assignable to Record<string, unknown>, which an interface is not
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
  showSavings: boolean;
  /** The session's ledger readout; null with savings off, for unmanaged or child sessions and before the ledger loads. */
  savings: SavingsReadout | null;
};

/** What a session's schedule needs to carry on after the plugin reloads; the rest of its state is rebuilt by the next request. */
interface KeepaliveRecord {
  contextTokens: number | null;
  firstPrimaryContext: number | null;
  lastCache: CacheReadout | null;
  lastPing: KeepaliveSnapshot['lastPing'];
  lastRequestAt: number;
  model: ModelRef | null;
  originalExpiry: number | null;
  pingsUsed: number;
  prefix1hTokens: number | null;
  requestedTtl: Ttl;
  split: boolean;
  stretchCharged: boolean;
  stretchHits: number;
  ttl: Ttl;
  ttlSource: 'detected' | 'requested' | null;
}

export type { CacheReadout, SkipReason, RequestKind, KeepaliveSnapshot, KeepaliveRecord };
