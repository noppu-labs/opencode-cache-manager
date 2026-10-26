import { afterEach, beforeEach, describe, expect, jest, mock, spyOn, test } from "bun:test";
import plugin from "../src/server.ts";
import { EXTENDED_CACHE_BETA, SENTINEL_HEADER } from "../src/constants/anthropic.ts";
import { PING_PROMPT } from "../src/constants/keepalive.ts";
import { CacheTtlRpc } from "../src/rpc.ts";
import { collectCacheControls, makeRequest, openaiSse, openaiUsage, parsedBodyOf, sampleBody } from "./helpers/fixtures.ts";

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

});

// ---------------------------------------------------------------------------
// keepalive wiring
// ---------------------------------------------------------------------------

describe("keepalive wiring", () => {
  const T0 = 1_700_000_000_000;
  const FIVE_MIN = 300_000;
  const FIFTY_MIN = 3_000_000;
  const TEN_HOURS = 36_000_000;
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
    modelID?: string;
    contentType?: string;
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
    const model = { providerID: turn.providerID ?? "anthropic", id: turn.modelID ?? "claude-sonnet-5-5" };
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
        headers: { "content-type": turn.contentType ?? "application/json" },
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

  describe("openai-chat", () => {
    const CHAT_URL = "https://omni.example/v1/chat/completions";
    const WRITE_CHAT = { ...openaiUsage.lunaWrite, prompt_tokens: 60_000, cache_creation_input_tokens: 59_000 };
    const READ_CHAT = {
      ...openaiUsage.lunaRead,
      prompt_tokens: 60_100,
      prompt_tokens_details: { cached_tokens: 59_000 },
    };
    const chatMessages = (last: string) => [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: last },
    ];
    const chatBody = (model: string, last = "again") => ({
      model,
      tools: [{ type: "function", function: { name: "tool_a" } }],
      messages: chatMessages(last),
    });
    const chatTurn = (modelID: string, turn: Turn & { sse?: Parameters<typeof openaiSse> } = {}): Turn => ({
      providerID: "omniroute",
      modelID,
      url: CHAT_URL,
      contentType: "text/event-stream",
      body: chatBody(modelID),
      responseText: openaiSse(...(turn.sse ?? [WRITE_CHAT])),
      ...turn,
    });

    test("a Claude model is injected, pinged with an aligned request and the ping is a hit", async () => {
      const mock = await start({ defaultMode: "1h" });
      const pings: Array<Record<string, any>> = [];
      mock.generate.mockImplementation(async (input: any) => {
        const ping = await roundTrip(mock, {
          ...chatTurn("claude-opus-5-5", { sse: [READ_CHAT, { model: "claude-opus-5-5", provider: "Anthropic" }] }),
          sessionID: input.sessionID,
          kind: "generate",
          body: chatBody("claude-opus-5-5", PING_PROMPT),
        });
        pings.push((await parsedBodyOf(ping.requestEvt.request)) as Record<string, any>);
        return {};
      });

      const first = await roundTrip(mock, chatTurn("claude-opus-5-5"));
      await flush();
      const primary = (await parsedBodyOf(first.requestEvt.request)) as Record<string, any>;
      expect(collectCacheControls(primary).length).toBeGreaterThan(0);
      expect(first.requestEvt.request.headers.get("anthropic-beta")).toBe(EXTENDED_CACHE_BETA);
      expect(lastSnapshot(mock)).toMatchObject({
        ttl: "1h",
        ttlSource: "requested",
        contextTokens: 60_000,
        skipReason: null,
        nextPingAt: T0 + FIFTY_MIN,
      });

      jest.advanceTimersByTime(FIFTY_MIN);
      await flush();

      expect(mock.generate).toHaveBeenCalledTimes(1);
      expect(pings[0]?.messages.slice(0, 3)).toEqual(primary.messages.slice(0, 3));
      expect(pings[0]?.messages[3]).toEqual({ role: "user", content: PING_PROMPT });
      expect(lastSnapshot(mock)).toMatchObject({ lastPing: "hit", pingsUsed: 1 });
    });

    test("a GPT model is pinged on the 12h schedule with an aligned request and the ping is a hit", async () => {
      const mock = await start({ defaultMode: "1h" });
      const model = "gpt-6-luna";
      const drifted = chatBody(model, PING_PROMPT);
      drifted.messages[1] = { role: "user", content: "rewritten by another plugin" };
      const pings: Array<Record<string, any>> = [];
      mock.generate.mockImplementation(async (input: any) => {
        const ping = await roundTrip(mock, {
          ...chatTurn(model, { sse: [READ_CHAT] }),
          sessionID: input.sessionID,
          kind: "generate",
          body: drifted,
        });
        pings.push((await parsedBodyOf(ping.requestEvt.request)) as Record<string, any>);
        return {};
      });

      const first = await roundTrip(mock, chatTurn(model));
      await flush();
      const primary = (await parsedBodyOf(first.requestEvt.request)) as Record<string, any>;
      expect(primary.prompt_cache_options).toBeUndefined();
      const breakpoints = primary.messages.flatMap((message: any) =>
        Array.isArray(message.content) ? message.content.filter((part: any) => part.prompt_cache_breakpoint) : [],
      );
      expect(breakpoints).toEqual([
        { type: "text", text: "again", prompt_cache_breakpoint: { mode: "explicit", ttl: "12h" } },
      ]);
      expect(first.requestEvt.request.headers.get("anthropic-beta")).toBeNull();
      expect(lastSnapshot(mock)).toMatchObject({
        ttl: "12h",
        ttlSource: "requested",
        contextTokens: 60_000,
        skipReason: null,
        nextPingAt: T0 + TEN_HOURS,
      });

      jest.advanceTimersByTime(TEN_HOURS - 1);
      await flush();
      expect(mock.generate).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);
      await flush();

      expect(mock.generate).toHaveBeenCalledTimes(1);
      expect(pings[0]?.messages.slice(0, 3)).toEqual(primary.messages.slice(0, 3));
      expect(pings[0]?.messages[3]).toEqual({ role: "user", content: PING_PROMPT });
      expect(pings[0]?.prompt_cache_options).toBeUndefined();
      expect(pings[0]).toEqual(chatBody(model, PING_PROMPT));
      expect(lastSnapshot(mock)).toMatchObject({ lastPing: "hit", pingsUsed: 1 });
    });

    test("a DeepSeek session is observed but never pings", async () => {
      const mock = await start({ defaultMode: "1h" });
      const model = "deepseek/deepseek-v4.1-flash";
      const turn = chatTurn(model, { sse: [{ ...openaiUsage.deepseekRead, prompt_tokens: 60_000 }, { model, provider: "DeepSeek" }] });
      const raw = JSON.stringify(turn.body);
      const { requestEvt } = await roundTrip(mock, turn);
      await flush();

      expect(await requestEvt.request.text()).toBe(raw);
      expect(lastSnapshot(mock)).toMatchObject({
        skipReason: "implicit",
        nextPingAt: null,
        lastCache: { read: 10_112, total: 60_000 },
      });
      jest.advanceTimersByTime(FIFTY_MIN);
      await flush();
      expect(mock.generate).not.toHaveBeenCalled();
    });

    test("an alias is unmanaged on turn 1 and injected on turn 2 once learned", async () => {
      const mock = await start({ defaultMode: "1h" });
      const alias = "auto/opus-5";
      const learnedResponse: Parameters<typeof openaiSse> = [WRITE_CHAT, { model: "claude-opus-5-5", provider: "Anthropic" }];

      const first = await roundTrip(mock, chatTurn(alias, { sse: learnedResponse }));
      await flush();
      expect(collectCacheControls(await parsedBodyOf(first.requestEvt.request))).toHaveLength(0);
      expect(lastSnapshot(mock)).toMatchObject({ skipReason: "implicit" });
      expect(mock.store.get("learned-models")).toEqual({ "omniroute/auto/opus-5": "anthropic" });

      const second = await roundTrip(mock, chatTurn(alias, { sse: learnedResponse }));
      await flush();
      expect(collectCacheControls(await parsedBodyOf(second.requestEvt.request)).length).toBeGreaterThan(0);
      expect(lastSnapshot(mock)).toMatchObject({ ttl: "1h", skipReason: null });
    });

    test("a learned profile survives a restart", async () => {
      const before = await start({ defaultMode: "1h" });
      const learned: Parameters<typeof openaiSse> = [WRITE_CHAT, { model: "claude-opus-5-5", provider: "Anthropic" }];
      await roundTrip(before, chatTurn("auto/opus-5", { sse: learned }));
      await flush();

      const after = createMockCtx({ defaultMode: "1h" });
      before.store.forEach((value, key) => after.store.set(key, value));
      after.cleanup = await (plugin as any).setup(after.ctx);
      open.push(after);

      const { requestEvt } = await roundTrip(after, chatTurn("auto/opus-5"));
      expect(collectCacheControls(await parsedBodyOf(requestEvt.request)).length).toBeGreaterThan(0);
    });

    test("openaiCompatible: false leaves chat completions alone", async () => {
      const mock = await start({ openaiCompatible: false });
      const turn = chatTurn("claude-opus-5-5");
      const raw = JSON.stringify(turn.body);
      const { requestEvt } = await roundTrip(mock, turn);
      await flush();
      expect(await requestEvt.request.text()).toBe(raw);
      expect(snapshots(mock)).toHaveLength(0);
      expect(mock.store.has("learned-models")).toBe(false);
    });
  });

  test("an Anthropic-shaped URL on an unknown provider is still observed", async () => {
    const mock = await start();
    await roundTrip(mock, { providerID: "some-proxy", url: "https://proxy.example/anthropic/v1/messages" });
    await flush();
    expect(lastSnapshot(mock)).toMatchObject({ ttl: "1h" });
  });

  describe("anthropic-messages under a non-Anthropic provider ID", () => {
    const PROXY_URL = "https://proxy.example/v1/messages";
    const messagesSse = (model: string, usage: unknown) =>
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { model, usage } })}\n\n` +
      `event: message_stop\ndata: {"type":"message_stop"}\n\n`;
    const proxyTurn = (modelID: string, usage: unknown, resolvedModel = modelID, turn: Turn = {}): Turn => ({
      providerID: "some-proxy",
      modelID,
      url: PROXY_URL,
      contentType: "text/event-stream",
      body: { ...sampleBody(), model: modelID },
      responseText: messagesSse(resolvedModel, usage),
      ...turn,
    });

    test("a DeepSeek session is observed but never pings", async () => {
      const mock = await start({ keepalive: { minContextTokens: 0 } });
      const turn = proxyTurn("deepseek/deepseek-v4.1-flash", READ_HIT);
      const raw = JSON.stringify(turn.body);
      const { requestEvt } = await roundTrip(mock, turn);
      await flush();

      expect(await requestEvt.request.text()).toBe(raw);
      expect(lastSnapshot(mock)).toMatchObject({
        skipReason: "implicit",
        nextPingAt: null,
        lastCache: { read: 60_000, total: 60_010 },
      });
      jest.advanceTimersByTime(FIVE_MIN);
      await flush();
      jest.advanceTimersByTime(FIFTY_MIN);
      await flush();
      expect(mock.generate).not.toHaveBeenCalled();
    });

    test("an alias is untouched on turn 1, then rewritten and kept warm once its response names Claude", async () => {
      const mock = await start({ defaultMode: "1h", keepalive: { minContextTokens: 0 } });
      const alias = "auto/fast";
      const diverging = { role: "user", content: [{ type: "text", text: "rewritten 0" }] };
      const pings: Array<Record<string, any>> = [];
      mock.generate.mockImplementation(async (input: any) => {
        const body = { ...sampleBody(), model: alias } as Record<string, any>;
        body.messages = [diverging, { role: "user", content: [{ type: "text", text: PING_PROMPT }] }];
        const ping = await roundTrip(
          mock,
          proxyTurn(alias, READ_HIT, "claude-haiku-5-5", { sessionID: input.sessionID, kind: "generate", body }),
        );
        pings.push((await parsedBodyOf(ping.requestEvt.request)) as Record<string, any>);
        return {};
      });

      const turn = proxyTurn(alias, WRITE_1H, "claude-haiku-5-5");
      const raw = JSON.stringify(turn.body);
      const first = await roundTrip(mock, turn);
      await flush();
      expect(await first.requestEvt.request.text()).toBe(raw);
      expect(lastSnapshot(mock)).toMatchObject({ skipReason: "implicit", nextPingAt: null });
      expect(mock.store.get("learned-models")).toEqual({ "some-proxy/auto/fast": "anthropic" });

      const second = await roundTrip(mock, proxyTurn(alias, WRITE_1H, "claude-haiku-5-5"));
      await flush();
      const primary = (await parsedBodyOf(second.requestEvt.request)) as Record<string, any>;
      const controls = collectCacheControls(primary);
      expect(controls.length).toBeGreaterThan(0);
      expect(controls.every((control) => control.ttl === "1h")).toBe(true);
      expect(second.requestEvt.request.headers.get("anthropic-beta")).toBe(EXTENDED_CACHE_BETA);
      expect(lastSnapshot(mock)).toMatchObject({
        ttl: "1h",
        ttlSource: "detected",
        skipReason: null,
        nextPingAt: T0 + FIFTY_MIN,
      });

      jest.advanceTimersByTime(FIFTY_MIN);
      await flush();

      expect(mock.generate).toHaveBeenCalledTimes(1);
      expect(pings[0]?.messages[0]).toEqual(primary.messages[0]);
      expect(pings[0]?.messages[0]).not.toEqual(diverging);
      expect(JSON.stringify(pings[0]?.messages[1])).toContain(PING_PROMPT);
      expect(lastSnapshot(mock)).toMatchObject({ lastPing: "hit", pingsUsed: 1 });
    });
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

});
