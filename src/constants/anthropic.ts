/** Anthropic beta flag that unlocks the 1-hour cache TTL. */
export const EXTENDED_CACHE_BETA = "extended-cache-ttl-2025-04-11";

/** Internal sentinel header used by model variants to override the active mode. */
export const SENTINEL_HEADER = "x-cache-ttl";

/** Provider IDs whose requests are always rewritten and observed. */
export const ANTHROPIC_PROVIDER_IDS: readonly string[] = ["anthropic", "omniroute-anthropic"];

/** Path suffix of the Anthropic Messages endpoint. */
export const MESSAGES_SUFFIX = "/messages";

/** Request header carrying Anthropic beta flags. */
export const BETA_HEADER = "anthropic-beta";
