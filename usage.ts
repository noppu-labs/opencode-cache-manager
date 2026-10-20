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

/** Total prompt size: uncached input plus cache reads plus cache writes. */
export function contextTokens(u: CacheUsage): number {
  return u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
}

export function hasCacheActivity(u: CacheUsage): boolean {
  return u.cacheReadTokens + u.cacheWriteTokens > 0;
}

/**
 * The TTL the response was actually billed at. Any 5m write wins because a
 * request with a 5m breakpoint expires its tail at 5m; `undefined` when there
 * was no write or no breakdown.
 */
export function grantedTtl(u: CacheUsage): Ttl | undefined {
  if ((u.write5mTokens ?? 0) > 0) return "5m";
  if ((u.write1hTokens ?? 0) > 0) return "1h";
  return undefined;
}

type PartialUsage = Partial<CacheUsage>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Reads only the fields actually present so later events can override selectively. */
function readUsage(raw: unknown): PartialUsage | undefined {
  if (!isRecord(raw)) return undefined;
  const out: PartialUsage = {
    inputTokens: num(raw.input_tokens),
    cacheReadTokens: num(raw.cache_read_input_tokens),
    cacheWriteTokens: num(raw.cache_creation_input_tokens),
  };
  if (isRecord(raw.cache_creation)) {
    out.write5mTokens = num(raw.cache_creation.ephemeral_5m_input_tokens) ?? 0;
    out.write1hTokens = num(raw.cache_creation.ephemeral_1h_input_tokens) ?? 0;
  }
  return out;
}

function finalize(partial: PartialUsage): CacheUsage {
  return {
    inputTokens: partial.inputTokens ?? 0,
    cacheReadTokens: partial.cacheReadTokens ?? 0,
    cacheWriteTokens: partial.cacheWriteTokens ?? 0,
    write5mTokens: partial.write5mTokens,
    write1hTokens: partial.write1hTokens,
  };
}

/** Parses the `usage` block of a non-streaming Messages response body. */
export function parseUsageFromJson(body: unknown): CacheUsage | undefined {
  if (!isRecord(body)) return undefined;
  const partial = readUsage(body.usage);
  return partial && finalize(partial);
}

/**
 * Parses a streamed Messages response: `message_start` carries the prompt
 * usage and `message_delta` updates the fields it reports.
 */
export function parseUsageFromSse(text: string): CacheUsage | undefined {
  let merged: PartialUsage | undefined;

  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    let event: unknown;
    try {
      event = JSON.parse(line.slice(5).trim());
    } catch {
      continue;
    }
    if (!isRecord(event)) continue;

    const raw =
      event.type === "message_start" && isRecord(event.message)
        ? event.message.usage
        : event.type === "message_delta"
          ? event.usage
          : undefined;
    const partial = readUsage(raw);
    if (!partial) continue;

    merged ??= {};
    for (const key of Object.keys(partial) as (keyof PartialUsage)[]) {
      if (partial[key] !== undefined) merged[key] = partial[key];
    }
  }

  return merged && finalize(merged);
}

/** True for a POST whose path ends in `/messages`, on any host (direct or proxied). */
export function isAnthropicMessagesRequest(request: Request): boolean {
  if (request.method !== "POST") return false;
  try {
    return new URL(request.url).pathname.endsWith("/messages");
  } catch {
    return false;
  }
}

/**
 * Tees the response body so usage can be read in the background while the
 * caller receives an unmodified response. The promise never rejects.
 */
export function observeResponseUsage(response: Response): {
  response: Response;
  usage: Promise<CacheUsage | undefined>;
} {
  if (!response.body) return { response, usage: Promise.resolve(undefined) };

  const [forCaller, forObserver] = response.body.tee();
  const passthrough = new Response(forCaller, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });

  const contentType = response.headers.get("content-type") ?? "";
  const usage = (async (): Promise<CacheUsage | undefined> => {
    try {
      const text = await new Response(forObserver).text();
      if (!response.ok) return undefined;
      if (contentType.includes("text/event-stream")) return parseUsageFromSse(text);
      return parseUsageFromJson(JSON.parse(text));
    } catch {
      return undefined;
    }
  })();

  return { response: passthrough, usage };
}
