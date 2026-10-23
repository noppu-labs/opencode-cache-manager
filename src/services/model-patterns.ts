import type { CacheStrategy, ModelRef } from "../models/cache.ts";

/** A user-supplied `explicitCacheModels` entry, compiled. */
export interface ModelPattern {
  test: RegExp;
  strategy: CacheStrategy;
}

const REGEX_LITERAL = /^\/(.+)\/([a-z]*)$/;

const substring = (source: string) => new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

function validFlags(flags: string): boolean {
  try {
    new RegExp("", flags);
    return true;
  } catch {
    return false;
  }
}

/** `/body/flags` is a regex (an invalid body gives `undefined`); anything else, including bad flags like `/auto/opus`, is a substring. */
function compile(source: string): RegExp | undefined {
  const literal = REGEX_LITERAL.exec(source);
  if (!literal || !validFlags(literal[2]!)) return substring(source);
  try {
    return new RegExp(literal[1]!, literal[2]);
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
  ref: ModelRef,
): CacheStrategy | undefined {
  const key = `${ref.providerID}/${ref.id}`;
  for (const pattern of patterns) {
    pattern.test.lastIndex = 0;
    if (pattern.test.test(key)) return pattern.strategy;
  }
  return undefined;
}
