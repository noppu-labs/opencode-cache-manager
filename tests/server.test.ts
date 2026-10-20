import { afterEach, beforeEach, describe, expect, jest, mock, spyOn, test } from "bun:test";
import plugin from "../src/server.ts";
import { EXTENDED_CACHE_BETA, SENTINEL_HEADER } from "../src/constants/anthropic.ts";
import { PING_PROMPT } from "../src/constants/keepalive.ts";
import { CacheTtlRpc } from "../src/rpc.ts";
import { collectCacheControls, ephemeral, makeRequest, parsedBodyOf, sampleBody } from "./helpers/fixtures.ts";

// ---------------------------------------------------------------------------
// Plugin.setup(ctx) integration
// ---------------------------------------------------------------------------

type MockCtx = {
  ctx: any;
  store: Map<string, unknown>;
  synthetic: Array<{ sessionID: string; text: string; resume?: boolean | null }>;
  command: () => any;
  hook: () => any;
  responseHook: () => any;
  rpc: () => any;
  emits: Array<{ name: string; data: unknown }>;
  generate: ReturnType<typeof mock>;
  sessionGet: ReturnType<typeof mock>;
  cleanup?: () => unknown;
};

function createMockCtx(options: Record<string, unknown> = {}): MockCtx {
  const store = new Map<string, unknown>();
  const synthetic: MockCtx["synthetic"] = [];
  let commandDef: any;
  let httpHook: any;
  let httpResponseHook: any;
  let rpcHandlers: any;
  const emits: MockCtx["emits"] = [];
  const generate = mock(async (_input: unknown) => ({}));
  const sessionGet = mock(async (input: { sessionID: string }) => ({ id: input.sessionID }));

  const ctx = {
    options,
    storage: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => {
        store.set(key, value);
      },
      remove: async (key: string) => {
        store.delete(key);
      },
      scan: async (input: { prefix: string }) => ({
        entries: [...store.entries()]
          .filter(([key]) => key.startsWith(input.prefix))
          .map(([key, value]) => ({ key, value })),
      }),
    },
    session: {
      generate,
      get: sessionGet,
      synthetic: async (input: MockCtx["synthetic"][number]) => {
        synthetic.push(input);
      },
      hook: async (name: string, cb: any) => {
        if (name === "http.request") httpHook = cb;
        if (name === "http.response") httpResponseHook = cb;
        return { dispose: async () => {} };
      },
    },
    command: {
      transform: async (cb: (editor: any) => void) => {
        cb({ add: (def: any) => (commandDef = def) });
        return { dispose: async () => {} };
      },
    },
    rpc: {
      register: async (_definition: any, handlers: any) => {
        rpcHandlers = handlers;
        return {
          events: {
            emit: async (name: string, data: unknown) => {
              emits.push({ name, data });
            },
          },
          dispose: async () => {},
        };
      },
    },
  };

  return {
    ctx,
    store,
    synthetic,
    command: () => commandDef,
    hook: () => httpHook,
    responseHook: () => httpResponseHook,
    rpc: () => rpcHandlers,
    emits,
    generate,
    sessionGet,
  };
}

async function setup(overrides: Record<string, unknown> = {}) {
  const mock = createMockCtx(overrides);
  mock.cleanup = await (plugin as any).setup(mock.ctx);
  return mock;
}

function invocation(text: string) {
  return {
    sessionID: "ses_test",
    prompt: { text },
    delivery: "queue" as const,
  };
}

