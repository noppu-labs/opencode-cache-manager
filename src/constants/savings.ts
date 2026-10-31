import type { Ttl } from '../models/cache.ts';
import type { LedgerTotals } from '../models/savings.ts';

/** Cache read price as a multiple of the base input price. */
const READ_MULTIPLIER = 0.1;
/** Output price as a multiple of the base input price. */
const OUTPUT_MULTIPLIER = 5;

/** Cache write price as a multiple of the base input price, per granted TTL. */
const WRITE_MULTIPLIER: Record<Ttl, number> = { '1h': 2, '5m': 1.25, '12h': 2.5, '30m': 1.25 };

/** TTLs whose write price is the catalog `cacheWrite`; longer TTLs are derived from `input`. */
const DEFAULT_WRITE_TTLS: ReadonlySet<Ttl> = new Set<Ttl>(['5m', '30m']);

const EMPTY_TOTALS: LedgerTotals = Object.freeze({
  avoidedTokens: 0,
  avoidedUnits: 0,
  avoidedUsd: 0,
  pingUnits: 0,
  pingUsd: 0,
  pings: 0,
  rescues: 0,
  unpricedEvents: 0,
  version: 1,
});

const MODELS_DEV_URL = 'https://models.dev/api.json';
const MODELS_DEV_MAX_AGE_MS = 86_400_000;
/** Wait after a failed models.dev fetch before trying again. */
const MODELS_DEV_RETRY_MS = 900_000;
const MODELS_DEV_STORAGE_KEY = 'models-dev';
/** A models.dev fetch that takes longer is aborted, so a hung request cannot stall price lookups. */
const MODELS_DEV_FETCH_TIMEOUT_MS = 10_000;
/** Vendors whose own listing wins over resellers. */
const MODELS_DEV_VENDORS: readonly string[] = ['anthropic', 'openai'];

export {
  READ_MULTIPLIER,
  OUTPUT_MULTIPLIER,
  WRITE_MULTIPLIER,
  DEFAULT_WRITE_TTLS,
  EMPTY_TOTALS,
  MODELS_DEV_URL,
  MODELS_DEV_MAX_AGE_MS,
  MODELS_DEV_RETRY_MS,
  MODELS_DEV_STORAGE_KEY,
  MODELS_DEV_FETCH_TIMEOUT_MS,
  MODELS_DEV_VENDORS,
};
