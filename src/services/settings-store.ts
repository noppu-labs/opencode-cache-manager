import {
  mergeSettings,
  sanitizePatch,
  type Settings,
  type SettingsPatch,
} from '../config/settings.ts';
import { isCacheTtlMode } from '../models/cache.ts';
import type { KV, ScannableKV } from '../models/storage.ts';

const GLOBAL_KEY = 'global';
const LEGACY_MODE_KEY = 'mode';
const SESSION_KEY_PREFIX = 'session/';
const sessionKey = (sessionID: string) => `${SESSION_KEY_PREFIX}${sessionID}`;

/** Layered settings: built-in defaults < plugin options < stored global < stored per-session. */
export class SettingsStore {
  private storedGlobal: SettingsPatch = {};
  private readonly sessions = new Map<string, SettingsPatch>();

  constructor(
    private readonly kv: KV,
    private readonly optionsPatch: SettingsPatch
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

function isSessionNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { _tag, name } = error as { _tag?: unknown; name?: unknown };
  return [_tag, name].some((tag) => typeof tag === 'string' && /SessionNotFound/.test(tag));
}

/** Drops stored settings for sessions that were deleted while the plugin was not running. */
export async function sweepDeletedSessions(
  storage: ScannableKV,
  getSession: (sessionID: string) => Promise<unknown>
): Promise<void> {
  let after: string | undefined;
  do {
    const page = await storage.scan({ prefix: SESSION_KEY_PREFIX, ...(after ? { after } : {}) });
    for (const entry of page.entries) {
      const sessionID = entry.key.startsWith(SESSION_KEY_PREFIX)
        ? entry.key.slice(SESSION_KEY_PREFIX.length)
        : entry.key;
      try {
        await getSession(sessionID);
      } catch (error) {
        if (isSessionNotFound(error)) await storage.remove(entry.key);
      }
    }
    after = page.next;
  } while (after);
}
