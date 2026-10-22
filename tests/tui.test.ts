import { describe, expect, mock, test } from "bun:test";

// `@opencode/plugin/tui` re-exports from `solid.js`, which imports the optional
// `solid-js` peer that is only present in the live TUI host. `define` is an
// identity helper, so stub it here (before importing the TUI entrypoint) to keep
// the test harness dependency-free.
mock.module("@opencode/plugin/tui", () => ({
  Plugin: { define: (plugin: unknown) => plugin },
}));
// `ui/sidebar.tsx` is Solid JSX that only the live TUI host can compile; stub it and
// capture what `tui.ts` hands to `registerSidebar`. The repo is not under
// node_modules, so `tui.ts` imports the `.tsx` rather than the compiled copy.
type SidebarCall = {
  snapshots: () => ReadonlyMap<string, any>;
  load: (sessionID: string) => void;
  refresh: (sessionID: string) => void;
  disposed: boolean;
};
const sidebarCalls: SidebarCall[] = [];
let sidebarThrows = false;
mock.module("../src/ui/sidebar.tsx", () => ({
  registerSidebar: (
    _ctx: unknown,
    snapshots: SidebarCall["snapshots"],
    load: SidebarCall["load"],
    refresh: SidebarCall["refresh"],
  ) => {
    if (sidebarThrows) throw new Error("sidebar unavailable");
    const call: SidebarCall = { snapshots, load, refresh, disposed: false };
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
  /** Session records the TUI has cached, keyed by ID. */
  sessions?: Record<string, { location: { directory: string } }>;
  /** `ctx.location`; unset means the TUI falls back to `data.location.default()`. */
  location?: { directory: string };
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
  /** `[method, options]` for every RPC call, in order. */
  rpcOptions: [string, any][];
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
  const rpcOptions: [string, any][] = [];
  const subscriptions: { name: string; signal: AbortSignal | undefined }[] = [];
  const listeners = new Set<(event: any) => void>();
  const selects = [...(options.selects ?? [])];
  const prompts = [...(options.prompts ?? [])];
  const route = options.route ?? { type: "session", sessionID: "ses_tui" };
  const global = { mode: "5m", keepalive: true, maxPings: 5, minContextTokens: 50_000, ...options.global };

  const ctx = {
    client: {
      rpc: () => ({
        getSettings: async (_input: any, opts?: any) => {
          rpcOptions.push(["getSettings", opts]);
          return { global, session: options.session ?? null };
        },
        setSession: async (input: any, opts?: any) => {
          rpcOptions.push(["setSession", opts]);
          setSessionCalls.push(input);
          if (options.setSessionImpl) return options.setSessionImpl(input);
          return {};
        },
        setGlobal: async (input: any, opts?: any) => {
          rpcOptions.push(["setGlobal", opts]);
          setGlobalCalls.push(input);
          return {};
        },
        resetSession: async (input: any, opts?: any) => {
          rpcOptions.push(["resetSession", opts]);
          resetCalls.push(input);
          return {};
        },
        getKeepalive: async (input: any, opts?: any) => {
          rpcOptions.push(["getKeepalive", opts]);
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
    location: options.location,
    data: {
      session: { get: (sessionID: string) => options.sessions?.[sessionID] },
      location: { default: () => ({ directory: "/home/default" }) },
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
    rpcOptions,
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

describe("cache-manager TUI plugin", () => {
  test("registers the cache-manager command", async () => {
    const mock = await setupTui();
    const command = mock.layer().commands[0];

    expect(command.id).toBe("cache-manager.open");
    expect(command.title).toBe("Cache Manager");
    expect(command.group).toBe("Provider");
    expect(command.slash).toEqual({ name: "cache-manager", arguments: true });
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

  describe("RPC location", () => {
    const sessions = { ses_tui: { location: { directory: "/work/project" } } };

    test("session commands target the session's directory", async () => {
      const mock = await setupTui({ sessions });

      await mock.run("1h");
      await mock.run("reset");

      expect(mock.rpcOptions).toEqual([
        ["setSession", { location: { directory: "/work/project" } }],
        ["resetSession", { location: { directory: "/work/project" } }],
      ]);
    });

    test("global changes from the home screen use the TUI's location", async () => {
      const mock = await setupTui({
        route: { type: "home" },
        location: { directory: "/work/tui" },
        selects: ["global:mode", "1h"],
      });

      await mock.run("");

      expect(mock.rpcOptions).toEqual([
        ["getSettings", { location: { directory: "/work/tui" } }],
        ["setGlobal", { location: { directory: "/work/tui" } }],
      ]);
    });

    test("falls back to the default location when nothing else is known", async () => {
      const mock = await setupTui({ selects: [undefined] });

      await mock.run("");

      expect(mock.rpcOptions).toEqual([["getSettings", { location: { directory: "/home/default" } }]]);
    });

    test("sidebar load and refresh fetch from the session's directory", async () => {
      const mock = await setupTui({ sessions, keepalive: { ses_tui: { sessionID: "ses_tui" } } });
      const sidebar = sidebarCalls[sidebarCalls.length - 1]!;

      sidebar.load("ses_tui");
      await new Promise((resolve) => setTimeout(resolve, 0));
      sidebar.refresh("ses_tui");
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(mock.rpcOptions).toEqual([
        ["getKeepalive", { location: { directory: "/work/project" } }],
        ["getKeepalive", { location: { directory: "/work/project" } }],
      ]);
    });
  });

  describe("sidebar", () => {
    const lastSidebar = () => sidebarCalls[sidebarCalls.length - 1]!;

    test("registers the sidebar slot with an initially empty snapshot map", async () => {
      sidebarCalls.length = 0;
      await setupTui();

      expect(sidebarCalls).toHaveLength(1);
      expect(lastSidebar().snapshots().size).toBe(0);
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
