import { describe, expect, test } from 'bun:test';

import {
  BUILTIN_DEFAULTS,
  mergeSettings,
  pluginOptions,
  sanitizePatch,
  settingsFromOptions,
  type SettingsPatch,
} from '../../src/config/settings.ts';

describe('mergeSettings', () => {
  test('no layers yields the built-in defaults', () => {
    expect(mergeSettings()).toEqual(BUILTIN_DEFAULTS);
    expect(BUILTIN_DEFAULTS).toEqual({
      mode: '5m',
      keepalive: true,
      maxPings: 5,
      minContextTokens: 50_000,
      savings: true,
    });
  });

  test('savings defaults on and a layer can turn it off', () => {
    expect(mergeSettings().savings).toBe(true);
    expect(mergeSettings({ savings: false }).savings).toBe(false);
  });

  test('later layers win field by field', () => {
    expect(mergeSettings({ maxPings: 3 }, { maxPings: 7 }).maxPings).toBe(7);
    const merged = mergeSettings({ mode: '1h', maxPings: 3 }, { maxPings: 7 });
    expect(merged.mode).toBe('1h');
    expect(merged.keepalive).toBe(true);
  });
});

describe('sanitizePatch', () => {
  test('keeps valid fields', () => {
    const patch: SettingsPatch = {
      mode: 'hybrid',
      keepalive: false,
      maxPings: 0,
      minContextTokens: 0,
      savings: false,
    };
    expect(sanitizePatch(patch)).toEqual(patch);
  });

  test('drops invalid fields and unknown keys', () => {
    expect(
      sanitizePatch({
        mode: '2h',
        keepalive: 'yes',
        maxPings: 101,
        minContextTokens: -1,
        extra: 1,
      })
    ).toEqual({});
    expect(sanitizePatch({ savings: 'no' })).toEqual({});
    expect(sanitizePatch({ savings: false })).toEqual({ savings: false });
    expect(sanitizePatch({ maxPings: 1.5 })).toEqual({});
    expect(sanitizePatch({ maxPings: -1 })).toEqual({});
    expect(sanitizePatch({ minContextTokens: 1.5 })).toEqual({});
  });

  test('non-objects yield an empty patch', () => {
    expect(sanitizePatch(undefined)).toEqual({});
    expect(sanitizePatch(null)).toEqual({});
    expect(sanitizePatch('1h')).toEqual({});
    expect(sanitizePatch([])).toEqual({});
  });
});

describe('settingsFromOptions', () => {
  test('maps every option field', () => {
    expect(
      settingsFromOptions({
        defaultMode: '1h',
        keepalive: { enabled: false, maxPings: 2, minContextTokens: 20_000 },
      })
    ).toEqual({ mode: '1h', keepalive: false, maxPings: 2, minContextTokens: 20_000 });
  });

  test('drops invalid values', () => {
    expect(
      settingsFromOptions({
        defaultMode: '2h',
        keepalive: { enabled: 'x', maxPings: -1, minContextTokens: 'x' },
      })
    ).toEqual({});
    expect(settingsFromOptions({ keepalive: { maxPings: 'x' } })).toEqual({});
  });

  test('tolerates missing or malformed options', () => {
    expect(settingsFromOptions(undefined)).toEqual({});
    expect(settingsFromOptions(null)).toEqual({});
    expect(settingsFromOptions({ keepalive: 'on' })).toEqual({});
  });
});

describe('pluginOptions', () => {
  test('defaults to enabled with no patterns', () => {
    expect(pluginOptions(undefined)).toEqual({
      openaiCompatible: true,
      modelsDevPrices: false,
      cacheProfiles: [],
    });
    expect(pluginOptions({})).toEqual({
      openaiCompatible: true,
      modelsDevPrices: false,
      cacheProfiles: [],
    });
  });

  test('reads openaiCompatible only when it is a boolean', () => {
    expect(pluginOptions({ openaiCompatible: false }).openaiCompatible).toBe(false);
    expect(pluginOptions({ openaiCompatible: 'no' }).openaiCompatible).toBe(true);
    expect(pluginOptions({ openaiCompatible: 0 }).openaiCompatible).toBe(true);
  });

  test('compiles cacheProfiles and drops invalid entries', () => {
    const { cacheProfiles } = pluginOptions({
      cacheProfiles: {
        'auto/opus': 'anthropic',
        'gpt': 'openai',
        'deepseek': 'implicit',
        'x': 'bogus',
        '': 'openai',
      },
    });
    expect(cacheProfiles.map((p) => p.profile)).toEqual(['anthropic', 'openai', 'implicit']);
    expect(pluginOptions({ cacheProfiles: 'auto' }).cacheProfiles).toEqual([]);
    expect(pluginOptions({ cacheProfiles: ['auto/opus'] }).cacheProfiles).toEqual([]);
  });

  test('explicitCacheModels is ignored', () => {
    expect(pluginOptions({ explicitCacheModels: ['auto/opus'] }).cacheProfiles).toEqual([]);
  });
});

describe('savings and modelsDevPrices options', () => {
  test('savings is a top-level option, not under keepalive', () => {
    expect(settingsFromOptions({ savings: false })).toEqual({ savings: false });
    expect(settingsFromOptions({ keepalive: { savings: false } })).toEqual({});
  });

  test('modelsDevPrices defaults to false and needs a boolean', () => {
    expect(pluginOptions({}).modelsDevPrices).toBe(false);
    expect(pluginOptions({ modelsDevPrices: true }).modelsDevPrices).toBe(true);
    expect(pluginOptions({ modelsDevPrices: 'yes' }).modelsDevPrices).toBe(false);
  });
});
