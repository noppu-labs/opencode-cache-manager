import { describe, expect, test } from "bun:test";
import type { KeepaliveSnapshot } from "../../src/models/keepalive.ts";
import type { CacheTtlRpcClient } from "../../src/rpc.ts";
import { createSnapshotFeed } from "../../src/ui/snapshot-feed.ts";

const snapshot = (sessionID: string, overrides: Partial<KeepaliveSnapshot> = {}): KeepaliveSnapshot => ({
  sessionID,
  ttl: "5m",
  ttlSource: "detected",
  lastRequestAt: 1,
  expiresAt: 2,
  nextPingAt: null,
  pingsUsed: 0,
  maxPings: 5,
  minContextTokens: 50_000,
  lastPing: null,
  skipReason: null,
  contextTokens: 80_000,
  ...overrides,
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

type Options = {
  keepalive?: Record<string, KeepaliveSnapshot>;
  failures?: number;
};

function setup(options: Options = {}) {
  const getKeepaliveCalls: { sessionID: string }[] = [];
  const subscriptions: { name: string; signal: AbortSignal | undefined }[] = [];
  const listeners = new Set<(event: { data: KeepaliveSnapshot }) => void>();
  let failures = options.failures ?? 0;

  const rpc = {
    getKeepalive: async (input: { sessionID: string }) => {
      getKeepaliveCalls.push(input);
      if (failures > 0) {
        failures--;
        throw new Error("rpc down");
      }
      return options.keepalive?.[input.sessionID] as KeepaliveSnapshot;
    },
    events: {
      subscribe: (name: string, opts?: { signal?: AbortSignal }) => {
        subscriptions.push({ name, signal: opts?.signal });
        return (async function* () {
          const queue: { data: KeepaliveSnapshot }[] = [];
          let wake: (() => void) | undefined;
          const push = (event: { data: KeepaliveSnapshot }) => {
            queue.push(event);
            wake?.();
          };
          listeners.add(push);
          opts?.signal?.addEventListener("abort", () => wake?.());
          try {
            while (!opts?.signal?.aborted) {
              if (queue.length === 0) await new Promise<void>((resolve) => (wake = resolve));
              while (queue.length > 0) yield queue.shift()!;
            }
          } finally {
            listeners.delete(push);
          }
        })();
      },
    },
  } as unknown as CacheTtlRpcClient;

  const storage = {
    memory: (_key: string, { initial }: { initial: object }) => {
      const state = structuredClone(initial);
      return [state, (mutation: (draft: any) => void) => mutation(state)];
    },
  };

  const feed = createSnapshotFeed(storage as any, rpc);

  return {
    feed,
    getKeepaliveCalls,
    subscriptions,
    emit: async (data: KeepaliveSnapshot) => {
      for (const listener of listeners) listener({ data });
      await tick();
    },
  };
}

describe("createSnapshotFeed", () => {
  test("starts with an empty snapshot map", () => {
    const t = setup();

    expect(t.feed.snapshots().size).toBe(0);
  });

  test("keepalive.updated events populate the snapshot map", async () => {
    const t = setup();

    await t.emit(snapshot("ses_a"));
    await t.emit(snapshot("ses_b", { pingsUsed: 2 }));
    await t.emit(snapshot("ses_a", { pingsUsed: 1 }));

    expect(t.subscriptions.map((s) => s.name)).toEqual(["keepalive.updated"]);
    const map = t.feed.snapshots();
    expect([...map.keys()].sort()).toEqual(["ses_a", "ses_b"]);
    expect(map.get("ses_a")!.pingsUsed).toBe(1);
    expect(map.get("ses_b")!.pingsUsed).toBe(2);
  });

  test("load fetches getKeepalive once per session", async () => {
    const t = setup({ keepalive: { ses_a: snapshot("ses_a", { pingsUsed: 3 }) } });

    t.feed.load("ses_a");
    t.feed.load("ses_a");
    await tick();

    expect(t.getKeepaliveCalls).toEqual([{ sessionID: "ses_a" }]);
    expect(t.feed.snapshots().get("ses_a")!.pingsUsed).toBe(3);
  });

  test("a fetched snapshot does not overwrite one already received by event", async () => {
    const t = setup({ keepalive: { ses_a: snapshot("ses_a", { pingsUsed: 0 }) } });

    await t.emit(snapshot("ses_a", { pingsUsed: 4 }));
    t.feed.load("ses_a");
    await tick();

    expect(t.feed.snapshots().get("ses_a")!.pingsUsed).toBe(4);
  });

  test("a failed fetch allows a retry", async () => {
    const t = setup({ failures: 1, keepalive: { ses_a: snapshot("ses_a", { pingsUsed: 3 }) } });

    t.feed.load("ses_a");
    await tick();
    expect(t.feed.snapshots().size).toBe(0);

    t.feed.load("ses_a");
    await tick();

    expect(t.getKeepaliveCalls).toHaveLength(2);
    expect(t.feed.snapshots().get("ses_a")!.pingsUsed).toBe(3);
  });

  test("dispose aborts the subscription", () => {
    const t = setup();
    const sub = t.subscriptions[0]!;
    expect(sub.signal?.aborted).toBe(false);

    t.feed.dispose();

    expect(sub.signal?.aborted).toBe(true);
  });

  test("events after dispose no longer update the snapshots", async () => {
    const t = setup();
    await t.emit(snapshot("ses_a"));

    t.feed.dispose();
    await tick();
    await t.emit(snapshot("ses_b"));

    expect([...t.feed.snapshots().keys()]).toEqual(["ses_a"]);
  });
});
