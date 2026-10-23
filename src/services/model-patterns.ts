import type { CacheStrategy, ModelPattern, ModelRef } from "../models/cache.ts";

/** Strategy of the first pattern matching `"<providerID>/<id>"`, or `undefined`. */
export function matchModelPatterns(
  patterns: readonly ModelPattern[],
  ref: ModelRef,
): CacheStrategy | undefined {
  const key = `${ref.providerID}/${ref.id}`;
  for (const pattern of patterns) {
    pattern.test.lastIndex = 0;
    if (pattern.test.test(key)) return pattern.strategy;
  }
  return undefined;
}
