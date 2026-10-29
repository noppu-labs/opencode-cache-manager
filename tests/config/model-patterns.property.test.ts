import { describe, expect, test } from 'bun:test';

import fc from 'fast-check';

import { parseCacheProfiles } from '../../src/config/model-patterns.ts';
import { isCacheProfileId } from '../../src/models/cache.ts';

const profile = fc.constantFrom('anthropic', 'openai', 'implicit');
const binary = fc.string({ unit: 'binary' });

/** Plain strings, `/body/` and `/body/flags` with valid and invalid flags. */
const patternKey = fc.oneof(
  binary,
  binary.map((body) => `/${body}/`),
  fc
    .tuple(binary, fc.constantFrom('', 'i', 'u', 'iu', 'g', 'z', 'ii'))
    .map(([body, flags]) => `/${body}/${flags}`)
);

const ref = fc.record({ id: binary, providerID: binary });

describe('parseCacheProfiles properties', () => {
  test('never throws on any value, and returns only known profiles', () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        for (const pattern of parseCacheProfiles(value)) {
          expect(isCacheProfileId(pattern.profile)).toBe(true);
        }
      })
    );
  });

  test('drops entries it cannot compile, and the rest match without throwing', () => {
    fc.assert(
      fc.property(
        fc.dictionary(patternKey, profile, { noNullPrototype: true }),
        ref,
        (entries, model) => {
          const patterns = parseCacheProfiles(entries);
          expect(patterns.length).toBeLessThanOrEqual(Object.keys(entries).length);
          for (const pattern of patterns) pattern.matches(model);
        }
      )
    );
  });

  // Printable ASCII here: with binary strings a lone surrogate in the pattern can pair with one in
  // The ID, and the `u`-flag match then (correctly) sees a different code point.
  test('a plain pattern matches any model ID that contains it', () => {
    fc.assert(
      fc.property(
        fc.string().filter((source) => source !== '' && !source.startsWith('/')),
        fc.string(),
        fc.string(),
        profile,
        (source, before, after, chosen) => {
          const [pattern] = parseCacheProfiles({ [source]: chosen });
          expect(
            pattern?.matches({ id: `${before}${source}${after}`, providerID: 'provider' })
          ).toBe(true);
        }
      )
    );
  });
});
