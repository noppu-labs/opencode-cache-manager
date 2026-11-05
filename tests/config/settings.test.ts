import { describe, expect, mock, test } from 'bun:test';
import os from 'node:os';
import { join } from 'node:path';

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

describe('debug option', () => {
  const defaultPath = join(os.homedir(), 'opencode-cache-manager-debug.jsonl');

  test('absent, false or a non-object value means off', () => {
    expect(pluginOptions(undefined).debug).toBeUndefined();
    expect(pluginOptions({ debug: false }).debug).toBeUndefined();
    expect(pluginOptions({ debug: 'yes' }).debug).toBeUndefined();
    expect(pluginOptions({ debug: 1 }).debug).toBeUndefined();
  });

  test('enabled: false means off, whatever else the object sets', () => {
    expect(pluginOptions({ debug: { enabled: false } }).debug).toBeUndefined();
    expect(
      pluginOptions({ debug: { bodies: true, enabled: false, path: '/tmp/t.jsonl' } }).debug
    ).toBeUndefined();
  });

  test('enabled: true, or any other value, leaves logging on', () => {
    expect(pluginOptions({ debug: { enabled: true } }).debug).toEqual({
      bodies: false,
      path: defaultPath,
    });
    expect(pluginOptions({ debug: { enabled: 'no' } }).debug?.path).toBe(defaultPath);
  });

  test('true or an empty object writes metadata to the default file', () => {
    expect(pluginOptions({ debug: true }).debug).toEqual({ bodies: false, path: defaultPath });
    expect(pluginOptions({ debug: {} }).debug).toEqual({ bodies: false, path: defaultPath });
  });

  test('an object chooses the file and turns on bodies', () => {
    expect(pluginOptions({ debug: { bodies: true, path: '/tmp/t.jsonl' } }).debug).toEqual({
      bodies: true,
      path: '/tmp/t.jsonl',
    });
  });

  test('a leading ~/ expands to the home folder', () => {
    expect(pluginOptions({ debug: { path: '~/t.jsonl' } }).debug?.path).toBe(
      join(os.homedir(), 't.jsonl')
    );
  });

  test('an invalid path means off, not the default file', () => {
    expect(pluginOptions({ debug: { path: 't.jsonl' } }).debug).toBeUndefined();
    expect(pluginOptions({ debug: { path: '~' } }).debug).toBeUndefined();
    expect(pluginOptions({ debug: { path: '~/' } }).debug).toBeUndefined();
    expect(pluginOptions({ debug: { path: '' } }).debug).toBeUndefined();
    expect(pluginOptions({ debug: { path: 3 } }).debug).toBeUndefined();
  });

  describe('when the home folder cannot be read', () => {
    // A user with no passwd entry and no HOME, as in a container run under an arbitrary UID.
    const homeless = <Result>(run: () => Result): Result => {
      const real = { ...os, default: os };
      void mock.module('node:os', () => ({
        ...real,
        homedir: () => {
          throw new Error('ENOENT: no such file or directory, uv_os_homedir');
        },
      }));
      try {
        return run();
      } finally {
        void mock.module('node:os', () => real);
      }
    };

    test('the default file and a ~/ path mean off instead of throwing', () => {
      expect(homeless(() => pluginOptions({ debug: true }).debug)).toBeUndefined();
      expect(homeless(() => pluginOptions({ debug: {} }).debug)).toBeUndefined();
      expect(homeless(() => pluginOptions({ debug: { path: '~/t.jsonl' } }).debug)).toBeUndefined();
    });

    test('an absolute path does not need it', () => {
      expect(homeless(() => pluginOptions({ debug: { path: '/tmp/t.jsonl' } }).debug)).toEqual({
        bodies: false,
        path: '/tmp/t.jsonl',
      });
    });

    test('the home folder is read again afterwards', () => {
      homeless(() => pluginOptions({ debug: true }));
      expect(pluginOptions({ debug: true }).debug?.path).toBe(defaultPath);
    });
  });

  test('content needs an explicit opt-in', () => {
    expect(pluginOptions({ debug: { bodies: 'yes' } }).debug?.bodies).toBe(false);
  });
});
