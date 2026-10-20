import { isCacheTtlMode, type CacheTtlMode } from "./shared.ts";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

export interface KV {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

const GLOBAL_KEY = "global";
const LEGACY_MODE_KEY = "mode";
const sessionKey = (sessionID: string) => `session/${sessionID}`;

/** Layered settings: built-in defaults < plugin options < stored global < stored per-session. */
export class SettingsStore {
  private storedGlobal: SettingsPatch = {};
  private readonly sessions = new Map<string, SettingsPatch>();

  constructor(
    private readonly kv: KV,
    private readonly optionsPatch: SettingsPatch,
  ) {}

  async load(): Promise<void> {
    this.storedGlobal = sanitizePatch(await this.kv.get(GLOBAL_KEY));
    if (this.storedGlobal.mode === undefined) {
      const legacy = await this.kv.get(LEGACY_MODE_KEY);
      if (isCacheTtlMode(legacy)) this.storedGlobal = { ...this.storedGlobal, mode: legacy };
    }
  }

  global(): Settings {
    return mergeSettings(this.optionsPatch, this.storedGlobal);
  }

  async sessionPatch(sessionID: string): Promise<SettingsPatch> {
    let patch = this.sessions.get(sessionID);
    if (patch === undefined) {
      patch = sanitizePatch(await this.kv.get(sessionKey(sessionID)));
      this.sessions.set(sessionID, patch);
    }
    return patch;
  }

  async effective(sessionID: string): Promise<Settings> {
    return mergeSettings(this.optionsPatch, this.storedGlobal, await this.sessionPatch(sessionID));
  }

  async setGlobal(patch: SettingsPatch): Promise<void> {
    this.storedGlobal = { ...this.storedGlobal, ...patch };
    await this.kv.set(GLOBAL_KEY, this.storedGlobal);
  }

  async setSession(sessionID: string, patch: SettingsPatch): Promise<void> {
    const merged = { ...(await this.sessionPatch(sessionID)), ...patch };
    this.sessions.set(sessionID, merged);
    await this.kv.set(sessionKey(sessionID), merged);
  }

  async resetSession(sessionID: string): Promise<void> {
    this.sessions.set(sessionID, {});
    await this.kv.remove(sessionKey(sessionID));
  }
}
