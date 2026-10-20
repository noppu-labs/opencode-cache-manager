import { jest, test } from "bun:test";
import { readFileSync } from "node:fs";

const race = (p: Promise<unknown>) => Promise.race([p, Bun.sleep(1000).then(() => "TIMEOUT")]);
const ticks = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
  return "fired";
};

test("uptime", () => {
  console.log("PROBE uptime", readFileSync("/proc/uptime", "utf8").trim(), "perf", performance.now());
});

const variants: Record<string, () => void> = {
  "now=T0": () => jest.useFakeTimers({ now: 1_700_000_000_000 }),
  "now=Date.now()": () => jest.useFakeTimers({ now: Date.now() }),
  "no now": () => jest.useFakeTimers(),
};
for (const [name, fake] of Object.entries(variants)) {
  for (let i = 0; i < 3; i++) {
    test(`${name} cycle ${i}`, async () => {
      fake();
      setTimeout(() => {}, 3_000_000);
      jest.advanceTimersByTime(3_000_000);
      const r = await race(ticks());
      jest.useRealTimers();
      console.log("PROBE", name, i, r);
    });
  }
}