describe("plugin.setup", () => {
  test("registers the cache-manager command, not cache-ttl", async () => {
    const mock = await setup();
    expect(mock.command().name).toBe("cache-manager");
  });

  test("defaults to 5m when no stored mode or option is present", async () => {
    const mock = await setup();
    await mock.command().execute(invocation("status"));
    expect(mock.synthetic).toHaveLength(1);
    expect(mock.synthetic[0].text).toContain("Session");
    expect(mock.synthetic[0].text).toContain("5m");
  });

  test("the legacy stored mode key seeds the global mode", async () => {
    const mock = createMockCtx();
    mock.store.set("mode", "hybrid");
    await (plugin as any).setup(mock.ctx);
    await mock.command().execute(invocation("status"));
    expect(mock.synthetic[0].text).toContain("hybrid");
  });

  test("falls back to ctx.options.defaultMode when storage is empty", async () => {
    const mock = await setup({ defaultMode: "1h" });
    await mock.command().execute(invocation("status"));
    expect(mock.synthetic[0].text).toContain("1h");
  });

  test("ignores an invalid stored mode", async () => {
    const mock = createMockCtx();
    mock.store.set("mode", "banana");
    await (plugin as any).setup(mock.ctx);
    await mock.command().execute(invocation("status"));
    expect(mock.synthetic[0].text).toContain("5m");
  });

  test("reads keepalive options from ctx.options", async () => {
    const mock = await setup({ keepalive: { enabled: false, maxPings: 2, minContextTokens: 20000 } });
    await mock.command().execute(invocation("status"));
    const text = mock.synthetic[0].text;
    expect(text).toContain("off");
    expect(text).toContain("2");
    expect(text).toContain("20000");
  });

  test("/cache-manager 1h writes the session layer only", async () => {
    const mock = await setup();
    await mock.command().execute(invocation("1h"));
    expect(mock.store.get("session/ses_test")).toEqual({ mode: "1h" });
    expect(mock.store.has("global")).toBe(false);
    expect(mock.store.has("mode")).toBe(false);
    expect(mock.synthetic).toHaveLength(1);
    expect(mock.synthetic[0]).toMatchObject({ sessionID: "ses_test", resume: false });
    expect(mock.synthetic[0].text).toContain("Session");
    expect(mock.synthetic[0].text).toContain("1h");
  });

  test("an explicit mode does not touch an existing global setting", async () => {
    const mock = createMockCtx();
    mock.store.set("global", { mode: "hybrid" });
    await (plugin as any).setup(mock.ctx);
    await mock.command().execute(invocation("5m"));
    expect(mock.store.get("global")).toEqual({ mode: "hybrid" });
    expect(mock.store.get("session/ses_test")).toEqual({ mode: "5m" });
  });

  test("no-arg command toggles the session mode 5m -> 1h -> 5m", async () => {
    const mock = await setup();

    await mock.command().execute(invocation(""));
    expect(mock.store.get("session/ses_test")).toEqual({ mode: "1h" });
    expect(mock.synthetic).toHaveLength(1);
    expect(mock.synthetic[0]).toMatchObject({ sessionID: "ses_test", resume: false });
    expect(mock.synthetic[0].text).toContain("1h");

    await mock.command().execute(invocation(""));
    expect(mock.store.get("session/ses_test")).toEqual({ mode: "5m" });
    expect(mock.synthetic[1].resume).toBe(false);

    await mock.command().execute(invocation(""));
    expect(mock.store.get("session/ses_test")).toEqual({ mode: "1h" });
    expect(mock.store.has("global")).toBe(false);
  });

  test("hybrid is settable per session", async () => {
    const mock = await setup();
    await mock.command().execute(invocation("hybrid"));
    expect(mock.store.get("session/ses_test")).toEqual({ mode: "hybrid" });
    expect(mock.synthetic[0].text).toContain("hybrid");
  });

  test("keepalive off, pings 3 and min 20k accumulate in the session patch", async () => {
    const mock = await setup();

    await mock.command().execute(invocation("keepalive off"));
    expect(mock.store.get("session/ses_test")).toEqual({ keepalive: false });
    expect(mock.synthetic[0].text).toContain("Session");

    await mock.command().execute(invocation("pings 3"));
    await mock.command().execute(invocation("min 20k"));
    expect(mock.store.get("session/ses_test")).toEqual({
      keepalive: false,
      maxPings: 3,
      minContextTokens: 20000,
    });
    expect(mock.synthetic[1].text).toContain("3");
    expect(mock.synthetic[2].text).toContain("20000");
    expect(mock.store.has("global")).toBe(false);
  });

  test("reset removes the session patch", async () => {
    const mock = await setup();
    await mock.command().execute(invocation("1h"));
    await mock.command().execute(invocation("reset"));
    expect(mock.store.has("session/ses_test")).toBe(false);
    expect(mock.synthetic).toHaveLength(2);
    expect(mock.synthetic[1]).toMatchObject({ sessionID: "ses_test", resume: false });
    expect(mock.synthetic[1].text).toContain("Session");
  });

  test("status reports the effective session settings without writing", async () => {
    const mock = createMockCtx();
    mock.store.set("global", { mode: "hybrid", maxPings: 7 });
    mock.store.set("session/ses_test", { keepalive: false });
    await (plugin as any).setup(mock.ctx);
    const before = new Map(mock.store);

    await mock.command().execute(invocation("status"));

    expect(new Map(mock.store)).toEqual(before);
    expect(mock.synthetic).toHaveLength(1);
    const text = mock.synthetic[0].text;
    expect(text).toContain("hybrid");
    expect(text).toContain("off");
    expect(text).toContain("7");
  });

  test("an invalid argument lists the valid ones without writing", async () => {
    const mock = await setup();
    await mock.command().execute(invocation("not-a-mode"));
    expect(mock.store.size).toBe(0);
    expect(mock.synthetic).toHaveLength(1);
    const text = mock.synthetic[0].text;
    for (const word of ["5m", "1h", "hybrid", "status", "reset", "keepalive", "pings", "min"]) {
      expect(text).toContain(word);
    }
  });
});

describe("http.request hook", () => {
  async function dispatch(
    mock: MockCtx,
    providerID: string,
    request: Request,
    sessionID = "ses_test",
  ) {
    const evt = { sessionID, kind: "primary", model: { providerID }, request };
    await mock.hook()(evt);
    return evt;
  }

  test("rewrites requests for omniroute-anthropic", async () => {
    const mock = await setup();
    await mock.command().execute(invocation("1h"));
    const evt = await dispatch(mock, "omniroute-anthropic", makeRequest(JSON.stringify(sampleBody())));
    expect(evt.request).not.toBe(undefined);
    expect(evt.request.headers.get("anthropic-beta")).toBe(EXTENDED_CACHE_BETA);
  });

  test("rewrites requests for anthropic", async () => {
    const mock = await setup();
    await mock.command().execute(invocation("1h"));
    const evt = await dispatch(mock, "anthropic", makeRequest(JSON.stringify(sampleBody())));
    const body = (await parsedBodyOf(evt.request)) as Record<string, unknown>;
    for (const cc of collectCacheControls(body)) expect(cc.ttl).toBe("1h");
  });

  test("ignores unrelated providers without a sentinel header", async () => {
    const mock = await setup();
    await mock.command().execute(invocation("1h"));
    const request = makeRequest(JSON.stringify(sampleBody()));
    const evt = await dispatch(mock, "omniroute", request);
    expect(evt.request).toBe(request);
  });

  test("honors the sentinel header even on an unrelated provider", async () => {
    const mock = await setup();
    const request = makeRequest(JSON.stringify(sampleBody()), { [SENTINEL_HEADER]: "1h" });
    const evt = await dispatch(mock, "omniroute", request);
    expect(evt.request).not.toBe(request);
    expect(evt.request.headers.has(SENTINEL_HEADER)).toBe(false);
    expect(evt.request.headers.get("anthropic-beta")).toBe(EXTENDED_CACHE_BETA);
  });

  test("two sessions with different modes get different rewrites", async () => {
    const mock = await setup();
    await mock.command().execute({ ...invocation("1h"), sessionID: "ses_a" });
    await mock.command().execute({ ...invocation("hybrid"), sessionID: "ses_b" });

    const a = await dispatch(mock, "anthropic", makeRequest(JSON.stringify(sampleBody())), "ses_a");
    const b = await dispatch(mock, "anthropic", makeRequest(JSON.stringify(sampleBody())), "ses_b");

    const aBody = (await parsedBodyOf(a.request)) as { messages: Record<string, unknown>[] };
    const bBody = (await parsedBodyOf(b.request)) as { messages: Record<string, unknown>[] };
    expect((aBody.messages[2].cache_control as Record<string, unknown>).ttl).toBe("1h");
    expect("ttl" in (bBody.messages[2].cache_control as Record<string, unknown>)).toBe(false);
    expect(collectCacheControls(bBody).some((cc) => cc.ttl === "1h")).toBe(true);
  });

  test("a session without an override uses the global mode", async () => {
    const mock = createMockCtx();
    mock.store.set("global", { mode: "1h" });
    await (plugin as any).setup(mock.ctx);
    await mock.command().execute({ ...invocation("5m"), sessionID: "ses_a" });

    const a = await dispatch(mock, "anthropic", makeRequest(JSON.stringify(sampleBody())), "ses_a");
    const other = await dispatch(mock, "anthropic", makeRequest(JSON.stringify(sampleBody())), "ses_other");

    expect(a.request.headers.get("anthropic-beta")).toBeNull();
    expect(other.request.headers.get("anthropic-beta")).toBe(EXTENDED_CACHE_BETA);
  });

  test("x-cache-ttl still wins over the session mode", async () => {
    const mock = await setup();
    await mock.command().execute(invocation("1h"));
    const request = makeRequest(JSON.stringify(sampleBody()), { [SENTINEL_HEADER]: "5m" });
    const evt = await dispatch(mock, "anthropic", request);
    expect(evt.request.headers.has(SENTINEL_HEADER)).toBe(false);
    expect(evt.request.headers.get("anthropic-beta")).toBeNull();
    const body = (await parsedBodyOf(evt.request)) as Record<string, unknown>;
    for (const cc of collectCacheControls(body)) expect("ttl" in cc).toBe(false);
  });

  test("uses the current in-memory session mode after a toggle", async () => {
    const mock = await setup();
    await mock.command().execute(invocation(""));
    const evt = await dispatch(mock, "anthropic", makeRequest(JSON.stringify(sampleBody())));
    expect(evt.request.headers.get("anthropic-beta")).toBe(EXTENDED_CACHE_BETA);
  });
});

