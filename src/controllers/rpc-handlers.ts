import { sanitizePatch, type SettingsPatch } from "../config/settings.ts";
import type { KeepaliveEngine } from "../services/keepalive-engine.ts";
import type { SettingsStore } from "../services/settings-store.ts";

/** Rejects a patch carrying any invalid or unknown field instead of silently dropping it. */
function validatePatch(value: unknown): SettingsPatch {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid settings patch: expected an object");
  }
  const patch = sanitizePatch(value);
  const invalid = Object.keys(value).filter((key) => !(key in patch));
  if (invalid.length > 0) {
    throw new Error(`Invalid settings patch fields: ${invalid.join(", ")}`);
  }
  return patch;
}

export interface RpcHandlerDeps {
  store: SettingsStore;
  engine: KeepaliveEngine;
  /** Applies a settings change to the keepalive schedule and tells the TUI; resolves to the RPC output. */
  settingsChanged(sessionID: string | null): Promise<object>;
}

/** Handlers for the `CacheTtlRpc` contract. */
export function createRpcHandlers({ store, engine, settingsChanged }: RpcHandlerDeps) {
  return {
    getSettings: async (input: { sessionID?: string }) => ({
      global: store.global(),
      session: input?.sessionID ? await store.sessionPatch(input.sessionID) : null,
    }),
    setGlobal: async (input: { patch: unknown }) => {
      await store.setGlobal(validatePatch(input.patch));
      return settingsChanged(null);
    },
    setSession: async (input: { sessionID: string; patch: unknown }) => {
      await store.setSession(input.sessionID, validatePatch(input.patch));
      return settingsChanged(input.sessionID);
    },
    resetSession: async (input: { sessionID: string }) => {
      await store.resetSession(input.sessionID);
      return settingsChanged(input.sessionID);
    },
    getKeepalive: async (input: { sessionID: string }) => engine.snapshot(input.sessionID),
  };
}
