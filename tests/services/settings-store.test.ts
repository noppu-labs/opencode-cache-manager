import { describe, expect, test } from "bun:test";
import { BUILTIN_DEFAULTS } from "../../src/config/settings.ts";
import { SettingsStore, sweepDeletedSessions, type KV, type ScannableKV } from "../../src/services/settings-store.ts";
import { memoryKv } from "../helpers/memory-kv.ts";

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

const notFound = (extra: Record<string, unknown> = {}) =>
  Object.assign(new Error("Session not found"), extra);

function pagedStorage(pages: string[][]) {
  const removed: string[] = [];
  const calls: { prefix: string; after?: string }[] = [];
  const storage: ScannableKV = {
    scan: async (input) => {
      calls.push(input);
      const index = input.after ? Number(input.after) : 0;
      const next = index + 1 < pages.length ? String(index + 1) : undefined;
      return { entries: pages[index]!.map((key) => ({ key })), ...(next ? { next } : {}) };
    },
    remove: async (key) => {
      removed.push(key);
    },
  };
  return { storage, removed, calls };
}

describe("sweepDeletedSessions", () => {
  test("removes sessions whose lookup throws a _tag SessionNotFound error", async () => {
    const { kv, data } = memoryKv();
    data.set("session/ses_gone", { mode: "1h" });
    data.set("session/ses_live", { mode: "1h" });
    await sweepDeletedSessions(kv, async (id) => {
      if (id === "ses_gone") throw notFound({ _tag: "SessionNotFoundError" });
      return { id };
    });
    expect(data.has("session/ses_gone")).toBe(false);
    expect(data.has("session/ses_live")).toBe(true);
  });

  test("removes sessions whose lookup throws a SessionNotFound error by name", async () => {
    const { kv, data } = memoryKv();
    data.set("session/ses_gone", { mode: "1h" });
    await sweepDeletedSessions(kv, async () => {
      throw notFound({ name: "SessionNotFoundError" });
    });
    expect(data.has("session/ses_gone")).toBe(false);
  });

  test("passes the session id without the key prefix to the lookup", async () => {
    const { kv, data } = memoryKv();
    data.set("session/ses_a", {});
    data.set("session/ses_b", {});
    const looked: string[] = [];
    await sweepDeletedSessions(kv, async (id) => {
      looked.push(id);
    });
    expect(looked.sort()).toEqual(["ses_a", "ses_b"]);
  });

  test("keeps stored settings when the lookup fails for another reason", async () => {
    const { kv, data } = memoryKv();
    data.set("session/ses_a", { mode: "1h" });
    await sweepDeletedSessions(kv, async () => {
      throw new Error("network down");
    });
    expect(data.has("session/ses_a")).toBe(true);
  });

  test("keeps stored settings when the error is not an object", async () => {
    const { kv, data } = memoryKv();
    data.set("session/ses_a", { mode: "1h" });
    await sweepDeletedSessions(kv, async () => {
      throw "SessionNotFound";
    });
    expect(data.has("session/ses_a")).toBe(true);
  });

  test("keeps stored settings when the lookup succeeds", async () => {
    const { kv, data } = memoryKv();
    data.set("session/ses_a", { mode: "1h" });
    await sweepDeletedSessions(kv, async (id) => ({ id }));
    expect(data.has("session/ses_a")).toBe(true);
  });

  test("ignores keys outside the session prefix", async () => {
    const { kv, data } = memoryKv();
    data.set("global", { mode: "5m" });
    data.set("mode", "1h");
    data.set("session/ses_gone", {});
    const looked: string[] = [];
    await sweepDeletedSessions(kv, async (id) => {
      looked.push(id);
      throw notFound({ _tag: "SessionNotFoundError" });
    });
    expect(looked).toEqual(["ses_gone"]);
    expect(data.has("global")).toBe(true);
    expect(data.has("mode")).toBe(true);
  });

  test("scans with the session prefix", async () => {
    const { storage, calls } = pagedStorage([[]]);
    await sweepDeletedSessions(storage, async () => ({}));
    expect(calls).toEqual([{ prefix: "session/" }]);
  });

  test("follows pagination until there is no next cursor", async () => {
    const { storage, removed, calls } = pagedStorage([
      ["session/ses_1", "session/ses_2"],
      ["session/ses_3"],
      ["session/ses_4"],
    ]);
    await sweepDeletedSessions(storage, async () => {
      throw notFound({ _tag: "SessionNotFoundError" });
    });
    expect(removed).toEqual(["session/ses_1", "session/ses_2", "session/ses_3", "session/ses_4"]);
    expect(calls).toEqual([
      { prefix: "session/" },
      { prefix: "session/", after: "1" },
      { prefix: "session/", after: "2" },
    ]);
  });

  test("rejects when the scan rejects", async () => {
    const storage: ScannableKV = {
      scan: async () => {
        throw new Error("scan unsupported");
      },
      remove: async () => {},
    };
    await expect(sweepDeletedSessions(storage, async () => ({}))).rejects.toThrow("scan unsupported");
  });
});
