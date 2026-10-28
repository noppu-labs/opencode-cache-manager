import { sanitizePatch, type Settings, type SettingsPatch } from '../config/settings.ts';
import type { KeepaliveSnapshot } from '../models/keepalive.ts';
import type { KeepaliveEngine } from '../services/keepalive-engine.ts';
import type { SettingsStore } from '../services/settings-store.ts';
import { isNonEmptyString } from '../utils/is-non-empty-string.ts';

/** Rejects a patch carrying any invalid or unknown field instead of silently dropping it. */
function validatePatch(value: unknown): SettingsPatch {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid settings patch: expected an object');
  }
  const patch = sanitizePatch(value);
  const invalid = Object.keys(value).filter((key) => !(key in patch));
  if (invalid.length > 0) {
    throw new Error(`Invalid settings patch fields: ${invalid.join(', ')}`);
  }
  return patch;
}

interface RpcHandlerDeps {
  store: SettingsStore;
  engine: KeepaliveEngine;
  /** Applies a settings change to the keepalive schedule and tells the TUI; resolves to the RPC output. */
  settingsChanged: (sessionID: string | null) => Promise<object>;
}

interface CacheTtlRpcHandlers {
  getKeepalive: (input: { sessionID: string }) => Promise<KeepaliveSnapshot>;
  getSettings: (input: {
    sessionID?: string;
  }) => Promise<{ global: Settings; session: SettingsPatch | null }>;
  resetSession: (input: { sessionID: string }) => Promise<object>;
  setGlobal: (input: { patch: unknown }) => Promise<object>;
  setSession: (input: { sessionID: string; patch: unknown }) => Promise<object>;
}

/** Handlers for the `CacheTtlRpc` contract. */
function createRpcHandlers({
  store,
  engine,
  settingsChanged,
}: RpcHandlerDeps): CacheTtlRpcHandlers {
  return {
    // oxlint-disable-next-line typescript/require-await -- the snapshot is synchronous; async gives the RPC its promise and turns a throw into a rejection
    getKeepalive: async (input) => engine.snapshot(input.sessionID),
    getSettings: async (input) => ({
      global: store.global(),
      session: isNonEmptyString(input?.sessionID)
        ? await store.sessionPatch(input.sessionID)
        : null,
    }),
    resetSession: async (input) => {
      await store.resetSession(input.sessionID);
      return settingsChanged(input.sessionID);
    },
    setGlobal: async (input) => {
      await store.setGlobal(validatePatch(input.patch));
      return settingsChanged(null);
    },
    setSession: async (input) => {
      await store.setSession(input.sessionID, validatePatch(input.patch));
      return settingsChanged(input.sessionID);
    },
  };
}

export type { CacheTtlRpcHandlers, RpcHandlerDeps };
export { createRpcHandlers };
