import { describe, expect, test } from "bun:test";
import { PingTracker } from "../../src/services/ping-tracker.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

describe("PingTracker.isPing", () => {
  test("is false when no send is pending", () => {
    const pings = new PingTracker();
    expect(pings.isPing("generate", "ses_a")).toBe(false);
  });

  test("is true only for the generate kind while a send is pending", async () => {
    const pings = new PingTracker();
    const g = gate();
    const sending = pings.send("ses_a", () => g.promise);

    expect(pings.isPing("generate", "ses_a")).toBe(true);
    for (const kind of ["primary", "compaction", "title"]) {
      expect(pings.isPing(kind, "ses_a")).toBe(false);
    }

    g.open();
    await sending;
  });

  test("is per session", async () => {
    const pings = new PingTracker();
    const g = gate();
    const sending = pings.send("ses_a", () => g.promise);

    expect(pings.isPing("generate", "ses_b")).toBe(false);

    g.open();
    await sending;
  });

  test("stays true until the last of several overlapping sends settles", async () => {
    const pings = new PingTracker();
    const first = gate();
    const second = gate();
    const sendingFirst = pings.send("ses_a", () => first.promise);
    const sendingSecond = pings.send("ses_a", () => second.promise);

    first.open();
    await sendingFirst;
    expect(pings.isPing("generate", "ses_a")).toBe(true);

    second.open();
    await sendingSecond;
    expect(pings.isPing("generate", "ses_a")).toBe(false);
  });

  test("overlapping sends on different sessions settle independently", async () => {
    const pings = new PingTracker();
    const a = gate();
    const b = gate();
    const sendingA = pings.send("ses_a", () => a.promise);
    const sendingB = pings.send("ses_b", () => b.promise);

    a.open();
    await sendingA;
    expect(pings.isPing("generate", "ses_a")).toBe(false);
    expect(pings.isPing("generate", "ses_b")).toBe(true);

    b.open();
    await sendingB;
  });
});

describe("PingTracker.send", () => {
  test("runs generate once", async () => {
    const pings = new PingTracker();
    let calls = 0;
    await pings.send("ses_a", async () => {
      calls++;
    });
    expect(calls).toBe(1);
  });

  test("clears the state once generate resolves without a response", async () => {
    const pings = new PingTracker();
    await pings.send("ses_a", async () => ({}));
    expect(pings.isPing("generate", "ses_a")).toBe(false);
  });

  test("waits for the promise passed to responded", async () => {
    const pings = new PingTracker();
    const reported = gate();
    let settled = false;

    const sending = pings
      .send("ses_a", async () => {
        pings.responded("ses_a", reported.promise);
      })
      .then(() => {
        settled = true;
      });

    await tick();
    expect(settled).toBe(false);
    expect(pings.isPing("generate", "ses_a")).toBe(true);

    reported.open();
    await sending;
    expect(settled).toBe(true);
    expect(pings.isPing("generate", "ses_a")).toBe(false);
  });

  test("does not wait for a response recorded for another session", async () => {
    const pings = new PingTracker();
    const other = gate();
    pings.responded("ses_b", other.promise);

    await pings.send("ses_a", async () => ({}));
    expect(pings.isPing("generate", "ses_a")).toBe(false);
  });

  test("propagates a generate error and clears the state", async () => {
    const pings = new PingTracker();
    const error = new Error("boom");

    await expect(
      pings.send("ses_a", async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(pings.isPing("generate", "ses_a")).toBe(false);
  });

  test("a failing send leaves an overlapping send in flight", async () => {
    const pings = new PingTracker();
    const g = gate();
    const sending = pings.send("ses_a", () => g.promise);

    await expect(
      pings.send("ses_a", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(pings.isPing("generate", "ses_a")).toBe(true);

    g.open();
    await sending;
    expect(pings.isPing("generate", "ses_a")).toBe(false);
  });

  test("can send again after a previous send settled", async () => {
    const pings = new PingTracker();
    await pings.send("ses_a", async () => ({}));

    const g = gate();
    const sending = pings.send("ses_a", () => g.promise);
    expect(pings.isPing("generate", "ses_a")).toBe(true);

    g.open();
    await sending;
    expect(pings.isPing("generate", "ses_a")).toBe(false);
  });
});
