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

/** Cache TTL a provider grants for a cache write: Anthropic `5m` / `1h`, OpenAI `30m` / `12h`. */
export type Ttl = "5m" | "1h" | "30m" | "12h";

/** Token counts from an Anthropic `usage` block, relevant to prompt caching. */
export interface CacheUsage {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** `undefined` when the provider omits the `cache_creation` breakdown. */
  write5mTokens: number | undefined;
  write1hTokens: number | undefined;
}

/** Request wire format the plugin understands. */
export type Wire = "anthropic-messages" | "openai-chat" | "openai-responses";

/**
 * How a model's prompt cache is controlled.
 *
 * - `"anthropic"` — Claude-family: `cache_control` breakpoints, TTL, keepalive pings.
 * - `"openai"`    — OpenAI models with `prompt_cache_options` / `prompt_cache_breakpoint`.
 * - `"implicit"`  — provider-managed caching; observed only, never pinged.
 */
export type CacheProfileId = "anthropic" | "openai" | "implicit";

/** Returns true when `value` is a known cache profile ID. */
export function isCacheProfileId(value: unknown): value is CacheProfileId {
  return value === "anthropic" || value === "openai" || value === "implicit";
}

/** Identifies an OpenCode model: provider plus model ID. */
export interface ModelRef {
  providerID: string;
  id: string;
}

/** The resolved `model` / `provider` a response reports; the Messages wire reports only `model`. */
export interface ResponseIdentity {
  model?: string;
  provider?: string;
}

/** What the response tee reads from a response body; fields a wire does not report stay undefined. */
export interface ObservedResponse {
  usage?: CacheUsage;
  stopReason?: string;
  identity?: ResponseIdentity;
}

/** The per-wire parsers the response tee applies: `fromJson` gets the body parsed once, `fromSse` the raw stream text. */
export interface ResponseParsers {
  fromJson(body: unknown): ObservedResponse;
  fromSse(text: string): ObservedResponse;
}

/** A user-supplied `cacheProfiles` entry, compiled. */
export interface ProfilePattern {
  matches(ref: ModelRef): boolean;
  profile: CacheProfileId;
}
