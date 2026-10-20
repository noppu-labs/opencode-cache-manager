import { describe, expect, test } from "bun:test";
import {
  BUILTIN_DEFAULTS,
  SettingsStore,
  mergeSettings,
  sanitizePatch,
  settingsFromOptions,
  type KV,
} from "../settings.ts";

function memoryKv() {
  const data = new Map<string, unknown>();
  const kv: KV = {
    get: async (key) => data.get(key),
    set: async (key, value) => {
      data.set(key, value);
    },
    remove: async (key) => {
      data.delete(key);
    },
  };
  return { kv, data };
}

describe("mergeSettings", () => {
  test("no layers yields the built-in defaults", () => {
    expect(mergeSettings()).toEqual(BUILTIN_DEFAULTS);
    expect(BUILTIN_DEFAULTS).toEqual({
      mode: "5m",
      keepalive: true,
      maxPings: 5,
      minContextTokens: 50_000,
    });
  });

  test("later layers win field by field", () => {
    expect(mergeSettings({ maxPings: 3 }, { maxPings: 7 }).maxPings).toBe(7);
    const merged = mergeSettings({ mode: "1h", maxPings: 3 }, { maxPings: 7 });
    expect(merged.mode).toBe("1h");
    expect(merged.keepalive).toBe(true);
  });
});

describe("sanitizePatch", () => {
  test("keeps valid fields", () => {
    const patch = { mode: "hybrid", keepalive: false, maxPings: 0, minContextTokens: 0 };
    expect(sanitizePatch(patch)).toEqual(patch);
  });

  test("drops invalid fields and unknown keys", () => {
    expect(
      sanitizePatch({
        mode: "2h",
        keepalive: "yes",
        maxPings: 101,
        minContextTokens: -1,
        extra: 1,
      }),
    ).toEqual({});
    expect(sanitizePatch({ maxPings: 1.5 })).toEqual({});
    expect(sanitizePatch({ maxPings: -1 })).toEqual({});
    expect(sanitizePatch({ minContextTokens: 1.5 })).toEqual({});
  });

  test("non-objects yield an empty patch", () => {
    expect(sanitizePatch(undefined)).toEqual({});
    expect(sanitizePatch(null)).toEqual({});
    expect(sanitizePatch("1h")).toEqual({});
    expect(sanitizePatch([])).toEqual({});
  });
});

describe("settingsFromOptions", () => {
  test("maps every option field", () => {
    expect(
      settingsFromOptions({
        defaultMode: "1h",
        keepalive: { enabled: false, maxPings: 2, minContextTokens: 20000 },
      }),
    ).toEqual({ mode: "1h", keepalive: false, maxPings: 2, minContextTokens: 20000 });
  });

  test("drops invalid values", () => {
    expect(
      settingsFromOptions({
        defaultMode: "2h",
        keepalive: { enabled: "x", maxPings: -1, minContextTokens: "x" },
      }),
    ).toEqual({});
    expect(settingsFromOptions({ keepalive: { maxPings: "x" } })).toEqual({});
  });

  test("tolerates missing or malformed options", () => {
    expect(settingsFromOptions(undefined)).toEqual({});
    expect(settingsFromOptions(null)).toEqual({});
    expect(settingsFromOptions({ keepalive: "on" })).toEqual({});
  });
});

describe("SettingsStore", () => {
  test("global() layers options over built-in defaults", async () => {
    const { kv } = memoryKv();
    const store = new SettingsStore(kv, { mode: "1h", maxPings: 2 });
    await store.load();
    expect(store.global()).toEqual({ ...BUILTIN_DEFAULTS, mode: "1h", maxPings: 2 });
  });

  test("stored global overrides options", async () => {
    const { kv, data } = memoryKv();
    data.set("global", { mode: "hybrid" });
    const store = new SettingsStore(kv, { mode: "1h" });
    await store.load();
    expect(store.global().mode).toBe("hybrid");
  });

  test("the legacy mode key seeds global mode", async () => {
    const { kv, data } = memoryKv();
    data.set("mode", "hybrid");
    const store = new SettingsStore(kv, { mode: "1h" });
    await store.load();
    expect(store.global().mode).toBe("hybrid");
  });

  test("the legacy mode key is ignored when global already has a mode", async () => {
    const { kv, data } = memoryKv();
    data.set("mode", "hybrid");
    data.set("global", { mode: "1h" });
    const store = new SettingsStore(kv, {});
    await store.load();
    expect(store.global().mode).toBe("1h");
  });

  test("an invalid legacy mode is ignored", async () => {
    const { kv, data } = memoryKv();
    data.set("mode", "banana");
    const store = new SettingsStore(kv, {});
    await store.load();
    expect(store.global().mode).toBe("5m");
  });

  test("a session patch overrides only its own fields", async () => {
    const { kv } = memoryKv();
    const store = new SettingsStore(kv, { mode: "hybrid", maxPings: 9 });
    await store.load();
    await store.setSession("ses_a", { mode: "1h" });
    expect(await store.effective("ses_a")).toEqual({
      ...BUILTIN_DEFAULTS,
      mode: "1h",
      maxPings: 9,
    });
    expect((await store.effective("ses_b")).mode).toBe("hybrid");
  });

  test("setSession merges into the existing patch and persists it", async () => {
    const { kv, data } = memoryKv();
    const store = new SettingsStore(kv, {});
    await store.load();
    await store.setSession("ses_a", { mode: "1h" });
    await store.setSession("ses_a", { keepalive: false });
    expect(data.get("session/ses_a")).toEqual({ mode: "1h", keepalive: false });
    expect(await store.sessionPatch("ses_a")).toEqual({ mode: "1h", keepalive: false });
  });

  test("sessionPatch reads storage once and then serves from memory", async () => {
    const { kv, data } = memoryKv();
    data.set("session/ses_a", { mode: "1h", maxPings: 500 });
    let reads = 0;
    const counting: KV = {
      ...kv,
      get: async (key) => {
        reads++;
        return kv.get(key);
      },
    };
    const store = new SettingsStore(counting, {});
    await store.load();
    const before = reads;
    expect(await store.sessionPatch("ses_a")).toEqual({ mode: "1h" });
    await store.sessionPatch("ses_a");
    expect(reads - before).toBe(1);
  });

  test("resetSession falls back to global and removes the key", async () => {
    const { kv, data } = memoryKv();
    const store = new SettingsStore(kv, {});
    await store.load();
    await store.setGlobal({ mode: "hybrid" });
    await store.setSession("ses_a", { mode: "1h" });
    await store.resetSession("ses_a");
    expect(data.has("session/ses_a")).toBe(false);
    expect((await store.effective("ses_a")).mode).toBe("hybrid");
    expect(await store.sessionPatch("ses_a")).toEqual({});
  });

  test("setGlobal persists under the global key and merges", async () => {
    const { kv, data } = memoryKv();
    const store = new SettingsStore(kv, {});
    await store.load();
    await store.setGlobal({ mode: "1h" });
    await store.setGlobal({ maxPings: 3 });
    expect(data.get("global")).toEqual({ mode: "1h", maxPings: 3 });
    expect(store.global()).toEqual({ ...BUILTIN_DEFAULTS, mode: "1h", maxPings: 3 });
  });
});