// ---------------------------------------------------------------------------
// keepalive wiring
// ---------------------------------------------------------------------------

describe("keepalive wiring", () => {
  const T0 = 1_700_000_000_000;
  const FIVE_MIN = 300_000;
  const FIFTY_MIN = 3_000_000;
  const open: MockCtx[] = [];

  beforeEach(() => {
    jest.useFakeTimers({ now: T0 });
  });

  afterEach(() => {
    for (const mock of open.splice(0)) mock.cleanup?.();
    jest.useRealTimers();
  });

  async function start(options: Record<string, unknown> = {}) {
    const mock = await setup(options);
    open.push(mock);
    return mock;
  }

  /** Lets the response tee, usage parsing and engine promises settle. */
  async function flush() {
    for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve));
  }

  const WRITE_1H = {
    input_tokens: 10,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 60_000,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 60_000 },
  };
  const READ_HIT = {
    input_tokens: 10,
    cache_read_input_tokens: 60_000,
    cache_creation_input_tokens: 0,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
  };

  interface Turn {
    sessionID?: string;
    kind?: string;
    providerID?: string;
    url?: string;
    usage?: Record<string, number | Record<string, number>>;
    status?: number;
    body?: Record<string, unknown>;
    responseText?: string;
  }

  /** Runs the request hook, then the response hook, the way the host does for one model call. */
  async function roundTrip(mock: MockCtx, turn: Turn = {}) {
    const sessionID = turn.sessionID ?? "ses_a";
    const kind = turn.kind ?? "primary";
    const model = { providerID: turn.providerID ?? "anthropic" };
    const request = new Request(turn.url ?? "https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(turn.body ?? sampleBody()),
    });
    const requestEvt = { sessionID, kind, model, request };
    await mock.hook()(requestEvt);
    const original = turn.responseText ?? JSON.stringify({ usage: turn.usage ?? WRITE_1H });
    const responseEvt = {
      sessionID,
      kind,
      model,
      request: requestEvt.request,
      response: new Response(original, {
        status: turn.status ?? 200,
        headers: { "content-type": "application/json" },
      }),
    } as { response: Response } & Record<string, unknown>;
    await mock.responseHook()(responseEvt);
    return { requestEvt, responseEvt, original };
  }

  const snapshots = (mock: MockCtx, sessionID = "ses_a") =>
    mock.emits
      .filter((e) => e.name === "keepalive.updated" && (e.data as any).sessionID === sessionID)
      .map((e) => e.data as any);
  const lastSnapshot = (mock: MockCtx, sessionID = "ses_a") => snapshots(mock, sessionID).at(-1);

  /** A generate stand-in that performs the ping's own request/response round trip. */
  function pingingGenerate(mock: MockCtx, gates: Record<string, Promise<void>> = {}) {
    mock.generate.mockImplementation(async (input: any) => {
      await gates[input.sessionID];
      await roundTrip(mock, { sessionID: input.sessionID, kind: "generate", usage: READ_HIT });
      return {};
    });
  }

  test("an Anthropic response with cache activity publishes a detected 1h snapshot", async () => {
    const mock = await start();
    await roundTrip(mock);
    await flush();

    const snapshot = lastSnapshot(mock);
    expect(snapshot).toMatchObject({
      sessionID: "ses_a",
      ttl: "1h",
      ttlSource: "detected",
      contextTokens: 60_010,
      minContextTokens: 50_000,
      skipReason: null,
    });
    expect(snapshot.nextPingAt).toBe(T0 + FIFTY_MIN);
    expect(snapshot.expiresAt).toBe(T0 + 3_600_000);
  });

  test("when the timer fires, generate is called with the ping prompt", async () => {
    const mock = await start();
    pingingGenerate(mock);
    await roundTrip(mock);
    await flush();

    jest.advanceTimersByTime(FIFTY_MIN);
    await flush();

    expect(mock.generate).toHaveBeenCalledTimes(1);
    expect(mock.generate.mock.calls[0][0]).toEqual({ sessionID: "ses_a", prompt: PING_PROMPT });
  });

  test("a ping is recorded as a hit only after its response is observed", async () => {
    const mock = await start();
    pingingGenerate(mock);
    await roundTrip(mock);
    await flush();

    jest.advanceTimersByTime(FIFTY_MIN);
    await flush();

    expect(lastSnapshot(mock)).toMatchObject({ lastPing: "hit", pingsUsed: 1, skipReason: null });
  });

  test("a ping whose request never reaches an Anthropic hook counts as failed", async () => {
    const mock = await start();
    await roundTrip(mock);
    await flush();

    jest.advanceTimersByTime(FIFTY_MIN);
    await flush();

    expect(mock.generate).toHaveBeenCalledTimes(1);
    expect(lastSnapshot(mock)).toMatchObject({ lastPing: "failed", pingsUsed: 1 });
  });

  test("a throwing generate counts as a failed ping", async () => {
    const mock = await start();
    mock.generate.mockImplementation(async () => {
      throw new Error("boom");
    });
    await roundTrip(mock);
    await flush();

    jest.advanceTimersByTime(FIFTY_MIN);
    await flush();

    expect(lastSnapshot(mock)).toMatchObject({ lastPing: "failed" });
  });

  test("ping flag is per session", async () => {
    const mock = await start();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    pingingGenerate(mock, { ses_a: gate });

    await roundTrip(mock, { sessionID: "ses_a" });
    await roundTrip(mock, { sessionID: "ses_b" });
    await flush();

    jest.advanceTimersByTime(FIFTY_MIN);
    await flush();
    expect(lastSnapshot(mock, "ses_b")).toMatchObject({ pingsUsed: 1, lastPing: "hit" });
    expect(lastSnapshot(mock, "ses_a")).toMatchObject({ pingsUsed: 1, nextPingAt: null });

    await roundTrip(mock, { sessionID: "ses_b", kind: "generate", usage: WRITE_1H });
    await flush();
    expect(lastSnapshot(mock, "ses_b")).toMatchObject({ pingsUsed: 0, lastPing: null });

    release();
    await flush();
    expect(lastSnapshot(mock, "ses_a")).toMatchObject({ lastPing: "hit" });
  });

  test("a non-Anthropic provider and URL produce no snapshot", async () => {
    const mock = await start();
    await roundTrip(mock, {
      providerID: "openai",
      url: "https://api.openai.com/v1/chat/completions",
    });
    await flush();
    expect(mock.emits.filter((e) => e.name === "keepalive.updated")).toHaveLength(0);
  });

  test("an Anthropic-shaped URL on an unknown provider is still observed", async () => {
    const mock = await start();
    await roundTrip(mock, { providerID: "some-proxy", url: "https://proxy.example/anthropic/v1/messages" });
    await flush();
    expect(lastSnapshot(mock)).toMatchObject({ ttl: "1h" });
  });

  test("a session with a parent is skipped as a child", async () => {
    const mock = await start();
    mock.sessionGet.mockImplementation(async (input: any) => ({ id: input.sessionID, parentID: "ses_parent" }));
    await roundTrip(mock);
    await flush();
    expect(lastSnapshot(mock)).toMatchObject({ skipReason: "child", nextPingAt: null });
  });

  test("a failed parent lookup does not schedule a ping", async () => {
    const mock = await start();
    mock.sessionGet.mockImplementation(async () => {
      throw new Error("lookup failed");
    });
    await roundTrip(mock);
    await flush();
    expect(lastSnapshot(mock)).toMatchObject({ skipReason: "child", nextPingAt: null });
    jest.advanceTimersByTime(FIFTY_MIN);
    await flush();
    expect(mock.generate).not.toHaveBeenCalled();
  });

  test("/cache-manager keepalive off disables the session and cancels the timer", async () => {
    const mock = await start();
    await roundTrip(mock);
    await flush();
    expect(lastSnapshot(mock).nextPingAt).toBe(T0 + FIFTY_MIN);

    await mock.command().execute({ ...invocation("keepalive off"), sessionID: "ses_a" });
    await flush();

    expect(lastSnapshot(mock)).toMatchObject({ skipReason: "disabled", nextPingAt: null });
    jest.advanceTimersByTime(FIFTY_MIN);
    await flush();
    expect(mock.generate).not.toHaveBeenCalled();
  });

  test("the typed command also publishes settings.updated for the session", async () => {
    const mock = await start();
    await mock.command().execute({ ...invocation("1h"), sessionID: "ses_a" });
    await mock.command().execute({ ...invocation("reset"), sessionID: "ses_a" });
    const updates = mock.emits.filter((e) => e.name === "settings.updated");
    expect(updates).toEqual([
      { name: "settings.updated", data: { sessionID: "ses_a" } },
      { name: "settings.updated", data: { sessionID: "ses_a" } },
    ]);
  });

  test("RPC setSession re-evaluates the schedule", async () => {
    const mock = await start();
    await roundTrip(mock);
    await flush();

    await mock.rpc().setSession({ sessionID: "ses_a", patch: { keepalive: false } });
    await flush();

    expect(lastSnapshot(mock)).toMatchObject({ skipReason: "disabled", nextPingAt: null });
  });

  test("RPC setGlobal re-evaluates every known session", async () => {
    const mock = await start();
    await roundTrip(mock, { sessionID: "ses_a" });
    await roundTrip(mock, { sessionID: "ses_b" });
    await flush();

    await mock.rpc().setGlobal({ patch: { keepalive: false } });
    await flush();

    expect(lastSnapshot(mock, "ses_a")).toMatchObject({ skipReason: "disabled" });
    expect(lastSnapshot(mock, "ses_b")).toMatchObject({ skipReason: "disabled" });
  });

  test("RPC resetSession re-evaluates the schedule", async () => {
    const mock = await start();
    await mock.rpc().setSession({ sessionID: "ses_a", patch: { keepalive: false } });
    await roundTrip(mock);
    await flush();
    expect(lastSnapshot(mock)).toMatchObject({ skipReason: "disabled" });

    await mock.rpc().resetSession({ sessionID: "ses_a" });
    await flush();
    expect(lastSnapshot(mock)).toMatchObject({ skipReason: null, nextPingAt: T0 + FIFTY_MIN });
  });

  test("the keepalive snapshot schema requires minContextTokens as an integer", () => {
    const schema = (CacheTtlRpc.methods.getKeepalive.output as any);
    expect(schema.properties.minContextTokens).toEqual({ type: "integer", minimum: 0 });
    expect(schema.required).toContain("minContextTokens");
    expect((CacheTtlRpc.events["keepalive.updated"].schema as any).required).toContain("minContextTokens");
  });

  test("RPC getKeepalive returns the current snapshot", async () => {
    const mock = await start();
    await roundTrip(mock);
    await flush();

    expect(await mock.rpc().getKeepalive({ sessionID: "ses_a" })).toEqual(lastSnapshot(mock));
    expect(await mock.rpc().getKeepalive({ sessionID: "ses_unknown" })).toMatchObject({
      sessionID: "ses_unknown",
      ttl: null,
      nextPingAt: null,
      minContextTokens: 50_000,
    });
  });

  test("cleanup disposes the engine", async () => {
    const mock = await start();
    await roundTrip(mock);
    await flush();
    expect(typeof mock.cleanup).toBe("function");

    await mock.cleanup!();
    jest.advanceTimersByTime(FIFTY_MIN * 2);
    await flush();

    expect(mock.generate).not.toHaveBeenCalled();
  });

  test("the response returned by the hook has the original body", async () => {
    const mock = await start();
    const { responseEvt, original } = await roundTrip(mock);
    expect(await responseEvt.response.text()).toBe(original);
    expect(responseEvt.response.status).toBe(200);
  });

  test("a failed response does not extend the expiry", async () => {
    const mock = await start();
    await roundTrip(mock);
    await flush();

    jest.advanceTimersByTime(FIVE_MIN);
    await roundTrip(mock, { status: 529, usage: {} });
    await flush();

    expect(lastSnapshot(mock).lastRequestAt).toBe(T0);
  });

  test("an uncached response with no usage still resets the pending schedule", async () => {
    const mock = await start();
    await roundTrip(mock);
    await flush();

    jest.advanceTimersByTime(FIVE_MIN);
    await roundTrip(mock, { responseText: "{}" });
    await flush();

    expect(lastSnapshot(mock)).toMatchObject({ lastRequestAt: T0 + FIVE_MIN, nextPingAt: T0 + FIVE_MIN + FIFTY_MIN });
  });

  test("the requested TTL is read before the sentinel is stripped", async () => {
    const mock = await start();
    const request = new Request("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", [SENTINEL_HEADER]: "1h" },
      body: JSON.stringify(sampleBody()),
    });
    const evt = { sessionID: "ses_a", kind: "primary", model: { providerID: "anthropic" }, request };
    await mock.hook()(evt);
    await mock.responseHook()({
      ...evt,
      request: evt.request,
      response: new Response(JSON.stringify({ usage: { input_tokens: 10, cache_read_input_tokens: 60_000 } }), {
        headers: { "content-type": "application/json" },
      }),
    });
    await flush();
    expect(evt.request.headers.has(SENTINEL_HEADER)).toBe(false);
    expect(lastSnapshot(mock)).toMatchObject({ ttl: "1h", ttlSource: "requested" });
  });

  describe("ping alignment", () => {
    const messagesOf = async (request: Request) => ((await parsedBodyOf(request)) as any).messages as unknown[];

    test("the ping's history is replaced by the stored primary messages", async () => {
      const mock = await start();
      await mock.command().execute({ ...invocation("1h"), sessionID: "ses_a" });
      const { requestEvt: primary } = await roundTrip(mock);
      const primaryMessages = await messagesOf(primary.request);

      const diverging = sampleBody();
      diverging.messages = [
        { role: "user", content: [{ type: "text", text: "rewritten 0" }] },
        { role: "assistant", content: [{ type: "text", text: "rewritten 1" }] },
        { role: "user", content: [{ type: "text", text: "rewritten 2" }] },
        { role: "user", content: [{ type: "text", text: PING_PROMPT }] },
      ];
      let sent: unknown[] = [];
      mock.generate.mockImplementation(async () => {
        const { requestEvt } = await roundTrip(mock, { kind: "generate", body: diverging, usage: READ_HIT });
        sent = await messagesOf(requestEvt.request);
        return {};
      });
      await flush();
      jest.advanceTimersByTime(FIFTY_MIN);
      await flush();

      expect(mock.generate).toHaveBeenCalledTimes(1);
      expect(sent).toHaveLength(4);
      expect(sent.slice(0, 3)).toEqual(primaryMessages);
      expect(sent[3]).toEqual((diverging.messages as unknown[])[3]);
    });

    test("the ping body has exactly the primary's cache_control occurrences in messages", async () => {
      const mock = await start();
      await mock.command().execute({ ...invocation("1h"), sessionID: "ses_a" });
      const { requestEvt: primary } = await roundTrip(mock);
      const primaryMessages = await messagesOf(primary.request);
      expect(collectCacheControls(primaryMessages).length).toBeGreaterThan(0);

      const marked = (text: string) => ({
        role: "user",
        cache_control: ephemeral(),
        content: [{ type: "text", text, cache_control: ephemeral() }],
      });
      const diverging = sampleBody();
      diverging.messages = [marked("d0"), marked("d1"), marked("d2"), marked("d3"), marked(PING_PROMPT)];
      let sent: unknown[] = [];
      mock.generate.mockImplementation(async () => {
        const { requestEvt } = await roundTrip(mock, { kind: "generate", body: diverging, usage: READ_HIT });
        sent = await messagesOf(requestEvt.request);
        return {};
      });
      await flush();
      jest.advanceTimersByTime(FIFTY_MIN);
      await flush();

      expect(sent).toHaveLength(5);
      expect(collectCacheControls(sent)).toHaveLength(collectCacheControls(primaryMessages).length);
      expect(JSON.stringify(sent.slice(0, 3))).toBe(JSON.stringify(primaryMessages));
      expect(collectCacheControls(sent.slice(3))).toHaveLength(0);
    });

    test("a ping with no stored primary is sent as-is, keeping its own cache_control", async () => {
      const mock = await start();
      // A compaction request seeds the engine without storing primary messages.
      await roundTrip(mock, { kind: "compaction" });
      await flush();

      const body = sampleBody();
      let sent: unknown[] = [];
      mock.generate.mockImplementation(async () => {
        const { requestEvt } = await roundTrip(mock, { kind: "generate", body, usage: READ_HIT });
        sent = await messagesOf(requestEvt.request);
        return {};
      });
      jest.advanceTimersByTime(FIFTY_MIN);
      await flush();

      expect(mock.generate).toHaveBeenCalledTimes(1);
      expect(sent).toEqual(body.messages as unknown[]);
      expect(collectCacheControls(sent)).toHaveLength(2);
    });

    test("a primary request body is never altered by alignment", async () => {
      const mock = await start();
      await roundTrip(mock);
      const body = sampleBody();
      const { requestEvt } = await roundTrip(mock, { body });
      expect(await messagesOf(requestEvt.request)).toEqual(body.messages as unknown[]);
    });

    /** TTLs of every breakpoint in request order: tools, system, then messages. */
    const breakpointTtls = (body: any): string[] =>
      collectCacheControls([body.tools, body.system, body.messages]).map((cc) => String(cc.ttl ?? "5m"));

    /** Sends a primary in `from`, switches the session to `to`, fires a ping and returns its final request. */
    async function pingAfterModeChange(from: string, to: string) {
      const mock = await start();
      await mock.command().execute({ ...invocation(from), sessionID: "ses_a" });
      await roundTrip(mock);
      await mock.command().execute({ ...invocation(to), sessionID: "ses_a" });
      await flush();
      const diverging = sampleBody();
      (diverging.messages as unknown[]).push({ role: "user", content: [{ type: "text", text: PING_PROMPT }] });
      let sent: Request | undefined;
      mock.generate.mockImplementation(async () => {
        const { requestEvt } = await roundTrip(mock, { kind: "generate", body: diverging, usage: READ_HIT });
        sent = requestEvt.request;
        return {};
      });
      jest.advanceTimersByTime(FIFTY_MIN);
      await flush();
      expect(mock.generate).toHaveBeenCalledTimes(1);
      return sent!;
    }

    test("a ping after switching 1h -> 5m carries no 1h breakpoint and no extended beta", async () => {
      const sent = await pingAfterModeChange("1h", "5m");
      const body = await parsedBodyOf(sent);
      expect(breakpointTtls(body).length).toBeGreaterThan(0);
      expect(breakpointTtls(body).every((ttl) => ttl === "5m")).toBe(true);
      expect(sent.headers.get("anthropic-beta") ?? "").not.toContain(EXTENDED_CACHE_BETA);
    });

    test("a ping after switching 5m -> 1h is all 1h and carries the extended beta", async () => {
      const sent = await pingAfterModeChange("5m", "1h");
      const body = await parsedBodyOf(sent);
      expect(breakpointTtls(body).length).toBeGreaterThan(0);
      expect(breakpointTtls(body).every((ttl) => ttl === "1h")).toBe(true);
      expect(sent.headers.get("anthropic-beta")).toBe(EXTENDED_CACHE_BETA);
      expect(collectCacheControls((body.messages as unknown[]).slice(3))).toHaveLength(0);
    });

    test("a hybrid ping after a 1h primary keeps 1h breakpoints ahead of 5m ones", async () => {
      const sent = await pingAfterModeChange("1h", "hybrid");
      const ttls = breakpointTtls(await parsedBodyOf(sent));
      const firstShort = ttls.indexOf("5m");
      expect(firstShort).toBeGreaterThan(0);
      expect(ttls.slice(firstShort).every((ttl) => ttl === "5m")).toBe(true);
      expect(sent.headers.get("anthropic-beta")).toBe(EXTENDED_CACHE_BETA);
    });

    test("the aligned ping request keeps the original abort signal", async () => {
      const mock = await start();
      await roundTrip(mock);
      await flush();
      const controller = new AbortController();
      let sent: Request | undefined;
      mock.generate.mockImplementation(async () => {
        const evt = {
          sessionID: "ses_a",
          kind: "generate",
          model: { providerID: "anthropic" },
          request: new Request("https://api.anthropic.com/v1/messages", {
            method: "POST",
            body: JSON.stringify(sampleBody()),
            signal: controller.signal,
          }),
        };
        await mock.hook()(evt);
        sent = evt.request;
        return {};
      });
      jest.advanceTimersByTime(FIFTY_MIN);
      await flush();
      expect(sent!.signal.aborted).toBe(false);
      controller.abort();
      expect(sent!.signal.aborted).toBe(true);
    });

    /** Fires the next ping with a diverging body; true when the ping was aligned to stored messages. */
    async function nextPingAligned(mock: MockCtx, advance = FIFTY_MIN) {
      const diverging = sampleBody();
      diverging.messages = [
        { role: "user", content: [{ type: "text", text: "rewritten 0" }] },
        { role: "user", content: [{ type: "text", text: PING_PROMPT }] },
      ];
      let sent: unknown[] | undefined;
      mock.generate.mockImplementation(async () => {
        const { requestEvt } = await roundTrip(mock, { kind: "generate", body: diverging, usage: READ_HIT });
        sent = await messagesOf(requestEvt.request);
        return {};
      });
      jest.advanceTimersByTime(advance);
      await flush();
      expect(sent).toBeDefined();
      return JSON.stringify(sent![0]) !== JSON.stringify((diverging.messages as unknown[])[0]);
    }

    test("a compaction request drops the stored primary messages", async () => {
      const mock = await start();
      await roundTrip(mock);
      await flush();
      await roundTrip(mock, { kind: "compaction" });
      await flush();
      expect(await nextPingAligned(mock)).toBe(false);
    });

    test("stored messages are kept while pings continue", async () => {
      const mock = await start();
      await roundTrip(mock);
      await flush();
      expect(await nextPingAligned(mock)).toBe(true);
    });

    test("stored messages are dropped once the session is exhausted", async () => {
      const mock = await start();
      await mock.command().execute({ ...invocation("pings 1"), sessionID: "ses_a" });
      await roundTrip(mock);
      await flush();
      expect(await nextPingAligned(mock)).toBe(true);
      expect(lastSnapshot(mock)).toMatchObject({ skipReason: "exhausted" });

      await mock.command().execute({ ...invocation("pings 5"), sessionID: "ses_a" });
      await flush();
      expect(await nextPingAligned(mock)).toBe(false);
    });

    test("messages of a child session are not stored", async () => {
      const mock = await start();
      mock.sessionGet.mockImplementation(async () => {
        throw new Error("lookup failed");
      });
      await roundTrip(mock);
      await flush();
      expect(lastSnapshot(mock)).toMatchObject({ skipReason: "child" });
      await roundTrip(mock);
      await flush();

      // The failed lookup is retried and now reports a top-level session.
      mock.sessionGet.mockImplementation(async (input: any) => ({ id: input.sessionID }));
      await mock.rpc().setSession({ sessionID: "ses_a", patch: { maxPings: 4 } });
      await flush();
      expect(lastSnapshot(mock)).toMatchObject({ skipReason: null });
      expect(await nextPingAligned(mock)).toBe(false);
    });

    test("cleanup clears the stored messages", async () => {
      const mock = await start();
      await roundTrip(mock);
      await flush();
      const clear = spyOn(Map.prototype, "clear");
      try {
        await mock.cleanup!();
        expect(clear).toHaveBeenCalled();
      } finally {
        clear.mockRestore();
      }
    });
  });

  describe("hook failures never fail the host request", () => {
    test("a response whose body is already locked passes through unchanged", async () => {
      const mock = await start();
      const response = new Response(JSON.stringify({ usage: WRITE_1H }), {
        headers: { "content-type": "application/json" },
      });
      response.body!.getReader();
      const evt = {
        sessionID: "ses_a",
        kind: "primary",
        model: { providerID: "anthropic" },
        request: new Request("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" }),
        response,
      };
      await mock.responseHook()(evt);
      expect(evt.response).toBe(response);
    });

    test("a rejecting storage lookup still rewrites with the global mode", async () => {
      const mock = await start();
      await mock.rpc().setGlobal({ patch: { mode: "1h" } });
      mock.ctx.storage.get = async () => {
        throw new Error("storage down");
      };
      const evt = {
        sessionID: "ses_never_seen",
        kind: "primary",
        model: { providerID: "anthropic" },
        request: makeRequest(JSON.stringify(sampleBody())),
      };
      await mock.hook()(evt);
      const body = await parsedBodyOf(evt.request);
      expect(collectCacheControls(body).every((cc) => cc.ttl === "1h")).toBe(true);
      expect(evt.request.headers.get("anthropic-beta")).toBe(EXTENDED_CACHE_BETA);
    });

    test("an unparseable ping request still passes through", async () => {
      const mock = await start();
      await roundTrip(mock);
      await flush();
      let sent: Request | undefined;
      mock.generate.mockImplementation(async () => {
        const evt = {
          sessionID: "ses_a",
          kind: "generate",
          model: { providerID: "anthropic" },
          request: makeRequest("not json"),
        };
        await mock.hook()(evt);
        sent = evt.request;
        return {};
      });
      jest.advanceTimersByTime(FIFTY_MIN);
      await flush();
      expect(await sent!.text()).toBe("not json");
    });
  });

  test("a primary response stopping for tool_use marks the session busy", async () => {
    const mock = await start();
    await roundTrip(mock, { responseText: JSON.stringify({ stop_reason: "tool_use", usage: WRITE_1H }) });
    await flush();
    expect(lastSnapshot(mock)).toMatchObject({ skipReason: "busy", nextPingAt: null });
    jest.advanceTimersByTime(FIFTY_MIN);
    await flush();
    expect(mock.generate).not.toHaveBeenCalled();

    await roundTrip(mock, { responseText: JSON.stringify({ stop_reason: "end_turn", usage: WRITE_1H }) });
    await flush();
    expect(lastSnapshot(mock)).toMatchObject({ skipReason: null });
  });

  test("a title response does not overwrite the context size or TTL", async () => {
    const mock = await start();
    await roundTrip(mock);
    await flush();
    await roundTrip(mock, {
      kind: "title",
      usage: { input_tokens: 10, cache_creation_input_tokens: 500, cache_creation: { ephemeral_5m_input_tokens: 500 } },
    });
    await flush();
    expect(lastSnapshot(mock)).toMatchObject({ ttl: "1h", contextTokens: 60_010 });
  });

  describe("startup sweep", () => {
    test("removes stored settings for sessions that no longer exist", async () => {
      const mock = createMockCtx();
      mock.store.set("session/ses_gone", { mode: "1h" });
      mock.store.set("session/ses_live", { mode: "1h" });
      mock.store.set("global", { mode: "5m" });
      mock.sessionGet.mockImplementation(async (input: any) => {
        if (input.sessionID === "ses_gone") throw Object.assign(new Error("Session not found"), { _tag: "SessionNotFoundError" });
        return { id: input.sessionID };
      });
      mock.cleanup = await (plugin as any).setup(mock.ctx);
      open.push(mock);
      await flush();

      expect(mock.store.has("session/ses_gone")).toBe(false);
      expect(mock.store.has("session/ses_live")).toBe(true);
      expect(mock.store.has("global")).toBe(true);
    });

    test("keeps stored settings when the lookup fails for another reason", async () => {
      const mock = createMockCtx();
      mock.store.set("session/ses_a", { mode: "1h" });
      mock.sessionGet.mockImplementation(async () => {
        throw new Error("network down");
      });
      mock.cleanup = await (plugin as any).setup(mock.ctx);
      open.push(mock);
      await flush();

      expect(mock.store.has("session/ses_a")).toBe(true);
    });

    test("a failing scan does not fail setup", async () => {
      const mock = createMockCtx();
      mock.ctx.storage.scan = async () => {
        throw new Error("scan unsupported");
      };
      mock.cleanup = await (plugin as any).setup(mock.ctx);
      open.push(mock);
      await flush();
      expect(typeof mock.cleanup).toBe("function");
    });
  });
});

