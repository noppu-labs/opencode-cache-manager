import { expect, jest, test } from "bun:test";

const realSetImmediate = setImmediate;
const race = (p: Promise<unknown>) => Promise.race([p, Bun.sleep(500).then(() => "TIMEOUT")]);

for (let i = 0; i < 3; i++) {
  test(`fake timer cycle ${i}`, async () => {
    jest.useFakeTimers({ now: 1_700_000_000_000 });
    const replaced = setImmediate !== realSetImmediate;
    const viaGlobal = await race(new Promise((r) => setImmediate(() => r("fired"))));
    const viaCaptured = await race(new Promise((r) => realSetImmediate(() => r("fired"))));
    const viaMicrotask = await race(new Promise((r) => queueMicrotask(() => r("fired"))));
    console.log("PROBE", i, JSON.stringify({ replaced, viaGlobal, viaCaptured, viaMicrotask }));
    jest.useRealTimers();
    expect(true).toBe(true);
  });
}
