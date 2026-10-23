import type { CacheProfileId, ModelRef, ProfilePattern } from "../models/cache.ts";

/** Profile of the first pattern matching `"<providerID>/<id>"`, or `undefined`. */
export function matchProfilePatterns(
  patterns: readonly ProfilePattern[],
  ref: ModelRef,
): CacheProfileId | undefined {
  return patterns.find((pattern) => pattern.matches(ref))?.profile;
}
