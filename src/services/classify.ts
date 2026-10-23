import { ANTHROPIC_PROVIDER_IDS, MESSAGES_SUFFIX } from "../constants/anthropic.ts";
import { CHAT_COMPLETIONS_SUFFIX, EXPLICIT_CACHE_MODEL } from "../constants/openai.ts";
import type { CacheStrategy, ModelPattern, ModelRef, Wire } from "../models/cache.ts";
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
