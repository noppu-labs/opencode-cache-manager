import { isCacheProfileId, type ProfilePattern } from '../models/cache.ts';
import { isRecord } from '../utils/is-record.ts';

const REGEX_LITERAL = /^\/(?<body>.+)\/(?<flags>[a-z]*)$/u;
const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/gu;

const substring = (source: string) =>
  new RegExp(source.replaceAll(REGEX_SPECIALS, String.raw`\$&`), 'iu');

function validFlags(flags: string): boolean {
  try {
    // oxlint-disable-next-line eslint/no-new -- constructed only to see whether the engine accepts the flags
    new RegExp('', flags);
    return true;
  } catch {
    return false;
  }
}

/** `/body/flags` is a regex (an invalid body gives `undefined`); anything else, including bad flags like `/auto/opus`, is a substring. */
function compile(source: string): RegExp | undefined {
  const literal = REGEX_LITERAL.exec(source)?.groups;
  if (!literal || !validFlags(literal.flags)) return substring(source);
  try {
    return new RegExp(literal.body, literal.flags);
  } catch {
    return undefined;
  }
}

/** Compiles the `cacheProfiles` option; empty patterns, invalid regexes and unknown profile values are dropped. */
export function parseCacheProfiles(value: unknown): ProfilePattern[] {
  if (!isRecord(value)) return [];
  const patterns: ProfilePattern[] = [];
  for (const [source, profile] of Object.entries(value)) {
    if (source === '' || !isCacheProfileId(profile)) continue;
    const test = compile(source);
    if (test === undefined) continue;
    patterns.push({
      matches: (ref) => {
        test.lastIndex = 0;
        return test.test(`${ref.providerID}/${ref.id}`);
      },
      profile,
    });
  }
  return patterns;
}
