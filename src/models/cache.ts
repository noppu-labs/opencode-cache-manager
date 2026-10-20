/**
 * Anthropic prompt-cache TTL modes.
 *
 * - `"5m"`     — default 5-minute ephemeral caching (no `ttl`, no extended beta).
 * - `"1h"`     — 1-hour ephemeral caching on every breakpoint.
 * - `"hybrid"` — 1h on the `tools` + `system` prefix and 5m on `messages`, which
 *                satisfies Anthropic's requirement that longer-lived (1h)
 *                breakpoints precede shorter-lived (5m) ones.
 */
export type CacheTtlMode = "5m" | "1h" | "hybrid";

/** Returns true when `value` is one of the three valid cache TTL modes. */
export function isCacheTtlMode(value: unknown): value is CacheTtlMode {
  return value === "5m" || value === "1h" || value === "hybrid";
}

/** Cache TTL granted by Anthropic for a cache write. */
export type Ttl = "5m" | "1h";

/** Token counts from an Anthropic `usage` block, relevant to prompt caching. */
export interface CacheUsage {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** `undefined` when the provider omits the `cache_creation` breakdown. */
  write5mTokens: number | undefined;
  write1hTokens: number | undefined;
}
