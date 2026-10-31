/**
 * Prompt-cache TTL modes, named after Claude's TTLs. The `openai` profile maps
 * them onto GPT-5.6+'s 30m automatic cache and 12h breakpoints.
 *
 * - `"5m"`     — default 5-minute ephemeral caching (no `ttl`, no extended beta).
 * - `"1h"`     — 1-hour ephemeral caching on every breakpoint.
 * - `"hybrid"` — 1h on the `tools` + `system` prefix and 5m on `messages`, which
 *                satisfies Anthropic's requirement that longer-lived (1h)
 *                breakpoints precede shorter-lived (5m) ones.
 */
type CacheTtlMode = '5m' | '1h' | 'hybrid';

/** Returns true when `value` is one of the three valid cache TTL modes. */
function isCacheTtlMode(value: unknown): value is CacheTtlMode {
  return value === '5m' || value === '1h' || value === 'hybrid';
}

/** Cache TTL a provider grants for a cache write: Anthropic `5m` / `1h`, OpenAI `30m` / `12h`. */
type Ttl = '5m' | '1h' | '30m' | '12h';

/** Token counts from an Anthropic `usage` block, relevant to prompt caching. */
interface CacheUsage {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Generated tokens; 0 when the provider omits them. */
  outputTokens: number;
  /** `undefined` when the provider omits the `cache_creation` breakdown. */
  write5mTokens: number | undefined;
  write1hTokens: number | undefined;
}

/** Request wire format the plugin understands. */
type Wire = 'anthropic-messages' | 'openai-chat' | 'openai-responses';

/**
 * How a model's prompt cache is controlled.
 *
 * - `"anthropic"` — Claude-family: `cache_control` breakpoints, TTL, keepalive pings.
 * - `"openai"`    — OpenAI models with `prompt_cache_options` / `prompt_cache_breakpoint`.
 * - `"implicit"`  — provider-managed caching; observed only, never pinged.
 */
type CacheProfileId = 'anthropic' | 'openai' | 'implicit';

/** Returns true when `value` is a known cache profile ID. */
function isCacheProfileId(value: unknown): value is CacheProfileId {
  return value === 'anthropic' || value === 'openai' || value === 'implicit';
}

/** Identifies an OpenCode model: provider plus model ID. */
interface ModelRef {
  providerID: string;
  id: string;
}

/** The resolved `model` / `provider` a response reports; the Messages wire reports only `model`. */
interface ResponseIdentity {
  model?: string;
  provider?: string;
}

/** What the response tee reads from a response body; fields a wire does not report stay undefined. */
interface ObservedResponse {
  usage?: CacheUsage;
  stopReason?: string;
  identity?: ResponseIdentity;
}

/** The per-wire parsers the response tee applies: `fromJson` gets the body parsed once, `fromSse` the raw stream text. */
interface ResponseParsers {
  fromJson: (body: unknown) => ObservedResponse;
  fromSse: (text: string) => ObservedResponse;
}

/** A user-supplied `cacheProfiles` entry, compiled. */
interface ProfilePattern {
  matches: (ref: ModelRef) => boolean;
  profile: CacheProfileId;
}

export type {
  CacheTtlMode,
  Ttl,
  CacheUsage,
  Wire,
  CacheProfileId,
  ModelRef,
  ResponseIdentity,
  ObservedResponse,
  ResponseParsers,
  ProfilePattern,
};
export { isCacheTtlMode, isCacheProfileId };
