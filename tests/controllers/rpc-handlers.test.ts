import { describe, expect, mock, test } from "bun:test";
import { BUILTIN_DEFAULTS } from "../../src/config/settings.ts";
import { createRpcHandlers } from "../../src/controllers/rpc-handlers.ts";
import type { KeepaliveEngine } from "../../src/services/keepalive-engine.ts";
import { SettingsStore } from "../../src/services/settings-store.ts";
import { memoryKv } from "../helpers/memory-kv.ts";

async function setup(seed: Record<string, unknown> = {}) {
  const { kv, data } = memoryKv();
  for (const [key, value] of Object.entries(seed)) data.set(key, value);
  const store = new SettingsStore(kv, {});
  await store.load();
  const settingsChanged = mock(async (_sessionID: string | null): Promise<object> => ({}));
  const snapshot = mock((sessionID: string) => ({ sessionID }));
  const engine = { snapshot } as unknown as KeepaliveEngine;
  const handlers = createRpcHandlers({ store, engine, settingsChanged });
  return { handlers, data, settingsChanged, snapshot };
}

describe("createRpcHandlers", () => {
  describe("getSettings", () => {
    test("returns the built-in defaults and a null session without a session ID", async () => {
      const { handlers } = await setup();
      expect(await handlers.getSettings({})).toEqual({
        global: { mode: "5m", keepalive: true, maxPings: 5, minContextTokens: 50_000 },
        session: null,
      });
    });

    test("returns both layers for a session", async () => {
      const { handlers } = await setup({ global: { mode: "hybrid" }, "session/ses_x": { mode: "1h" } });

      const result = await handlers.getSettings({ sessionID: "ses_x" });
      expect(result.global).toEqual({ ...BUILTIN_DEFAULTS, mode: "hybrid" });
      expect(result.session).toEqual({ mode: "1h" });
    });

    test("returns an empty session patch for an unknown session", async () => {
      const { handlers } = await setup();
      expect((await handlers.getSettings({ sessionID: "ses_none" })).session).toEqual({});
    });
  });

  describe("setSession", () => {
    test("persists the patch and returns the settingsChanged result", async () => {
      const { handlers, data, settingsChanged } = await setup();
      settingsChanged.mockResolvedValueOnce({ ok: true });

      const result = await handlers.setSession({ sessionID: "ses_x", patch: { mode: "hybrid" } });

      expect(result).toEqual({ ok: true });
      expect(data.get("session/ses_x")).toEqual({ mode: "hybrid" });
      expect(settingsChanged).toHaveBeenCalledTimes(1);
      expect(settingsChanged).toHaveBeenCalledWith("ses_x");
      expect((await handlers.getSettings({ sessionID: "ses_x" })).session).toEqual({ mode: "hybrid" });
    });

    test("leaves the global layer alone", async () => {
      const { handlers, data } = await setup();
      await handlers.setSession({ sessionID: "ses_x", patch: { maxPings: 2 } });
      expect(data.has("global")).toBe(false);
    });

    test("merges into the existing session patch", async () => {
      const { handlers, data } = await setup();
      await handlers.setSession({ sessionID: "ses_x", patch: { mode: "1h" } });
      await handlers.setSession({ sessionID: "ses_x", patch: { keepalive: false } });
      expect(data.get("session/ses_x")).toEqual({ mode: "1h", keepalive: false });
    });
  });

  describe("setGlobal", () => {
    test("persists the patch and returns the settingsChanged result", async () => {
      const { handlers, data, settingsChanged } = await setup();
      settingsChanged.mockResolvedValueOnce({ ok: true });

      const result = await handlers.setGlobal({ patch: { mode: "1h", maxPings: 2 } });

      expect(result).toEqual({ ok: true });
      expect(data.get("global")).toEqual({ mode: "1h", maxPings: 2 });
      expect(settingsChanged).toHaveBeenCalledTimes(1);
      expect(settingsChanged).toHaveBeenCalledWith(null);
      expect((await handlers.getSettings({})).global.mode).toBe("1h");
    });
  });

  describe("resetSession", () => {
    test("clears the session patch and returns the settingsChanged result", async () => {
      const { handlers, data, settingsChanged } = await setup({ "session/ses_x": { mode: "1h" } });
      settingsChanged.mockResolvedValueOnce({ ok: true });

      const result = await handlers.resetSession({ sessionID: "ses_x" });

      expect(result).toEqual({ ok: true });
      expect(data.has("session/ses_x")).toBe(false);
      expect(settingsChanged).toHaveBeenCalledTimes(1);
      expect(settingsChanged).toHaveBeenCalledWith("ses_x");
      expect((await handlers.getSettings({ sessionID: "ses_x" })).session).toEqual({});
    });
  });

  describe("getKeepalive", () => {
    test("returns the engine snapshot for the session", async () => {
      const { handlers, snapshot } = await setup();
      expect(await handlers.getKeepalive({ sessionID: "ses_x" })).toEqual({ sessionID: "ses_x" });
      expect(snapshot).toHaveBeenCalledWith("ses_x");
    });
  });

  describe("patch validation", () => {
    test("rejected patches change no state and notify nobody", async () => {
      const { handlers, data, settingsChanged } = await setup();

      await expect(handlers.setSession({ sessionID: "ses_x", patch: { mode: "bogus" } })).rejects.toThrow();
      await expect(handlers.setSession({ sessionID: "ses_x", patch: { maxPings: 101 } })).rejects.toThrow();
      await expect(handlers.setGlobal({ patch: { minContextTokens: -1 } })).rejects.toThrow();
      await expect(handlers.setGlobal({ patch: { unknown: 1 } })).rejects.toThrow();
      await expect(handlers.setGlobal({ patch: "1h" })).rejects.toThrow();

      expect(data.size).toBe(0);
      expect(settingsChanged).not.toHaveBeenCalled();
      expect((await handlers.getSettings({})).global.mode).toBe("5m");
    });

    test.each([["a string", "1h"], ["null", null], ["an array", [{ mode: "1h" }]], ["a number", 5]])(
      "rejects %s as a non-object patch",
      async (_label, patch) => {
        const { handlers, data } = await setup();
        await expect(handlers.setSession({ sessionID: "ses_x", patch })).rejects.toThrow(
          "Invalid settings patch: expected an object",
        );
        await expect(handlers.setGlobal({ patch })).rejects.toThrow("Invalid settings patch: expected an object");
        expect(data.size).toBe(0);
      },
    );

    test("names every invalid field in the error", async () => {
      const { handlers } = await setup();
      await expect(
        handlers.setGlobal({ patch: { mode: "bogus", maxPings: 1, extra: true } }),
      ).rejects.toThrow("Invalid settings patch fields: mode, extra");
    });

    test("one invalid field rejects the whole patch", async () => {
      const { handlers, data } = await setup();
      await expect(
        handlers.setSession({ sessionID: "ses_x", patch: { mode: "1h", maxPings: 101 } }),
      ).rejects.toThrow();
      expect(data.size).toBe(0);
    });

    test("an empty patch is accepted", async () => {
      const { handlers, settingsChanged } = await setup();
      await handlers.setSession({ sessionID: "ses_x", patch: {} });
      expect(settingsChanged).toHaveBeenCalledWith("ses_x");
    });
  });
});
