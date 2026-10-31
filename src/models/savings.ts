/** USD per million tokens. */
interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Running totals of one session's keepalive ledger. */
interface LedgerTotals {
  version: 1;
  pings: number;
  rescues: number;
  avoidedTokens: number;
  pingUnits: number;
  avoidedUnits: number;
  pingUsd: number;
  avoidedUsd: number;
  unpricedEvents: number;
}

/** What the sidebar shows for a session's ledger. */
interface SavingsReadout {
  /** `unpricedEvents === 0 && pings > 0`. */
  priced: boolean;
  pings: number;
  rescues: number;
  avoidedTokens: number;
  /** `avoidedUsd - pingUsd` when priced. */
  netUsd: number | null;
  /** Null until rescues > 0; dollars when priced, units otherwise. */
  returnRatio: number | null;
  /** Ping cost in the current stretch; null when unpriced or none. */
  stretchUsd: number | null;
}

export type { ModelPrice, LedgerTotals, SavingsReadout };
