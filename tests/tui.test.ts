import { describe, expect, mock, test } from "bun:test";

// `@opencode/plugin/tui` re-exports from `solid.js`, which imports the optional
// `solid-js` peer that is only present in the live TUI host. `define` is an
// identity helper, so stub it here (before importing the TUI entrypoint) to keep
// the test harness dependency-free.
mock.module("@opencode/plugin/tui", () => ({
  Plugin: { define: (plugin: unknown) => plugin },
}));
// `ui/sidebar.tsx` is Solid JSX that only the live TUI host can compile; stub it and
// capture what `tui.ts` hands to `registerSidebar`.
type SidebarCall = {
  snapshots: () => ReadonlyMap<string, any>;
  load: (sessionID: string) => void;
  disposed: boolean;
};
const sidebarCalls: SidebarCall[] = [];
let sidebarThrows = false;
mock.module("../src/ui/sidebar.tsx", () => ({
  registerSidebar: (_ctx: unknown, snapshots: SidebarCall["snapshots"], load: SidebarCall["load"]) => {
    if (sidebarThrows) throw new Error("sidebar unavailable");
    const call: SidebarCall = { snapshots, load, disposed: false };
    sidebarCalls.push(call);
    return () => {
      call.disposed = true;
    };
  },
}));
const { default: tuiPlugin } = await import("../src/tui.ts");

// ---------------------------------------------------------------------------
// TUI plugin (keymap layer + dialog modal + toasts)
// ---------------------------------------------------------------------------

type TuiMockOptions = {
  route?: { type: "home" } | { type: "session"; sessionID: string };
  global?: Record<string, unknown>;
  session?: Record<string, unknown> | null;
  selects?: unknown[];
  prompts?: unknown[];
  setSessionImpl?: (input: any) => Promise<unknown>;
  keepalive?: Record<string, any>;
};

type TuiMock = {
  ctx: any;
  toasts: any[];
  dialogCalls: any[];
  promptCalls: any[];
  setSessionCalls: any[];
  setGlobalCalls: any[];
  resetCalls: any[];
  getKeepaliveCalls: any[];
  subscriptions: { name: string; signal: AbortSignal | undefined }[];
  emitKeepalive: (snapshot: any) => Promise<void>;
  cleanup?: () => void;
  layer: () => any;
  run: (input?: string) => Promise<void>;
};

