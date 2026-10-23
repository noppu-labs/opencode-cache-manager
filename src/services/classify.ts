import { CHAT_COMPLETIONS_SUFFIX, EXPLICIT_CACHE_MODEL } from "../constants/openai.ts";
import type { CacheStrategy, ModelRef, Wire } from "../models/cache.ts";
import { matchModelPatterns, type ModelPattern } from "./model-patterns.ts";
import { isPostToPathSuffix } from "../utils/request-path.ts";
import { isAnthropicMessagesRequest } from "./usage.ts";

export interface ClassifyDeps {
  patterns: readonly ModelPattern[];
  learned?: (ref: ModelRef) => CacheStrategy | undefined;
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
  if (isAnthropicMessagesRequest(request)) return { wire: "anthropic-messages", strategy: "explicit" };
  if (!isPostToPathSuffix(request, CHAT_COMPLETIONS_SUFFIX)) return undefined;

  const builtin = EXPLICIT_CACHE_MODEL.test(ref.id) || (bodyModel !== undefined && EXPLICIT_CACHE_MODEL.test(bodyModel));
  const strategy =
    matchModelPatterns(deps.patterns, ref) ?? (builtin ? "explicit" : undefined) ?? deps.learned?.(ref) ?? "implicit";
  return { wire: "openai-chat", strategy };
}
