import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { DEBUG_HOME_PATH_PREFIX, DEBUG_LOG_FILENAME } from '../constants/debug.ts';
import { isCacheTtlMode, type CacheTtlMode, type ProfilePattern } from '../models/cache.ts';
import { isNonEmptyString } from '../utils/is-non-empty-string.ts';
import { isRecord } from '../utils/is-record.ts';
import { parseCacheProfiles } from './model-patterns.ts';

/** Highest accepted `maxPings`. */
const MAX_PINGS_LIMIT = 100;

/** Effective plugin settings after layering built-in defaults, options, global and session. */
interface Settings {
  mode: CacheTtlMode;
  keepalive: boolean;
  maxPings: number;
  minContextTokens: number;
  savings: boolean;
}

/** A layer that overrides some settings and leaves the rest to lower layers. */
type SettingsPatch = Partial<Settings>;

const BUILTIN_DEFAULTS: Settings = {
  keepalive: true,
  maxPings: 5,
  minContextTokens: 50_000,
  mode: '5m',
  savings: true,
};

/** Keeps only the valid fields of `value`; anything else is dropped. */
function sanitizePatch(value: unknown): SettingsPatch {
  if (!isRecord(value)) return {};
  const patch: SettingsPatch = {};
  if (isCacheTtlMode(value.mode)) patch.mode = value.mode;
  if (typeof value.keepalive === 'boolean') patch.keepalive = value.keepalive;
  if (typeof value.savings === 'boolean') patch.savings = value.savings;
  if (isNonNegativeInteger(value.maxPings) && value.maxPings <= MAX_PINGS_LIMIT) {
    patch.maxPings = value.maxPings;
  }
  if (isNonNegativeInteger(value.minContextTokens)) {
    patch.minContextTokens = value.minContextTokens;
  }
  return patch;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Reads the plugin options (`defaultMode`, `keepalive.*`, `savings`) as a settings layer. */
function settingsFromOptions(options: unknown): SettingsPatch {
  if (!isRecord(options)) return {};
  const keepalive = isRecord(options.keepalive) ? options.keepalive : {};
  return sanitizePatch({
    keepalive: keepalive.enabled,
    maxPings: keepalive.maxPings,
    minContextTokens: keepalive.minContextTokens,
    mode: options.defaultMode,
    savings: options.savings,
  });
}

/** Where the debug trace goes, and whether it may hold response content. */
interface DebugOptions {
  path: string;
  bodies: boolean;
}

/** Server-only plugin options for OpenAI-compatible endpoints; not part of the layered settings. */
interface PluginOptions {
  openaiCompatible: boolean;
  cacheProfiles: ProfilePattern[];
  modelsDevPrices: boolean;
  debug?: DebugOptions;
}

/** An absolute path, or a file under `~/` expanded; anything else is `undefined`. */
function parseDebugPath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (value.startsWith(DEBUG_HOME_PATH_PREFIX)) {
    const file = value.slice(DEBUG_HOME_PATH_PREFIX.length);
    return isNonEmptyString(file) ? join(homedir(), file) : undefined;
  }
  return isAbsolute(value) ? value : undefined;
}

/** Off unless `value` is `true` or an object. An invalid path means off, not the default file. */
function parseDebugOption(value: unknown): DebugOptions | undefined {
  if (value !== true && !isRecord(value)) return undefined;
  const record = isRecord(value) ? value : {};
  const path =
    record.path === undefined ? join(homedir(), DEBUG_LOG_FILENAME) : parseDebugPath(record.path);
  return path === undefined ? undefined : { bodies: record.bodies === true, path };
}

/**
 * Reads `openaiCompatible` (default `true`), `modelsDevPrices` (default `false`),
 * `cacheProfiles` and `debug` (default off); invalid values fall back to the defaults.
 */
function pluginOptions(options: unknown): PluginOptions {
  const record = isRecord(options) ? options : {};
  return {
    cacheProfiles: parseCacheProfiles(record.cacheProfiles),
    debug: parseDebugOption(record.debug),
    modelsDevPrices: typeof record.modelsDevPrices === 'boolean' ? record.modelsDevPrices : false,
    openaiCompatible: typeof record.openaiCompatible === 'boolean' ? record.openaiCompatible : true,
  };
}

/** Applies each layer over the built-in defaults; later layers win. */
function mergeSettings(...layers: SettingsPatch[]): Settings {
  const merged: Settings = { ...BUILTIN_DEFAULTS };
  for (const layer of layers) {
    if (layer.mode !== undefined) merged.mode = layer.mode;
    if (layer.keepalive !== undefined) merged.keepalive = layer.keepalive;
    if (layer.maxPings !== undefined) merged.maxPings = layer.maxPings;
    if (layer.minContextTokens !== undefined) merged.minContextTokens = layer.minContextTokens;
    if (layer.savings !== undefined) merged.savings = layer.savings;
  }
  return merged;
}

export type { DebugOptions, Settings, SettingsPatch, PluginOptions };
export {
  BUILTIN_DEFAULTS,
  MAX_PINGS_LIMIT,
  sanitizePatch,
  settingsFromOptions,
  pluginOptions,
  mergeSettings,
};
