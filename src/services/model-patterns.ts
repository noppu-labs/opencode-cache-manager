import type { CacheStrategy } from "../models/cache.ts";

/** A user-supplied `explicitCacheModels` entry, compiled. */
export interface ModelPattern {
  test: RegExp;
  strategy: CacheStrategy;
}

const REGEX_LITERAL = /^\/(.+)\/([a-z]*)$/;

function compile(source: string): RegExp | undefined {
  try {
    const literal = REGEX_LITERAL.exec(source);
    return literal ? new RegExp(literal[1]!, literal[2]) : new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  } catch {
    return undefined;
  }
}

/** Compiles the `explicitCacheModels` option; invalid, empty and non-string entries are dropped. */
export function parseModelPatterns(value: unknown): ModelPattern[] {
  if (!Array.isArray(value)) return [];
  const patterns: ModelPattern[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const negated = entry.startsWith("!");
    const test = compile(negated ? entry.slice(1) : entry);
    if (test === undefined || entry === "" || entry === "!") continue;
    patterns.push({ test, strategy: negated ? "implicit" : "explicit" });
  }
  return patterns;
}

/** Strategy of the first pattern matching `"<providerID>/<id>"`, or `undefined`. */
export function matchModelPatterns(
  patterns: readonly ModelPattern[],
  ref: { providerID: string; id: string },
): CacheStrategy | undefined {
  const key = `${ref.providerID}/${ref.id}`;
  for (const pattern of patterns) {
    pattern.test.lastIndex = 0;
    if (pattern.test.test(key)) return pattern.strategy;
  }
  return undefined;
}
