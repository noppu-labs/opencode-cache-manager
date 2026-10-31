import {
  DEFAULT_WRITE_TTLS,
  OUTPUT_MULTIPLIER,
  READ_MULTIPLIER,
  WRITE_MULTIPLIER,
} from '../constants/savings.ts';
import { MILLION } from '../constants/units.ts';
import type { CacheUsage, Ttl } from '../models/cache.ts';
import type { LedgerTotals, ModelPrice, SavingsReadout } from '../models/savings.ts';

/** Price per million tokens of a cache read. */
function readPrice(price: ModelPrice): number {
  return price.cacheRead > 0 ? price.cacheRead : price.input * READ_MULTIPLIER;
}

/** Price per million tokens of a cache write at `ttl`; the catalog price only covers the default TTLs. */
function writePrice(price: ModelPrice, ttl: Ttl): number {
  return DEFAULT_WRITE_TTLS.has(ttl) && price.cacheWrite > 0
    ? price.cacheWrite
    : price.input * WRITE_MULTIPLIER[ttl];
}

/** Cost of one ping in input-token equivalents. */
function pingUnits(usage: CacheUsage, ttl: Ttl): number {
  return (
    usage.inputTokens +
    usage.cacheReadTokens * READ_MULTIPLIER +
    usage.cacheWriteTokens * WRITE_MULTIPLIER[ttl] +
    usage.outputTokens * OUTPUT_MULTIPLIER
  );
}

/** Cost of one ping in USD. */
function pingUsd(usage: CacheUsage, ttl: Ttl, price: ModelPrice): number {
  return (
    (usage.inputTokens * price.input +
      usage.cacheReadTokens * readPrice(price) +
      usage.cacheWriteTokens * writePrice(price, ttl) +
      usage.outputTokens * price.output) /
    MILLION
  );
}

/** Input-token equivalents saved by reading `tokens` from cache instead of rewriting them. */
function avoidedUnits(tokens: number, ttl: Ttl): number {
  return Math.max(0, tokens * (WRITE_MULTIPLIER[ttl] - READ_MULTIPLIER));
}

/** USD saved by reading `tokens` from cache instead of rewriting them; never negative. */
function avoidedUsd(tokens: number, ttl: Ttl, price: ModelPrice): number {
  return Math.max(0, (tokens * (writePrice(price, ttl) - readPrice(price))) / MILLION);
}

/** Turns ledger totals into what the sidebar shows. */
function toReadout(totals: LedgerTotals, stretchUsd: number | null): SavingsReadout {
  const priced = totals.unpricedEvents === 0 && totals.pings > 0;
  const avoided = priced ? totals.avoidedUsd : totals.avoidedUnits;
  const spent = priced ? totals.pingUsd : totals.pingUnits;
  return {
    avoidedTokens: totals.avoidedTokens,
    netUsd: priced ? totals.avoidedUsd - totals.pingUsd : null,
    pings: totals.pings,
    priced,
    rescues: totals.rescues,
    returnRatio: totals.rescues === 0 || spent === 0 ? null : avoided / spent,
    stretchUsd: priced ? stretchUsd : null,
  };
}

export { pingUnits, pingUsd, avoidedUnits, avoidedUsd, writePrice, readPrice, toReadout };