// ---------------------------------------------------------------------------
// RPC contract (server ctx.rpc.register / getSettings / setGlobal / setSession / resetSession)
// ---------------------------------------------------------------------------

describe("cache-manager RPC", () => {
  test("setup resolves and getSettings returns the built-in defaults", async () => {
    const mock = createMockCtx();
    await (plugin as any).setup(mock.ctx);
    expect(mock.rpc()).toBeDefined();
    expect(await mock.rpc().getSettings({})).toEqual({
      global: { mode: "5m", keepalive: true, maxPings: 5, minContextTokens: 50_000 },
      session: null,
    });
  });

  test("getSettings returns both layers for a session", async () => {
    const mock = createMockCtx();
    mock.store.set("global", { mode: "hybrid" });
    mock.store.set("session/ses_x", { mode: "1h" });
    await (plugin as any).setup(mock.ctx);

    const result = await mock.rpc().getSettings({ sessionID: "ses_x" });
    expect(result.global.mode).toBe("hybrid");
    expect(result.session).toEqual({ mode: "1h" });
    expect((await mock.rpc().getSettings({ sessionID: "ses_none" })).session).toEqual({});
  });

  test("getSettings reflects the legacy mode key and defaultMode option", async () => {
    const legacy = createMockCtx();
    legacy.store.set("mode", "1h");
    await (plugin as any).setup(legacy.ctx);
    expect((await legacy.rpc().getSettings({})).global.mode).toBe("1h");

    const optioned = createMockCtx({ defaultMode: "hybrid" });
    await (plugin as any).setup(optioned.ctx);
    expect((await optioned.rpc().getSettings({})).global.mode).toBe("hybrid");
  });

  test("setSession persists, emits settings.updated with the session ID and returns {}", async () => {
    const mock = createMockCtx();
    await (plugin as any).setup(mock.ctx);

    const result = await mock.rpc().setSession({ sessionID: "ses_x", patch: { mode: "hybrid" } });

    expect(result).toEqual({});
    expect(mock.store.get("session/ses_x")).toEqual({ mode: "hybrid" });
    expect(mock.emits).toEqual([{ name: "settings.updated", data: { sessionID: "ses_x" } }]);
    expect((await mock.rpc().getSettings({ sessionID: "ses_x" })).session).toEqual({ mode: "hybrid" });
  });

  test("setGlobal persists, emits settings.updated with null and returns {}", async () => {
    const mock = createMockCtx();
    await (plugin as any).setup(mock.ctx);

    const result = await mock.rpc().setGlobal({ patch: { mode: "1h", maxPings: 2 } });

    expect(result).toEqual({});
    expect(mock.store.get("global")).toEqual({ mode: "1h", maxPings: 2 });
    expect(mock.emits).toEqual([{ name: "settings.updated", data: { sessionID: null } }]);
    expect((await mock.rpc().getSettings({})).global.mode).toBe("1h");
  });

  test("a global change applies to the http.request hook", async () => {
    const mock = createMockCtx();
    await (plugin as any).setup(mock.ctx);
    await mock.rpc().setGlobal({ patch: { mode: "1h" } });

    const evt = {
      sessionID: "ses_x",
      kind: "primary",
      model: { providerID: "anthropic" },
      request: makeRequest(JSON.stringify(sampleBody())),
    };
    await mock.hook()(evt);
    expect(evt.request.headers.get("anthropic-beta")).toBe(EXTENDED_CACHE_BETA);
  });

  test("resetSession clears the session patch, emits and returns {}", async () => {
    const mock = createMockCtx();
    mock.store.set("session/ses_x", { mode: "1h" });
    await (plugin as any).setup(mock.ctx);

    const result = await mock.rpc().resetSession({ sessionID: "ses_x" });

    expect(result).toEqual({});
    expect(mock.store.has("session/ses_x")).toBe(false);
    expect(mock.emits).toEqual([{ name: "settings.updated", data: { sessionID: "ses_x" } }]);
    expect((await mock.rpc().getSettings({ sessionID: "ses_x" })).session).toEqual({});
  });

  test("invalid patch fields are rejected without changing state", async () => {
    const mock = createMockCtx();
    await (plugin as any).setup(mock.ctx);

    await expect(
      mock.rpc().setSession({ sessionID: "ses_x", patch: { mode: "bogus" } }),
    ).rejects.toThrow();
    await expect(mock.rpc().setSession({ sessionID: "ses_x", patch: { maxPings: 101 } })).rejects.toThrow();
    await expect(mock.rpc().setGlobal({ patch: { minContextTokens: -1 } })).rejects.toThrow();
    await expect(mock.rpc().setGlobal({ patch: { unknown: 1 } })).rejects.toThrow();
    await expect(mock.rpc().setGlobal({ patch: "1h" })).rejects.toThrow();

    expect(mock.store.size).toBe(0);
    expect(mock.emits).toHaveLength(0);
    expect((await mock.rpc().getSettings({})).global.mode).toBe("5m");
  });
});
