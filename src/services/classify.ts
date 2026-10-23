import { CHAT_COMPLETIONS_SUFFIX, EXPLICIT_CACHE_MODEL } from "../constants/openai.ts";
import type { CacheStrategy, Wire } from "../models/cache.ts";
import { matchModelPatterns, type ModelPattern } from "./model-patterns.ts";
import { isAnthropicMessagesRequest } from "./usage.ts";

export interface ClassifyDeps {
  patterns: readonly ModelPattern[];
  learned?: (ref: { providerID: string; id: string }) => CacheStrategy | undefined;
}

function isChatCompletionsRequest(request: Request): boolean {
  if (request.method !== "POST") return false;
  try {
    return new URL(request.url).pathname.endsWith(CHAT_COMPLETIONS_SUFFIX);
  } catch {
    return false;
  }
}

/**
 * Decides the wire and cache strategy of an outgoing request, or `undefined` when it is neither.
 * Precedence on `openai-chat`: user patterns, built-in Claude regex, learned, implicit.
 */
export function classifyRequest(
  request: Request,
  ref: { providerID: string; id: string },
  deps: ClassifyDeps,
  bodyModel?: string,
): { wire: Wire; strategy: CacheStrategy } | undefined {
  if (isAnthropicMessagesRequest(request)) return { wire: "anthropic-messages", strategy: "explicit" };
  if (!isChatCompletionsRequest(request)) return undefined;

  const builtin = EXPLICIT_CACHE_MODEL.test(ref.id) || (bodyModel !== undefined && EXPLICIT_CACHE_MODEL.test(bodyModel));
  const strategy =
    matchModelPatterns(deps.patterns, ref) ?? (builtin ? "explicit" : undefined) ?? deps.learned?.(ref) ?? "implicit";
  return { wire: "openai-chat", strategy };
}
