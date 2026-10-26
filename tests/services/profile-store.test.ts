import { describe, expect, test } from "bun:test";
import type { KV } from "../../src/models/storage.ts";
import { ProfileStore } from "../../src/services/profile-store.ts";
import { memoryKv } from "../helpers/memory-kv.ts";

const ref = { providerID: "omniroute", id: "auto/opus-5" };

async function loaded(kv: KV): Promise<ProfileStore> {
  const store = new ProfileStore(kv);
  await store.load();
  return store;
}

describe("ProfileStore", () => {
  test("a Claude model in the response is learned as explicit", async () => {
    const store = await loaded(memoryKv().kv);
    await store.learnFromResponse(ref, { model: "claude-haiku-5-5" });
    expect(store.get(ref)).toBe("anthropic");
  });

  test("an Anthropic provider in the response is learned as explicit", async () => {
    const store = await loaded(memoryKv().kv);
    await store.learnFromResponse(ref, { provider: "Claude Platform on AWS" });
    expect(store.get(ref)).toBe("anthropic");
  });

  test("a GPT-5.6+ model in the response is learned as openai", async () => {
    const store = await loaded(memoryKv().kv);
    await store.learnFromResponse(ref, { model: "openai/gpt-6-luna", provider: "OpenAI" });
    expect(store.get(ref)).toBe("openai");
  });

  test("an older GPT model or any other model and provider is learned as implicit, never as openai", async () => {
    const store = await loaded(memoryKv().kv);
    await store.learnFromResponse(ref, { model: "openai/gpt-5", provider: "OpenAI" });
    expect(store.get(ref)).toBe("implicit");
    await store.learnFromResponse(ref, { model: "deepseek/deepseek-v4.1-flash", provider: "DeepInfra" });
    expect(store.get(ref)).toBe("implicit");
    await store.learnFromResponse(ref, { provider: "OpenAI" });
    expect(store.get(ref)).toBe("implicit");
  });

  test("a non-Claude model with no provider, as the Messages wire reports it, is learned as implicit", async () => {
    const store = await loaded(memoryKv().kv);
    await store.learnFromResponse(ref, { model: "deepseek/deepseek-v4.1-flash" });
    expect(store.get(ref)).toBe("implicit");
  });

  test("the latest response replaces a stale openai profile", async () => {
    const store = await loaded(memoryKv().kv);
    await store.learnFromResponse(ref, { model: "openai/gpt-6-luna" });
    await store.learnFromResponse(ref, { model: "openai/gpt-5" });
    expect(store.get(ref)).toBe("implicit");
  });

  test("a response without model or provider teaches nothing", async () => {
    const { kv, data } = memoryKv();
    const store = await loaded(kv);
    await store.learnFromResponse(ref, {});
    await store.learnFromResponse(ref, undefined);
    expect(store.get(ref)).toBeUndefined();
    expect(data.size).toBe(0);
  });

  test("entries are keyed per provider and model", async () => {
    const store = await loaded(memoryKv().kv);
    await store.learnFromResponse(ref, { model: "claude-haiku-5-5" });
    expect(store.get({ providerID: "other", id: ref.id })).toBeUndefined();
    expect(store.get({ providerID: ref.providerID, id: "auto/other" })).toBeUndefined();
  });

  test("the value persists across a new store instance after load()", async () => {
    const { kv } = memoryKv();
    await (await loaded(kv)).learnFromResponse(ref, { model: "claude-haiku-5-5" });
    expect((await loaded(kv)).get(ref)).toBe("anthropic");
  });

  test("an unchanged value does not write storage again", async () => {
    const { kv } = memoryKv();
    let writes = 0;
    const counting: KV = { ...kv, set: async (key, value) => { writes++; await kv.set(key, value); } };
    const store = await loaded(counting);
    await store.learnFromResponse(ref, { model: "claude-haiku-5-5" });
    await store.learnFromResponse(ref, { model: "claude-haiku-5-5" });
    expect(writes).toBe(1);
    await store.learnFromResponse(ref, { model: "gpt-5" });
    expect(writes).toBe(2);
    expect(store.get(ref)).toBe("implicit");
  });

  test("a storage failure is swallowed and the in-memory value is kept", async () => {
    const { kv } = memoryKv();
    const failing: KV = { ...kv, set: async () => { throw new Error("disk full"); } };
    const store = await loaded(failing);
    await store.learnFromResponse(ref, { model: "claude-haiku-5-5" });
    expect(store.get(ref)).toBe("anthropic");
  });

  test("a storage read error leaves load() resolved with an empty map", async () => {
    const { kv } = memoryKv();
    const store = await loaded({ ...kv, get: async () => { throw new Error("unreadable"); } });
    expect(store.get(ref)).toBeUndefined();
  });

  test("a 0.4.0 stored \"explicit\" loads as anthropic", async () => {
    const { kv, data } = memoryKv();
    data.set("learned-models", { "a/b": "explicit" });
    expect((await loaded(kv)).get({ providerID: "a", id: "b" })).toBe("anthropic");
  });

  test("a stored openai loads as openai", async () => {
    const { kv, data } = memoryKv();
    data.set("learned-models", { "a/b": "openai" });
    expect((await loaded(kv)).get({ providerID: "a", id: "b" })).toBe("openai");
  });

  test("garbage in storage is ignored on load", async () => {
    const { kv, data } = memoryKv();
    data.set("learned-models", { "a/b": "anthropic", "c/d": "bogus", "e/f": 3 });
    const store = await loaded(kv);
    expect(store.get({ providerID: "a", id: "b" })).toBe("anthropic");
    expect(store.get({ providerID: "c", id: "d" })).toBeUndefined();
    expect(store.get({ providerID: "e", id: "f" })).toBeUndefined();
    data.set("learned-models", "nope");
    expect((await loaded(kv)).get({ providerID: "a", id: "b" })).toBeUndefined();
  });
});
