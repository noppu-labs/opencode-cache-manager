import { ANTHROPIC_PROVIDER_IDS, MESSAGES_SUFFIX } from "../constants/anthropic.ts";
import { CHAT_COMPLETIONS_SUFFIX, EXPLICIT_CACHE_MODEL } from "../constants/openai.ts";
import type { CacheStrategy, ModelPattern, ModelRef, Wire } from "../models/cache.ts";
import type { RequestKind } from "../models/keepalive.ts";
import { matchModelPatterns } from "./model-patterns.ts";
import { isRecord } from "../utils/is-record.ts";
import { isPostToPathSuffix } from "../utils/request-path.ts";

/** True for the provider IDs whose requests are always rewritten and observed. */
export function isAnthropicProvider(providerID: string): boolean {
  return ANTHROPIC_PROVIDER_IDS.includes(providerID);
}

/** True for a POST whose path ends in `/messages`, on any host (direct or proxied). */
export function isAnthropicMessagesRequest(request: Request): boolean {
  return isPostToPathSuffix(request, MESSAGES_SUFFIX);
}

export interface ClassifyDeps {
  patterns: readonly ModelPattern[];
  learned?: (ref: ModelRef) => CacheStrategy | undefined;
}

/** The wire of an outgoing request, or `undefined` when it is neither an Anthropic Messages nor a chat completions call. */
export function requestWire(request: Request): Wire | undefined {
  if (isAnthropicMessagesRequest(request)) return "anthropic-messages";
  return isPostToPathSuffix(request, CHAT_COMPLETIONS_SUFFIX) ? "openai-chat" : undefined;
}

/**
 * Decides the wire and cache strategy of an outgoing request, or `undefined` when it is neither.
 * Precedence on `openai-chat`: user patterns, built-in Claude regex, learned, implicit.
 */
export function classifyRequest(
  request: Request,
  ref: ModelRef,
  deps: ClassifyDeps,
  bodyModel?: string,
): { wire: Wire; strategy: CacheStrategy } | undefined {
  const wire = requestWire(request);
  if (wire === undefined) return undefined;
  if (wire === "anthropic-messages") return { wire, strategy: "explicit" };

  const builtin = EXPLICIT_CACHE_MODEL.test(ref.id) || (bodyModel !== undefined && EXPLICIT_CACHE_MODEL.test(bodyModel));
  const strategy =
    matchModelPatterns(deps.patterns, ref) ?? (builtin ? "explicit" : undefined) ?? deps.learned?.(ref) ?? "implicit";
  return { wire: "openai-chat", strategy };
}

/**
 * `classifyRequest` plus `body.model` as a second look: OpenCode's model ID is its own key, while the
 * body carries the upstream ID. The body is read from a clone, and only when the first pass is
 * `implicit` on `openai-chat` and no user pattern matched, so a pattern, a Claude ID or a learned
 * `explicit` never costs a parse.
 */
export async function classifyRequestWithBody(
  request: Request,
  ref: ModelRef,
  deps: ClassifyDeps,
): Promise<{ wire: Wire; strategy: CacheStrategy } | undefined> {
  const first = classifyRequest(request, ref, deps);
  if (first?.wire !== "openai-chat" || first.strategy !== "implicit") return first;
  if (matchModelPatterns(deps.patterns, ref) !== undefined) return first;
  try {
    const body: unknown = await request.clone().json();
    const model = isRecord(body) && typeof body.model === "string" ? body.model : undefined;
    return model === undefined ? first : classifyRequest(request, ref, deps, model);
  } catch {
    return first;
  }
}

export interface RouteInput {
  cls: { wire: Wire; strategy: CacheStrategy } | undefined;
  anthropicProvider: boolean;
  hasSentinel: boolean;
  openaiCompatible: boolean;
}

export interface Route {
  /** The request body or headers are rewritten. */
  rewrites: boolean;
  /** The wire whose response and usage are observed; `undefined` leaves the request and response alone. */
  observedWire: Wire | undefined;
  /** An `openai-chat` request on an implicit-caching model (only with the option on). */
  implicit: boolean;
  /** The wire to hand `transformHttpRequest`, or `undefined` to rewrite as an Anthropic body. */
  transformWire: Wire | undefined;
  /** An `openai-chat` request on an explicit-caching model (only with the option on). */
  explicitChat: boolean;
}

/** The wire whose response is observed, or `undefined` to leave it alone. With the option off, `openai-chat` behaves as before the option existed. */
export function observedWireFor(
  wire: Wire | undefined,
  anthropicProvider: boolean,
  openaiCompatible: boolean,
): Wire | undefined {
  if (wire === "openai-chat" && openaiCompatible) return "openai-chat";
  return anthropicProvider || wire === "anthropic-messages" ? "anthropic-messages" : undefined;
}

/** Decides, from one classification, what both HTTP hooks do with a request: rewrite it, observe it, and on which wire. */
export function routeRequest({ cls, anthropicProvider, hasSentinel, openaiCompatible }: RouteInput): Route {
  const chat = cls?.wire === "openai-chat";
  const explicitChat = chat && openaiCompatible && cls.strategy === "explicit";
  const implicit = chat && openaiCompatible && cls.strategy === "implicit";
  return {
    rewrites: anthropicProvider || hasSentinel || explicitChat,
    observedWire: observedWireFor(cls?.wire, anthropicProvider, openaiCompatible),
    implicit,
    transformWire: chat && (openaiCompatible || hasSentinel) ? "openai-chat" : undefined,
    explicitChat,
  };
}

/** True when breakpoints are injected into the request: an explicit `openai-chat` primary or compaction request that is not a ping. */
export function shouldInject(route: Route, kind: RequestKind, isPing: boolean): boolean {
  return route.explicitChat && !isPing && (kind === "primary" || kind === "compaction");
}
