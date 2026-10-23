import type { CacheProfileId, ProfilePattern } from "../models/cache.ts";
import { isRecord } from "../utils/is-record.ts";

const REGEX_LITERAL = /^\/(.+)\/([a-z]*)$/;
const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;

const substring = (source: string) => new RegExp(source.replace(REGEX_SPECIALS, "\\$&"), "i");

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

function isCacheProfileId(value: unknown): value is CacheProfileId {
  return value === "anthropic" || value === "openai" || value === "implicit";
}

/** Compiles the `cacheProfiles` option; empty patterns, invalid regexes and unknown profile values are dropped. */
export function parseCacheProfiles(value: unknown): ProfilePattern[] {
  if (!isRecord(value)) return [];
  const patterns: ProfilePattern[] = [];
  for (const [source, profile] of Object.entries(value)) {
    if (source === "" || !isCacheProfileId(profile)) continue;
    const test = compile(source);
    if (test === undefined) continue;
    patterns.push({
      profile,
      matches: (ref) => {
        test.lastIndex = 0;
        return test.test(`${ref.providerID}/${ref.id}`);
      },
    });
  }
  return patterns;
}
