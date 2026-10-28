import { isCacheTtlMode, type CacheTtlMode, type ProfilePattern } from '../models/cache.ts';
import { isRecord } from '../utils/is-record.ts';
import { parseCacheProfiles } from './model-patterns.ts';

/** Effective plugin settings after layering built-in defaults, options, global and session. */
interface Settings {
  mode: CacheTtlMode;
  keepalive: boolean;
  maxPings: number;
  minContextTokens: number;
}

/** A layer that overrides some settings and leaves the rest to lower layers. */
type SettingsPatch = Partial<Settings>;

const BUILTIN_DEFAULTS: Settings = {
  keepalive: true,
  maxPings: 5,
  minContextTokens: 50_000,
  mode: '5m',
};

/** Keeps only the valid fields of `value`; anything else is dropped. */
function sanitizePatch(value: unknown): SettingsPatch {
  if (!isRecord(value)) return {};
  const patch: SettingsPatch = {};
  if (isCacheTtlMode(value.mode)) patch.mode = value.mode;
  if (typeof value.keepalive === 'boolean') patch.keepalive = value.keepalive;
  if (isNonNegativeInteger(value.maxPings) && value.maxPings <= 100) {
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

/** Reads the plugin options (`defaultMode`, `keepalive.*`) as a settings layer. */
function settingsFromOptions(options: unknown): SettingsPatch {
  if (!isRecord(options)) return {};
  const keepalive = isRecord(options.keepalive) ? options.keepalive : {};
  return sanitizePatch({
    keepalive: keepalive.enabled,
    maxPings: keepalive.maxPings,
    minContextTokens: keepalive.minContextTokens,
    mode: options.defaultMode,
  });
}

/** Server-only plugin options for OpenAI-compatible endpoints; not part of the layered settings. */
interface PluginOptions {
  openaiCompatible: boolean;
  cacheProfiles: ProfilePattern[];
}

/** Reads `openaiCompatible` (default `true`) and `cacheProfiles`; invalid values fall back to the defaults. */
function pluginOptions(options: unknown): PluginOptions {
  const record = isRecord(options) ? options : {};
  return {
    cacheProfiles: parseCacheProfiles(record.cacheProfiles),
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
  }
  return merged;
}

export type { Settings, SettingsPatch, PluginOptions };
export { BUILTIN_DEFAULTS, sanitizePatch, settingsFromOptions, pluginOptions, mergeSettings };
