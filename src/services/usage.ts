import { ANTHROPIC_PROVIDER_IDS } from "../constants/anthropic.ts";
import type { CacheUsage, Ttl, Wire } from "../models/cache.ts";
import { isRecord } from "../utils/is-record.ts";
import { num } from "../utils/num.ts";
import { isPostToPathSuffix } from "../utils/request-path.ts";
import {
  type OpenAiIdentity,
  parseOpenAiFinishReasonFromJson,
  parseOpenAiFinishReasonFromSse,
  parseOpenAiIdentityFromJson,
  parseOpenAiIdentityFromSse,
  parseOpenAiUsageFromJson,
  parseOpenAiUsageFromSse,
} from "./usage-openai.ts";

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

/** The top-level `stop_reason` of a non-streaming Messages response. */
export function parseStopReasonFromJson(body: unknown): string | undefined {
  return isRecord(body) && typeof body.stop_reason === "string" ? body.stop_reason : undefined;
}

/** The last `message_delta.delta.stop_reason` of a streamed Messages response. */
export function parseStopReasonFromSse(text: string): string | undefined {
  let stopReason: string | undefined;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try {
      const event: unknown = JSON.parse(line.slice(5).trim());
      if (isRecord(event) && event.type === "message_delta" && isRecord(event.delta)) {
        const reason = event.delta.stop_reason;
        if (typeof reason === "string") stopReason = reason;
      }
    } catch {
      continue;
    }
  }
  return stopReason;
}

export function isAnthropicProvider(providerID: string): boolean {
  return ANTHROPIC_PROVIDER_IDS.includes(providerID);
}

/** True for a POST whose path ends in `/messages`, on any host (direct or proxied). */
export function isAnthropicMessagesRequest(request: Request): boolean {
  return isPostToPathSuffix(request, "/messages");
}

interface ObservedResponse {
  usage?: CacheUsage;
  stopReason?: string;
  identity?: OpenAiIdentity;
}

/**
 * Tees the response body so usage, the stop reason and (on `openai-chat`) the
 * resolved model and provider can be read in the background while the caller
 * receives an unmodified response. Cancelling the caller's body also stops the
 * observer, so the source is cancelled. The promises never reject.
 */
export function observeResponseUsage(
  response: Response,
  wire: Wire = "anthropic-messages",
): {
  response: Response;
  usage: Promise<CacheUsage | undefined>;
  stopReason: Promise<string | undefined>;
  identity: Promise<OpenAiIdentity | undefined>;
} {
  if (!response.body) {
    return {
      response,
      usage: Promise.resolve(undefined),
      stopReason: Promise.resolve(undefined),
      identity: Promise.resolve(undefined),
    };
  }

  const [callerBranch, observerBranch] = response.body.tee();
  const callerReader = callerBranch.getReader();
  const observerReader = observerBranch.getReader();
  let cancelled = false;
  const forCaller = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const { done, value } = await callerReader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      },
      async cancel(reason) {
        cancelled = true;
        await Promise.all([callerReader.cancel(reason), observerReader.cancel(reason)]);
      },
    },
    { highWaterMark: 0 },
  );
  const passthrough = new Response(forCaller, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });

  const contentType = response.headers.get("content-type") ?? "";
  const parsed = (async (): Promise<ObservedResponse> => {
    try {
      const decoder = new TextDecoder();
      let text = "";
      for (;;) {
        const { done, value } = await observerReader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      if (cancelled || !response.ok) return {};
      const streamed = contentType.includes("text/event-stream");
      if (wire === "openai-chat") {
        if (streamed) {
          return {
            usage: parseOpenAiUsageFromSse(text),
            stopReason: parseOpenAiFinishReasonFromSse(text),
            identity: parseOpenAiIdentityFromSse(text),
          };
        }
        const body: unknown = JSON.parse(text);
        return {
          usage: parseOpenAiUsageFromJson(body),
          stopReason: parseOpenAiFinishReasonFromJson(body),
          identity: parseOpenAiIdentityFromJson(body),
        };
      }
      if (streamed) return { usage: parseUsageFromSse(text), stopReason: parseStopReasonFromSse(text) };
      const body: unknown = JSON.parse(text);
      return { usage: parseUsageFromJson(body), stopReason: parseStopReasonFromJson(body) };
    } catch {
      return {};
    }
  })();

  return {
    response: passthrough,
    usage: parsed.then((p) => p.usage),
    stopReason: parsed.then((p) => p.stopReason),
    identity: parsed.then((p) => p.identity),
  };
}
