/** Anthropic beta flag that unlocks the 1-hour cache TTL. */
const EXTENDED_CACHE_BETA = 'extended-cache-ttl-2025-04-11';

/** Internal sentinel header used by model variants to override the active mode. */
const SENTINEL_HEADER = 'x-cache-ttl';

/** Provider IDs whose requests are always rewritten and observed. */
const ANTHROPIC_PROVIDER_IDS: readonly string[] = ['anthropic', 'omniroute-anthropic'];

/** Path suffix of the Anthropic Messages endpoint. */
const MESSAGES_SUFFIX = '/messages';

/** Request header carrying Anthropic beta flags. */
const BETA_HEADER = 'anthropic-beta';

/** Response statuses that mean the upstream rejected the request itself, so a learned profile may be wrong. */
const REJECTED_REQUEST_STATUSES: readonly number[] = [400, 422];

export {
  EXTENDED_CACHE_BETA,
  SENTINEL_HEADER,
  ANTHROPIC_PROVIDER_IDS,
  MESSAGES_SUFFIX,
  BETA_HEADER,
  REJECTED_REQUEST_STATUSES,
};
