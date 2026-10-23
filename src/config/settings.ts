import { isCacheTtlMode, type CacheTtlMode, type ModelPattern } from "../models/cache.ts";
import { parseModelPatterns } from "./model-patterns.ts";
import { isRecord } from "../utils/is-record.ts";

/** Effective plugin settings after layering built-in defaults, options, global and session. */
export interface Settings {
  mode: CacheTtlMode;
  keepalive: boolean;
  maxPings: number;
  minContextTokens: number;
}

/** A layer that overrides some settings and leaves the rest to lower layers. */
export type SettingsPatch = Partial<Settings>;

export const BUILTIN_DEFAULTS: Settings = {
  mode: "5m",
  keepalive: true,
  maxPings: 5,
  minContextTokens: 50_000,
};

/** Keeps only the valid fields of `value`; anything else is dropped. */
export function sanitizePatch(value: unknown): SettingsPatch {
  if (!isRecord(value)) return {};
  const patch: SettingsPatch = {};
  if (isCacheTtlMode(value.mode)) patch.mode = value.mode;
  if (typeof value.keepalive === "boolean") patch.keepalive = value.keepalive;
  if (Number.isInteger(value.maxPings) && (value.maxPings as number) >= 0 && (value.maxPings as number) <= 100) {
    patch.maxPings = value.maxPings as number;
  }
  if (Number.isInteger(value.minContextTokens) && (value.minContextTokens as number) >= 0) {
    patch.minContextTokens = value.minContextTokens as number;
  }
  return patch;
}

/** Reads the plugin options (`defaultMode`, `keepalive.*`) as a settings layer. */
export function settingsFromOptions(options: unknown): SettingsPatch {
  if (!isRecord(options)) return {};
  const keepalive = isRecord(options.keepalive) ? options.keepalive : {};
  return sanitizePatch({
    mode: options.defaultMode,
    keepalive: keepalive.enabled,
    maxPings: keepalive.maxPings,
    minContextTokens: keepalive.minContextTokens,
  });
}

/** Server-only plugin options for OpenAI-compatible endpoints; not part of the layered settings. */
export interface PluginOptions {
  openaiCompatible: boolean;
  explicitCacheModels: ModelPattern[];
}

/** Reads `openaiCompatible` (default `true`) and `explicitCacheModels`; invalid values fall back to the defaults. */
export function pluginOptions(options: unknown): PluginOptions {
  const record = isRecord(options) ? options : {};
  return {
    openaiCompatible: typeof record.openaiCompatible === "boolean" ? record.openaiCompatible : true,
    explicitCacheModels: parseModelPatterns(record.explicitCacheModels),
  };
}

/** Applies each layer over the built-in defaults; later layers win. */
export function mergeSettings(...layers: SettingsPatch[]): Settings {
  const merged: Settings = { ...BUILTIN_DEFAULTS };
  for (const layer of layers) {
    if (layer.mode !== undefined) merged.mode = layer.mode;
    if (layer.keepalive !== undefined) merged.keepalive = layer.keepalive;
    if (layer.maxPings !== undefined) merged.maxPings = layer.maxPings;
    if (layer.minContextTokens !== undefined) merged.minContextTokens = layer.minContextTokens;
  }
  return merged;
}
