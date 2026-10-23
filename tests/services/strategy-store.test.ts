import { describe, expect, test } from "bun:test";
import { StrategyStore } from "../../src/services/strategy-store.ts";
import type { KV } from "../../src/services/settings-store.ts";
import { memoryKv } from "../helpers/memory-kv.ts";

const ref = { providerID: "omniroute", id: "auto/opus-5" };

async function loaded(kv: KV): Promise<StrategyStore> {
  const store = new StrategyStore(kv);
  await store.load();
  return store;
}

describe("StrategyStore", () => {
  test("a Claude model in the response is learned as explicit", async () => {
    const store = await loaded(memoryKv().kv);
    await store.learnFromResponse(ref, { model: "claude-haiku-5-5" });
    expect(store.get(ref)).toBe("explicit");
  });

  test("an Anthropic provider in the response is learned as explicit", async () => {
    const store = await loaded(memoryKv().kv);
    await store.learnFromResponse(ref, { provider: "Claude Platform on AWS" });
    expect(store.get(ref)).toBe("explicit");
  });

  test("any other model and provider is learned as implicit", async () => {
    const store = await loaded(memoryKv().kv);
    await store.learnFromResponse(ref, { model: "openai/gpt-6-luna", provider: "OpenAI" });
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
    expect((await loaded(kv)).get(ref)).toBe("explicit");
  });

  test("an unchanged value does not write storage again", async () => {
    const { kv } = memoryKv();
    let writes = 0;
    const counting: KV = { ...kv, set: async (key, value) => { writes++; await kv.set(key, value); } };
    const store = await loaded(counting);
    await store.learnFromResponse(ref, { model: "claude-haiku-5-5" });
    await store.learnFromResponse(ref, { model: "claude-haiku-5-5" });
    expect(writes).toBe(1);
    await store.learnFromResponse(ref, { model: "gpt-6" });
    expect(writes).toBe(2);
    expect(store.get(ref)).toBe("implicit");
  });

  test("a storage failure is swallowed and the in-memory value is kept", async () => {
    const { kv } = memoryKv();
    const failing: KV = { ...kv, set: async () => { throw new Error("disk full"); } };
    const store = await loaded(failing);
    await store.learnFromResponse(ref, { model: "claude-haiku-5-5" });
    expect(store.get(ref)).toBe("explicit");
  });

  test("garbage in storage is ignored on load", async () => {
    const { kv, data } = memoryKv();
    data.set("learned-models", { "a/b": "explicit", "c/d": "bogus", "e/f": 3 });
    const store = await loaded(kv);
    expect(store.get({ providerID: "a", id: "b" })).toBe("explicit");
    expect(store.get({ providerID: "c", id: "d" })).toBeUndefined();
    expect(store.get({ providerID: "e", id: "f" })).toBeUndefined();
    data.set("learned-models", "nope");
    expect((await loaded(kv)).get({ providerID: "a", id: "b" })).toBeUndefined();
  });
});
