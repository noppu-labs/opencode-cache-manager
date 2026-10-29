import { describe, expect, test } from 'bun:test';

import fc from 'fast-check';

import {
  MAX_PINGS_LIMIT,
  mergeSettings,
  pluginOptions,
  sanitizePatch,
  settingsFromOptions,
  type Settings,
  type SettingsPatch,
} from '../../src/config/settings.ts';
import { isCacheProfileId, isCacheTtlMode } from '../../src/models/cache.ts';
import { mode } from '../helpers/arbitraries.ts';

const validPatch: fc.Arbitrary<SettingsPatch> = fc.record(
  {
    keepalive: fc.boolean(),
    maxPings: fc.integer({ max: MAX_PINGS_LIMIT, min: 0 }),
    minContextTokens: fc.nat(),
    mode,
  },
  { requiredKeys: [] }
);

const options = fc.oneof(
  fc.anything(),
  fc.record(
    {
      cacheProfiles: fc.anything(),
      defaultMode: fc.oneof(mode, fc.anything()),
      keepalive: fc.oneof(
        fc.anything(),
        fc.record(
          {
            enabled: fc.anything(),
            maxPings: fc.oneof(fc.integer(), fc.double(), fc.anything()),
            minContextTokens: fc.oneof(fc.integer(), fc.double(), fc.anything()),
          },
          { requiredKeys: [] }
        )
      ),
      openaiCompatible: fc.anything(),
    },
    { requiredKeys: [] }
  )
);

function expectValidSettings(settings: Settings): void {
  expect(isCacheTtlMode(settings.mode)).toBe(true);
  expect(typeof settings.keepalive).toBe('boolean');
  expect(Number.isInteger(settings.maxPings)).toBe(true);
  expect(settings.maxPings).toBeGreaterThanOrEqual(0);
  expect(settings.maxPings).toBeLessThanOrEqual(MAX_PINGS_LIMIT);
  expect(Number.isInteger(settings.minContextTokens)).toBe(true);
  expect(settings.minContextTokens).toBeGreaterThanOrEqual(0);
}

describe('settings properties', () => {
  test('settingsFromOptions never throws and returns a valid patch', () => {
    fc.assert(
      fc.property(options, (value) => {
        const patch = settingsFromOptions(value);
        expect(sanitizePatch(patch)).toEqual(patch);
        expectValidSettings(mergeSettings(patch));
      })
    );
  });

  test('sanitizePatch keeps a valid patch unchanged', () => {
    fc.assert(
      fc.property(validPatch, (patch) => {
        expect(sanitizePatch(patch)).toEqual(patch);
      })
    );
  });

  test('mergeSettings is valid and the last layer that sets a field wins', () => {
    fc.assert(
      fc.property(fc.array(validPatch, { maxLength: 4 }), (layers) => {
        const merged = mergeSettings(...layers);
        expectValidSettings(merged);
        for (const key of ['keepalive', 'maxPings', 'minContextTokens', 'mode'] as const) {
          const expected = layers.findLast((layer) => layer[key] !== undefined)?.[key];
          if (expected !== undefined) expect(merged[key]).toBe(expected);
        }
      })
    );
  });

  test('pluginOptions never throws and returns known profiles', () => {
    fc.assert(
      fc.property(options, (value) => {
        const parsed = pluginOptions(value);
        expect(typeof parsed.openaiCompatible).toBe('boolean');
        for (const pattern of parsed.cacheProfiles) {
          expect(isCacheProfileId(pattern.profile)).toBe(true);
        }
      })
    );
  });
});