function createTuiCtx(options: TuiMockOptions = {}): TuiMock {
  let layer: any;
  const toasts: any[] = [];
  const dialogCalls: any[] = [];
  const promptCalls: any[] = [];
  const setSessionCalls: any[] = [];
  const setGlobalCalls: any[] = [];
  const resetCalls: any[] = [];
  const getKeepaliveCalls: any[] = [];
  const subscriptions: { name: string; signal: AbortSignal | undefined }[] = [];
  const listeners = new Set<(event: any) => void>();
  const selects = [...(options.selects ?? [])];
  const prompts = [...(options.prompts ?? [])];
  const route = options.route ?? { type: "session", sessionID: "ses_tui" };
  const global = { mode: "5m", keepalive: true, maxPings: 5, minContextTokens: 50_000, ...options.global };

  const ctx = {
    client: {
      rpc: () => ({
        getSettings: async () => ({ global, session: options.session ?? null }),
        setSession: async (input: any) => {
          setSessionCalls.push(input);
          if (options.setSessionImpl) return options.setSessionImpl(input);
          return {};
        },
        setGlobal: async (input: any) => {
          setGlobalCalls.push(input);
          return {};
        },
        resetSession: async (input: any) => {
          resetCalls.push(input);
          return {};
        },
        getKeepalive: async (input: any) => {
          getKeepaliveCalls.push(input);
          return options.keepalive?.[input.sessionID];
        },
        events: {
          subscribe: (name: string, opts?: { signal?: AbortSignal }) => {
            subscriptions.push({ name, signal: opts?.signal });
            return (async function* () {
              const queue: any[] = [];
              let wake: (() => void) | undefined;
              const push = (event: any) => {
                queue.push(event);
                wake?.();
              };
              listeners.add(push);
              opts?.signal?.addEventListener("abort", () => wake?.());
              try {
                while (!opts?.signal?.aborted) {
                  if (queue.length === 0) await new Promise<void>((resolve) => (wake = resolve));
                  while (queue.length > 0) yield queue.shift();
                }
              } finally {
                listeners.delete(push);
              }
            })();
          },
        },
      }),
    },
    storage: {
      memory: (_key: string, { initial }: { initial: object }) => {
        const state = structuredClone(initial);
        return [state, (mutation: (draft: any) => void) => mutation(state)];
      },
    },
    ui: {
      dialog: {
        select: async (dialog: any) => {
          dialogCalls.push(dialog);
          return selects.shift();
        },
        prompt: async (dialog: any) => {
          promptCalls.push(dialog);
          return prompts.shift();
        },
      },
      toast: {
        show: (toast: any) => {
          toasts.push(toast);
        },
      },
      router: {
        current: () => route,
      },
    },
    keymap: {
      layer: (fn: () => any) => {
        layer = fn();
      },
    },
  };

  return {
    ctx,
    toasts,
    dialogCalls,
    promptCalls,
    setSessionCalls,
    setGlobalCalls,
    resetCalls,
    getKeepaliveCalls,
    subscriptions,
    emitKeepalive: async (snapshot: any) => {
      for (const listener of listeners) listener({ type: "rpc.anthropic-cache-ttl.keepalive.updated", data: snapshot });
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    layer: () => layer,
    run: (input?: string) => layer.commands[0].run(input),
  };
}

async function setupTui(options: TuiMockOptions = {}): Promise<TuiMock> {
  const mock = createTuiCtx(options);
  mock.cleanup = await (tuiPlugin as any).setup(mock.ctx);
  return mock;
}

const HOME = { type: "home" } as const;

describe("cache-manager TUI plugin", () => {
  test("registers the cache-manager command", async () => {
    const mock = await setupTui();
    const command = mock.layer().commands[0];

    expect(command.id).toBe("cache-manager.open");
    expect(command.title).toBe("Cache Manager");
    expect(command.group).toBe("Provider");
    expect(command.slash).toEqual({ name: "cache-manager", arguments: true });
  });

  test("the picker inside a session shows Session and Global with global markers", async () => {
    const mock = await setupTui({
      global: { mode: "hybrid" },
      session: { mode: "1h", minContextTokens: 100_000 },
    });

    await mock.run("");

    expect(mock.dialogCalls).toHaveLength(1);
    const call = mock.dialogCalls[0];
    expect(call.title).toBe("Cache Manager");
    const rows = call.options.map((o: any) => [o.category, o.value, o.title]);
    expect(rows).toEqual([
      ["Session", "session:mode", "TTL mode  1h"],
      ["Session", "session:keepalive", "Keepalive  on · global"],
      ["Session", "session:maxPings", "Pings per idle  5 · global"],
      ["Session", "session:minContextTokens", "Min context  100k"],
      ["Session", "session:reset", "Reset session to global"],
      ["Global", "global:mode", "TTL mode  hybrid"],
      ["Global", "global:keepalive", "Keepalive  on"],
      ["Global", "global:maxPings", "Pings per idle  5"],
      ["Global", "global:minContextTokens", "Min context  50k"],
    ]);
    expect(mock.setSessionCalls).toHaveLength(0);
    expect(mock.setGlobalCalls).toHaveLength(0);
    expect(mock.toasts).toHaveLength(0);
  });

  test("the picker on the home route shows only Global", async () => {
    const mock = await setupTui({ route: HOME });

    await mock.run(undefined);

    const options = mock.dialogCalls[0].options;
    expect(options.map((o: any) => o.value)).toEqual([
      "global:mode",
      "global:keepalive",
      "global:maxPings",
      "global:minContextTokens",
    ]);
    expect(options.every((o: any) => o.category === "Global")).toBe(true);
  });

  test("the mode sub-dialog offers the three modes with the effective one current", async () => {
    const mock = await setupTui({ session: { mode: "hybrid" }, selects: ["session:mode"] });

    await mock.run("");

    expect(mock.dialogCalls).toHaveLength(2);
    const sub = mock.dialogCalls[1];
    expect(sub.current).toBe("hybrid");
    expect(sub.options.map((o: any) => o.value)).toEqual(["5m", "1h", "hybrid"]);
    for (const option of sub.options) {
      expect(option.title.length).toBeGreaterThan(0);
      expect(option.description.length).toBeGreaterThan(0);
    }
  });

  test("selecting session:mode then 1h writes the session and toasts", async () => {
    const mock = await setupTui({ selects: ["session:mode", "1h"] });

    await mock.run("");

    expect(mock.setSessionCalls).toEqual([{ sessionID: "ses_tui", patch: { mode: "1h" } }]);
    expect(mock.setGlobalCalls).toHaveLength(0);
    expect(mock.toasts).toEqual([{ message: "Session cache TTL set to 1h.", variant: "success" }]);
  });

  test("selecting global:keepalive then off writes the global settings", async () => {
    const mock = await setupTui({ selects: ["global:keepalive", "off"] });

    await mock.run("");

    expect(mock.setGlobalCalls).toEqual([{ patch: { keepalive: false } }]);
    expect(mock.setSessionCalls).toHaveLength(0);
    expect(mock.toasts).toEqual([{ message: "Global keepalive set to off.", variant: "success" }]);
  });

  test("the pings and min context sub-dialogs list their presets", async () => {
    const pings = await setupTui({ selects: ["global:maxPings"] });
    await pings.run("");
    expect(pings.dialogCalls[1].options.map((o: any) => o.value)).toEqual([0, 1, 3, 5, 10, "custom"]);
    expect(pings.dialogCalls[1].options.at(-1).title).toBe("Custom…");

    const min = await setupTui({ selects: ["global:minContextTokens"] });
    await min.run("");
    expect(min.dialogCalls[1].options.map((o: any) => o.title)).toEqual(["0", "20k", "50k", "100k", "Custom…"]);
  });

  test("a preset min context value is written in tokens and shown in k", async () => {
    const mock = await setupTui({ selects: ["session:minContextTokens", 100_000] });

    await mock.run("");

    expect(mock.setSessionCalls).toEqual([{ sessionID: "ses_tui", patch: { minContextTokens: 100_000 } }]);
    expect(mock.toasts[0].message).toBe("Session min context set to 100k.");
  });

  test("global:maxPings then Custom with 7 writes the global setting", async () => {
    const mock = await setupTui({ selects: ["global:maxPings", "custom"], prompts: ["7"] });

    await mock.run("");

    expect(mock.promptCalls).toHaveLength(1);
    expect(mock.setGlobalCalls).toEqual([{ patch: { maxPings: 7 } }]);
    expect(mock.toasts).toEqual([{ message: "Global pings per idle set to 7.", variant: "success" }]);
  });

  test("a Custom min context accepts the k suffix", async () => {
    const mock = await setupTui({ selects: ["global:minContextTokens", "custom"], prompts: ["30k"] });

    await mock.run("");

    expect(mock.setGlobalCalls).toEqual([{ patch: { minContextTokens: 30_000 } }]);
  });

  test("an invalid Custom value warns and writes nothing", async () => {
    const mock = await setupTui({ selects: ["global:maxPings", "custom"], prompts: ["abc"] });

    await mock.run("");

    expect(mock.setGlobalCalls).toHaveLength(0);
    expect(mock.setSessionCalls).toHaveLength(0);
    expect(mock.toasts).toHaveLength(1);
    expect(mock.toasts[0].variant).toBe("warning");
  });

  test("cancelling the Custom prompt writes nothing and shows no toast", async () => {
    const mock = await setupTui({ selects: ["global:maxPings", "custom"], prompts: [undefined] });

    await mock.run("");

    expect(mock.setGlobalCalls).toHaveLength(0);
    expect(mock.toasts).toHaveLength(0);
  });

  test("selecting the value already in effect writes nothing and shows no toast", async () => {
    const mock = await setupTui({ global: { mode: "hybrid" }, selects: ["session:mode", "hybrid"] });

    await mock.run("");

    expect(mock.setSessionCalls).toHaveLength(0);
    expect(mock.toasts).toHaveLength(0);
  });

  test("dismissing the picker writes nothing and shows no toast", async () => {
    const mock = await setupTui({ selects: [undefined] });

    await mock.run("");

    expect(mock.dialogCalls).toHaveLength(1);
    expect(mock.setSessionCalls).toHaveLength(0);
    expect(mock.setGlobalCalls).toHaveLength(0);
    expect(mock.toasts).toHaveLength(0);
  });

  test("dismissing a sub-dialog writes nothing and shows no toast", async () => {
    const mock = await setupTui({ selects: ["session:mode", undefined] });

    await mock.run("");

    expect(mock.dialogCalls).toHaveLength(2);
    expect(mock.setSessionCalls).toHaveLength(0);
    expect(mock.toasts).toHaveLength(0);
  });

  test("the reset row resets the session", async () => {
    const mock = await setupTui({ selects: ["session:reset"] });

    await mock.run("");

    expect(mock.resetCalls).toEqual([{ sessionID: "ses_tui" }]);
    expect(mock.toasts[0].variant).toBe("success");
  });

  test("typed pings 3 sets the session", async () => {
    const mock = await setupTui();

    await mock.run("pings 3");

    expect(mock.dialogCalls).toHaveLength(0);
    expect(mock.setSessionCalls).toEqual([{ sessionID: "ses_tui", patch: { maxPings: 3 } }]);
    expect(mock.toasts).toEqual([{ message: "Session pings per idle set to 3.", variant: "success" }]);
  });

  test("typed mode, keepalive and min arguments set the session", async () => {
    const mock = await setupTui();

    await mock.run("hybrid");
    await mock.run("keepalive off");
    await mock.run("min 20k");

    expect(mock.setSessionCalls.map((c) => c.patch)).toEqual([
      { mode: "hybrid" },
      { keepalive: false },
      { minContextTokens: 20_000 },
    ]);
    expect(mock.toasts.map((t) => t.message)).toEqual([
      "Session cache TTL set to hybrid.",
      "Session keepalive set to off.",
      "Session min context set to 20k.",
    ]);
  });

  test("typed reset resets the session", async () => {
    const mock = await setupTui();

    await mock.run("reset");

    expect(mock.resetCalls).toEqual([{ sessionID: "ses_tui" }]);
    expect(mock.setSessionCalls).toHaveLength(0);
  });

  test("typed status shows the effective session values", async () => {
    const mock = await setupTui({ global: { mode: "hybrid" }, session: { maxPings: 2, keepalive: false } });

    await mock.run("status");

    expect(mock.dialogCalls).toHaveLength(0);
    expect(mock.toasts).toEqual([
      {
        message: "Session cache: TTL hybrid, keepalive off, pings 2, min context 50k.",
        variant: "info",
      },
    ]);
  });

  test("a typed argument on the home route warns and writes nothing", async () => {
    const mock = await setupTui({ route: HOME });

    await mock.run("1h");

    expect(mock.setSessionCalls).toHaveLength(0);
    expect(mock.setGlobalCalls).toHaveLength(0);
    expect(mock.toasts).toEqual([
      { message: "Open a session to change session cache settings.", variant: "warning" },
    ]);
  });

  test("garbage input warns with the usage text", async () => {
    const mock = await setupTui();

    await mock.run("garbage");

    expect(mock.dialogCalls).toHaveLength(0);
    expect(mock.setSessionCalls).toHaveLength(0);
    expect(mock.toasts).toEqual([
      {
        message:
          "Usage: /cache-manager [5m | 1h | hybrid | keepalive on|off | pings <n> | min <n|nk> | reset | status]",
        variant: "warning",
      },
    ]);
  });

  test("an RPC failure surfaces as an error toast without throwing", async () => {
    const mock = await setupTui({
      selects: ["session:mode", "1h"],
      setSessionImpl: async () => {
        throw new Error("rpc down");
      },
    });

    await expect(mock.run("")).resolves.toBeUndefined();

    expect(mock.setSessionCalls).toHaveLength(1);
    expect(mock.toasts).toHaveLength(1);
    expect(mock.toasts[0].variant).toBe("error");
    expect(mock.toasts[0].message).toContain("rpc down");
  });

  describe("sidebar", () => {
    const snapshot = (sessionID: string, extra: Record<string, unknown> = {}) => ({
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
      ...extra,
    });
    const lastSidebar = () => sidebarCalls[sidebarCalls.length - 1]!;

    test("registers the sidebar slot with an initially empty snapshot map", async () => {
      sidebarCalls.length = 0;
      await setupTui();

      expect(sidebarCalls).toHaveLength(1);
      expect(lastSidebar().snapshots().size).toBe(0);
    });

    test("keepalive.updated events populate the snapshot map", async () => {
      const mock = await setupTui();

      await mock.emitKeepalive(snapshot("ses_a"));
      await mock.emitKeepalive(snapshot("ses_b", { pingsUsed: 2 }));
      await mock.emitKeepalive(snapshot("ses_a", { pingsUsed: 1 }));

      expect(mock.subscriptions.map((s) => s.name)).toEqual(["keepalive.updated"]);
      const map = lastSidebar().snapshots();
      expect([...map.keys()].sort()).toEqual(["ses_a", "ses_b"]);
      expect(map.get("ses_a")!.pingsUsed).toBe(1);
      expect(map.get("ses_b")!.pingsUsed).toBe(2);
    });

    test("fetches getKeepalive once per session when its sidebar first renders", async () => {
      const mock = await setupTui({ keepalive: { ses_a: snapshot("ses_a", { pingsUsed: 3 }) } });

      lastSidebar().load("ses_a");
      lastSidebar().load("ses_a");
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(mock.getKeepaliveCalls).toEqual([{ sessionID: "ses_a" }]);
      expect(lastSidebar().snapshots().get("ses_a")!.pingsUsed).toBe(3);
    });

    test("a fetched snapshot does not overwrite one already received by event", async () => {
      const mock = await setupTui({ keepalive: { ses_a: snapshot("ses_a", { pingsUsed: 0 }) } });

      await mock.emitKeepalive(snapshot("ses_a", { pingsUsed: 4 }));
      lastSidebar().load("ses_a");
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(lastSidebar().snapshots().get("ses_a")!.pingsUsed).toBe(4);
    });

    test("a sidebar that fails to register leaves the command and subscription working", async () => {
      sidebarThrows = true;
      try {
        const mock = await setupTui();

        await mock.run("status");
        expect(mock.toasts).toHaveLength(1);
        expect(mock.toasts[0].variant).toBe("info");
        expect(mock.subscriptions.map((s) => s.name)).toEqual(["keepalive.updated"]);
        expect(() => mock.cleanup!()).not.toThrow();
        expect(mock.subscriptions[0]!.signal?.aborted).toBe(true);
      } finally {
        sidebarThrows = false;
      }
    });

    test("cleanup disposes the slot and aborts the subscription", async () => {
      const mock = await setupTui();
      const sub = mock.subscriptions[0]!;
      expect(sub.signal?.aborted).toBe(false);
      expect(lastSidebar().disposed).toBe(false);

      mock.cleanup!();

      expect(sub.signal?.aborted).toBe(true);
      expect(lastSidebar().disposed).toBe(true);
    });
  });
});
