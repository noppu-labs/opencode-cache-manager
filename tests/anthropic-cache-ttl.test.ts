import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import plugin from "../server.ts";
import {
  EXTENDED_CACHE_BETA,
  SENTINEL_HEADER,
  hasOneHourCacheControl,
  isCacheTtlMode,
  mergeBetaHeader,
  parseCommandArg,
  resolveActiveMode,
  rewriteAnthropicCacheTtl,
  transformHttpRequest,
  ttlForMode,
} from "../shared.ts";

// `@opencode/plugin/tui` re-exports from `solid.js`, which imports the optional
// `solid-js` peer that is only present in the live TUI host. `define` is an
// identity helper, so stub it here (before importing the TUI entrypoint) to keep
// the test harness dependency-free.
mock.module("@opencode/plugin/tui", () => ({
  Plugin: { define: (plugin: unknown) => plugin },
}));
const { default: tuiPlugin } = await import("../tui.ts");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function ephemeral(extra: Record<string, unknown> = {}) {
  return { type: "ephemeral", ...extra };
}

/** A representative Anthropic payload with breakpoints on tools, system and messages. */
function sampleBody() {
  return {
    model: "claude-sonnet-5-5",
    tools: [
      { name: "tool_a", cache_control: ephemeral() },
      { name: "tool_b" },
      {
        name: "namespace",
        tools: [
          { name: "nested_a", cache_control: ephemeral() },
          { name: "nested_b" },
        ],
      },
    ],
    system: [
      { type: "text", text: "You are helpful.", cache_control: ephemeral() },
      { type: "text", text: "Extra system text." },
    ],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "hello", cache_control: ephemeral() },
          { type: "text", text: "world" },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
      {
        role: "user",
        cache_control: ephemeral(),
        content: [{ type: "text", text: "tail" }],
      },
    ],
  } as Record<string, unknown>;
}

/** Collects every cache_control object found anywhere in a payload. */
function collectCacheControls(node: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const item of node) collectCacheControls(item, out);
    return out;
  }
  const rec = node as Record<string, unknown>;
  const cc = rec.cache_control;
  if (cc && typeof cc === "object") out.push(cc as Record<string, unknown>);
  for (const value of Object.values(rec)) collectCacheControls(value, out);
  return out;
}

function makeRequest(
  body: string | undefined,
  headers: Record<string, string> = {},
  options: { method?: string } = {},
) {
  return new Request("https://api.anthropic.com/v1/messages", {
    method: options.method ?? "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

function parsedBodyOf(request: Request) {
  return request.clone().json() as Promise<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// isCacheTtlMode
// ---------------------------------------------------------------------------

describe("isCacheTtlMode", () => {
  test("accepts the three valid modes", () => {
    expect(isCacheTtlMode("5m")).toBe(true);
    expect(isCacheTtlMode("1h")).toBe(true);
    expect(isCacheTtlMode("hybrid")).toBe(true);
  });

  test("rejects anything else", () => {
    expect(isCacheTtlMode("")).toBe(false);
    expect(isCacheTtlMode("5M")).toBe(false);
    expect(isCacheTtlMode("status")).toBe(false);
    expect(isCacheTtlMode(undefined)).toBe(false);
    expect(isCacheTtlMode(null)).toBe(false);
    expect(isCacheTtlMode(5)).toBe(false);
    expect(isCacheTtlMode({ text: "1h" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseCommandArg
// ---------------------------------------------------------------------------

describe("parseCommandArg", () => {
  test("parses mode arguments case-insensitively", () => {
    expect(parseCommandArg("5m")).toEqual({ type: "set", patch: { mode: "5m" } });
    expect(parseCommandArg("1h")).toEqual({ type: "set", patch: { mode: "1h" } });
    expect(parseCommandArg("hybrid")).toEqual({ type: "set", patch: { mode: "hybrid" } });
    expect(parseCommandArg("HyBrId")).toEqual({ type: "set", patch: { mode: "hybrid" } });
    expect(parseCommandArg("  1H  ")).toEqual({ type: "set", patch: { mode: "1h" } });
    expect(parseCommandArg("5M")).toEqual({ type: "set", patch: { mode: "5m" } });
  });

  test("parses status, reset and toggle", () => {
    expect(parseCommandArg("status")).toEqual({ type: "status" });
    expect(parseCommandArg(" STATUS ")).toEqual({ type: "status" });
    expect(parseCommandArg("reset")).toEqual({ type: "reset" });
    expect(parseCommandArg("Reset")).toEqual({ type: "reset" });
    expect(parseCommandArg("toggle")).toEqual({ type: "toggle" });
    expect(parseCommandArg("TOGGLE")).toEqual({ type: "toggle" });
  });

  test("empty input means toggle", () => {
    expect(parseCommandArg("")).toEqual({ type: "toggle" });
    expect(parseCommandArg("   ")).toEqual({ type: "toggle" });
  });

  test("parses keepalive on and off", () => {
    expect(parseCommandArg("keepalive on")).toEqual({ type: "set", patch: { keepalive: true } });
    expect(parseCommandArg("KEEPALIVE OFF")).toEqual({ type: "set", patch: { keepalive: false } });
    expect(parseCommandArg("keepalive   off")).toEqual({ type: "set", patch: { keepalive: false } });
    expect(parseCommandArg("keepalive maybe")).toEqual({ type: "invalid" });
    expect(parseCommandArg("keepalive")).toEqual({ type: "invalid" });
  });

  test("parses pings within 0..100", () => {
    expect(parseCommandArg("pings 3")).toEqual({ type: "set", patch: { maxPings: 3 } });
    expect(parseCommandArg("pings 0")).toEqual({ type: "set", patch: { maxPings: 0 } });
    expect(parseCommandArg("pings 100")).toEqual({ type: "set", patch: { maxPings: 100 } });
    expect(parseCommandArg("pings 101")).toEqual({ type: "invalid" });
    expect(parseCommandArg("pings -1")).toEqual({ type: "invalid" });
    expect(parseCommandArg("pings 2.5")).toEqual({ type: "invalid" });
    expect(parseCommandArg("pings many")).toEqual({ type: "invalid" });
    expect(parseCommandArg("pings")).toEqual({ type: "invalid" });
  });

  test("parses min as an integer or a k-suffixed integer", () => {
    expect(parseCommandArg("min 20000")).toEqual({ type: "set", patch: { minContextTokens: 20000 } });
    expect(parseCommandArg("min 50k")).toEqual({ type: "set", patch: { minContextTokens: 50000 } });
    expect(parseCommandArg("MIN 50K")).toEqual({ type: "set", patch: { minContextTokens: 50000 } });
    expect(parseCommandArg("min 0")).toEqual({ type: "set", patch: { minContextTokens: 0 } });
    expect(parseCommandArg("min -5")).toEqual({ type: "invalid" });
    expect(parseCommandArg("min 1.5k")).toEqual({ type: "invalid" });
    expect(parseCommandArg("min k")).toEqual({ type: "invalid" });
    expect(parseCommandArg("min")).toEqual({ type: "invalid" });
  });

  test("unknown input is invalid", () => {
    expect(parseCommandArg("banana")).toEqual({ type: "invalid" });
    expect(parseCommandArg("5")).toEqual({ type: "invalid" });
    expect(parseCommandArg("1hour")).toEqual({ type: "invalid" });
    expect(parseCommandArg("1h extra")).toEqual({ type: "invalid" });
  });

  test("parses the PromptInput.Prompt object shape", () => {
    expect(parseCommandArg({ text: "1h" })).toEqual({ type: "set", patch: { mode: "1h" } });
    expect(parseCommandArg({ text: "  status " })).toEqual({ type: "status" });
    expect(parseCommandArg({ text: "" })).toEqual({ type: "toggle" });
    expect(parseCommandArg({ text: "nonsense" })).toEqual({ type: "invalid" });
    expect(parseCommandArg({ text: "pings 4", files: [] })).toEqual({
      type: "set",
      patch: { maxPings: 4 },
    });
  });

  test("parses arrays of { text } parts joined by spaces", () => {
    expect(parseCommandArg([{ text: "1h" }])).toEqual({ type: "set", patch: { mode: "1h" } });
    expect(parseCommandArg([{ text: "keepalive" }, { text: "off" }])).toEqual({
      type: "set",
      patch: { keepalive: false },
    });
    expect(parseCommandArg([])).toEqual({ type: "toggle" });
    expect(parseCommandArg([{ text: "nope" }])).toEqual({ type: "invalid" });
  });

  test("handles unexpected shapes without throwing", () => {
    expect(parseCommandArg(undefined)).toEqual({ type: "toggle" });
    expect(parseCommandArg(null)).toEqual({ type: "toggle" });
    expect(parseCommandArg(42)).toEqual({ type: "toggle" });
    expect(parseCommandArg({ foo: "bar" })).toEqual({ type: "toggle" });
  });
});

// ---------------------------------------------------------------------------
// ttlForMode / resolveActiveMode
// ---------------------------------------------------------------------------

describe("ttlForMode", () => {
  test("hybrid pings at 5m, matching its message breakpoints", () => {
    expect(ttlForMode("5m")).toBe("5m");
    expect(ttlForMode("1h")).toBe("1h");
    expect(ttlForMode("hybrid")).toBe("5m");
  });
});

describe("resolveActiveMode", () => {
  test("honours a valid x-cache-ttl header", () => {
    const request = makeRequest("{}", { [SENTINEL_HEADER]: " 1H " });
    expect(resolveActiveMode(request, "5m")).toBe("1h");
  });

  test("ignores an invalid header", () => {
    const request = makeRequest("{}", { [SENTINEL_HEADER]: "bogus" });
    expect(resolveActiveMode(request, "hybrid")).toBe("hybrid");
  });

  test("uses the fallback when the header is absent", () => {
    expect(resolveActiveMode(makeRequest("{}"), "1h")).toBe("1h");
  });
});

// ---------------------------------------------------------------------------
// mergeBetaHeader
// ---------------------------------------------------------------------------

describe("mergeBetaHeader", () => {
  test("returns null when nothing to include", () => {
    expect(mergeBetaHeader(null, false)).toBeNull();
    expect(mergeBetaHeader("", false)).toBeNull();
    expect(mergeBetaHeader("   ", false)).toBeNull();
  });

  test("adds the extended cache beta to an empty header", () => {
    expect(mergeBetaHeader(null, true)).toBe(EXTENDED_CACHE_BETA);
    expect(mergeBetaHeader("", true)).toBe(EXTENDED_CACHE_BETA);
  });

  test("appends the extended cache beta after existing tokens", () => {
    expect(mergeBetaHeader("interleaved-thinking-2025-05-14", true)).toBe(
      "interleaved-thinking-2025-05-14,extended-cache-ttl-2025-04-11",
    );
  });

  test("does not duplicate an existing extended cache beta", () => {
    expect(mergeBetaHeader(`interleaved-thinking-2025-05-14,${EXTENDED_CACHE_BETA}`, true)).toBe(
      "interleaved-thinking-2025-05-14,extended-cache-ttl-2025-04-11",
    );
    expect(mergeBetaHeader(EXTENDED_CACHE_BETA, true)).toBe(EXTENDED_CACHE_BETA);
  });

  test("normalizes whitespace around existing tokens", () => {
    expect(mergeBetaHeader("  interleaved-thinking-2025-05-14 ,  ", true)).toBe(
      "interleaved-thinking-2025-05-14,extended-cache-ttl-2025-04-11",
    );
  });

  test("leaves existing tokens untouched when not including", () => {
    expect(mergeBetaHeader("interleaved-thinking-2025-05-14", false)).toBe(
      "interleaved-thinking-2025-05-14",
    );
    expect(mergeBetaHeader(`a,${EXTENDED_CACHE_BETA}`, false)).toBe(
      `a,${EXTENDED_CACHE_BETA}`,
    );
  });
});

// ---------------------------------------------------------------------------
// rewriteAnthropicCacheTtl
// ---------------------------------------------------------------------------

describe("rewriteAnthropicCacheTtl", () => {
  test("1h mode sets ttl on every ephemeral block across tools, system and messages", () => {
    const body = sampleBody();
    const changed = rewriteAnthropicCacheTtl(body, "1h");
    expect(changed).toBe(true);

    const ccs = collectCacheControls(body);
    expect(ccs.length).toBe(5);
    for (const cc of ccs) {
      expect(cc.type).toBe("ephemeral");
      expect(cc.ttl).toBe("1h");
    }
    expect(hasOneHourCacheControl(body)).toBe(true);
  });

  test("1h mode recurses into namespace tools", () => {
    const body = sampleBody();
    rewriteAnthropicCacheTtl(body, "1h");
    const namespace = (body.tools as Record<string, unknown>[])[2] as {
      tools: { name: string; cache_control?: Record<string, unknown> }[];
    };
    expect(namespace.tools[0].cache_control?.ttl).toBe("1h");
    expect(namespace.tools[1].cache_control).toBeUndefined();
  });

  test("5m mode removes any ttl property", () => {
    const body = sampleBody();
    // Seed every ephemeral block with an existing 1h ttl to prove deletion.
    for (const cc of collectCacheControls(body)) cc.ttl = "1h";
    const changed = rewriteAnthropicCacheTtl(body, "5m");
    expect(changed).toBe(true);
    for (const cc of collectCacheControls(body)) {
      expect("ttl" in cc).toBe(false);
    }
    expect(hasOneHourCacheControl(body)).toBe(false);
  });

  test("5m mode leaves a clean body unchanged", () => {
    const body = sampleBody();
    const changed = rewriteAnthropicCacheTtl(body, "5m");
    expect(changed).toBe(false);
    for (const cc of collectCacheControls(body)) {
      expect("ttl" in cc).toBe(false);
    }
  });

  test("hybrid mode uses 1h for tools and system but 5m for messages", () => {
    const body = sampleBody();
    const changed = rewriteAnthropicCacheTtl(body, "hybrid");
    expect(changed).toBe(true);

    const tools = body.tools as Record<string, unknown>[];
    // tool_a and the namespace's nested_a flipped to 1h.
    expect((tools[0].cache_control as Record<string, unknown>).ttl).toBe("1h");
    const namespace = tools[2] as { tools: { cache_control?: Record<string, unknown> }[] };
    expect(namespace.tools[0].cache_control?.ttl).toBe("1h");

    const system = body.system as Record<string, unknown>[];
    expect((system[0].cache_control as Record<string, unknown>).ttl).toBe("1h");

    // Every message-level breakpoint stays at the 5m default (no ttl property).
    const messages = body.messages as Record<string, unknown>[];
    for (const message of messages) {
      const cc = message.cache_control as Record<string, unknown> | undefined;
      if (cc) expect("ttl" in cc).toBe(false);
      if (Array.isArray(message.content)) {
        for (const part of message.content as Record<string, unknown>[]) {
          const partCc = part.cache_control as Record<string, unknown> | undefined;
          if (partCc) expect("ttl" in partCc).toBe(false);
        }
      }
    }
    expect(hasOneHourCacheControl(body)).toBe(true);
  });

  test("hybrid keeps 1h prefixes ahead of 5m messages (ordering invariant)", () => {
    const body = sampleBody();
    rewriteAnthropicCacheTtl(body, "hybrid");
    // Walk the payload in Anthropic's cache-prefix order and assert there is no
    // 1h breakpoint after a 5m breakpoint.
    const order: string[] = [];
    const visit = (block: unknown) => {
      if (!block || typeof block !== "object") return;
      const cc = (block as Record<string, unknown>).cache_control as Record<string, unknown> | undefined;
      if (cc && cc.type === "ephemeral") order.push(cc.ttl === "1h" ? "1h" : "5m");
    };
    for (const tool of body.tools as unknown[]) {
      visit(tool);
      const nested = (tool as Record<string, unknown>).tools;
      if (Array.isArray(nested)) nested.forEach(visit);
    }
    for (const block of body.system as unknown[]) visit(block);
    for (const message of body.messages as Record<string, unknown>[]) {
      visit(message);
      if (Array.isArray(message.content)) (message.content as unknown[]).forEach(visit);
    }
    const firstFiveMin = order.indexOf("5m");
    if (firstFiveMin !== -1) {
      expect(order.slice(firstFiveMin)).not.toContain("1h");
    }
  });

  test("ignores non-ephemeral and malformed cache_control", () => {
    const body = {
      tools: [
        { cache_control: { type: "persistent" } },
        { cache_control: "not-an-object" },
        { cache_control: null },
        {},
      ],
      system: "not-an-array",
      messages: [{ content: "not-an-array" }],
    } as Record<string, unknown>;
    expect(rewriteAnthropicCacheTtl(body, "1h")).toBe(false);
  });

  test("empty body is a no-op", () => {
    const body = {} as Record<string, unknown>;
    expect(rewriteAnthropicCacheTtl(body, "1h")).toBe(false);
    expect(hasOneHourCacheControl(body)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// transformHttpRequest
// ---------------------------------------------------------------------------

describe("transformHttpRequest", () => {
  test("1h fallback rewrites body and appends the extended beta header", async () => {
    const request = makeRequest(JSON.stringify(sampleBody()), {
      "anthropic-beta": "interleaved-thinking-2025-05-14",
    });
    const out = await transformHttpRequest(request, "1h");

    expect(out.headers.get("anthropic-beta")).toBe(
      "interleaved-thinking-2025-05-14,extended-cache-ttl-2025-04-11",
    );
    const body = (await parsedBodyOf(out)) as Record<string, unknown>;
    for (const cc of collectCacheControls(body)) expect(cc.ttl).toBe("1h");
  });

  test("hybrid fallback rewrites body and appends the extended beta header", async () => {
    const out = await transformHttpRequest(makeRequest(JSON.stringify(sampleBody())), "hybrid");
    expect(out.headers.get("anthropic-beta")).toBe(EXTENDED_CACHE_BETA);
    const body = (await parsedBodyOf(out)) as { messages: Record<string, unknown>[] };
    const tail = body.messages[2].cache_control as Record<string, unknown>;
    expect("ttl" in tail).toBe(false);
  });

  test("5m fallback does not add the extended beta header", async () => {
    const out = await transformHttpRequest(makeRequest(JSON.stringify(sampleBody())), "5m");
    expect(out.headers.get("anthropic-beta")).toBeNull();
    const body = (await parsedBodyOf(out)) as Record<string, unknown>;
    for (const cc of collectCacheControls(body)) expect("ttl" in cc).toBe(false);
  });

  test("x-cache-ttl: 1h overrides a 5m fallback and is stripped", async () => {
    const out = await transformHttpRequest(
      makeRequest(JSON.stringify(sampleBody()), { [SENTINEL_HEADER]: "1h" }),
      "5m",
    );
    expect(out.headers.has(SENTINEL_HEADER)).toBe(false);
    expect(out.headers.get("anthropic-beta")).toBe(EXTENDED_CACHE_BETA);
    const body = (await parsedBodyOf(out)) as Record<string, unknown>;
    for (const cc of collectCacheControls(body)) expect(cc.ttl).toBe("1h");
  });

  test("x-cache-ttl: 5m overrides a 1h fallback and is stripped", async () => {
    const out = await transformHttpRequest(
      makeRequest(JSON.stringify(sampleBody()), { [SENTINEL_HEADER]: "5m" }),
      "1h",
    );
    expect(out.headers.has(SENTINEL_HEADER)).toBe(false);
    expect(out.headers.get("anthropic-beta")).toBeNull();
    const body = (await parsedBodyOf(out)) as Record<string, unknown>;
    for (const cc of collectCacheControls(body)) expect("ttl" in cc).toBe(false);
  });

  test("an invalid sentinel value falls back to the fallback mode", async () => {
    const out = await transformHttpRequest(
      makeRequest(JSON.stringify(sampleBody()), { [SENTINEL_HEADER]: "bogus" }),
      "1h",
    );
    expect(out.headers.has(SENTINEL_HEADER)).toBe(false);
    const body = (await parsedBodyOf(out)) as Record<string, unknown>;
    for (const cc of collectCacheControls(body)) expect(cc.ttl).toBe("1h");
  });

  test("5m mode with no body and no sentinel returns the same request", async () => {
    const request = new Request("https://api.anthropic.com/v1/models", { method: "GET" });
    const out = await transformHttpRequest(request, "5m");
    expect(out).toBe(request);
  });

  test("strips the sentinel from a bodyless request", async () => {
    const request = new Request("https://api.anthropic.com/v1/models", {
      method: "GET",
      headers: { [SENTINEL_HEADER]: "1h" },
    });
    const out = await transformHttpRequest(request, "1h");
    expect(out).not.toBe(request);
    expect(out.headers.has(SENTINEL_HEADER)).toBe(false);
  });

  test("handles non-JSON bodies gracefully without throwing", async () => {
    const request = makeRequest("this is definitely not json", { [SENTINEL_HEADER]: "1h" });
    const out = await transformHttpRequest(request, "1h");
    expect(out.headers.has(SENTINEL_HEADER)).toBe(false);
    expect(await out.text()).toBe("this is definitely not json");
  });

  test("non-JSON body without a sentinel is returned untouched", async () => {
    const request = makeRequest("plain text", {}, { method: "POST" });
    const out = await transformHttpRequest(request, "5m");
    expect(out).toBe(request);
  });

  test("handles an empty JSON object body", async () => {
    const out = await transformHttpRequest(makeRequest("{}"), "1h");
    expect(out.headers.get("anthropic-beta")).toBe(EXTENDED_CACHE_BETA);
    expect(await out.text()).toBe("{}");
  });

  test("handles a JSON array body without throwing", async () => {
    const out = await transformHttpRequest(makeRequest("[1,2,3]", { [SENTINEL_HEADER]: "1h" }), "5m");
    expect(out.headers.has(SENTINEL_HEADER)).toBe(false);
    expect(await out.text()).toBe("[1,2,3]");
  });
});

// ---------------------------------------------------------------------------
// Plugin.setup(ctx) integration
// ---------------------------------------------------------------------------

type MockCtx = {
  ctx: any;
  store: Map<string, unknown>;
  synthetic: Array<{ sessionID: string; text: string; resume?: boolean | null }>;
  command: () => any;
  hook: () => any;
  rpc: () => any;
  emits: Array<{ name: string; data: unknown }>;
};

function createMockCtx(options: Record<string, unknown> = {}): MockCtx {
  const store = new Map<string, unknown>();
  const synthetic: MockCtx["synthetic"] = [];
  let commandDef: any;
  let httpHook: any;
  let rpcHandlers: any;
  const emits: MockCtx["emits"] = [];

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
    },
    session: {
      synthetic: async (input: MockCtx["synthetic"][number]) => {
        synthetic.push(input);
      },
      hook: async (name: string, cb: any) => {
        if (name === "http.request") httpHook = cb;
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
    rpc: () => rpcHandlers,
    emits,
  };
}

async function setup(overrides: Record<string, unknown> = {}) {
  const mock = createMockCtx(overrides);
  await (plugin as any).setup(mock.ctx);
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
// opencode.jsonc -1h model variants
// ---------------------------------------------------------------------------

describe("opencode.jsonc omniroute-anthropic -1h variants", () => {
  const CONFIG_PATH = fileURLToPath(new URL("../opencode.jsonc", import.meta.url));

  /** Strips single-line `//` comments (outside strings) and trailing commas from JSONC. */
  function stripJsonc(raw: string): string {
    let out = "";
    let inString = false;
    let escaped = false;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (inString) {
        out += ch;
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        out += ch;
        continue;
      }
      if (ch === "/" && raw[i + 1] === "/") {
        while (i < raw.length && raw[i] !== "\n") i++;
        out += "\n";
        continue;
      }
      out += ch;
    }
    return out.replace(/,(\s*[}\]])/g, "$1");
  }

  function parseConfig(): any {
    const raw = readFileSync(CONFIG_PATH, "utf8");
    const jsonc = (globalThis as any).Bun?.JSONC;
    return typeof jsonc?.parse === "function" ? jsonc.parse(raw) : JSON.parse(stripJsonc(raw));
  }

  const EXPECTED: Record<string, string[]> = {
    "auto/claude-haiku-5-5": ["none", "low", "medium", "high", "xhigh", "max"],
    "auto/claude-sonnet-5-5": ["none", "low", "medium", "high", "xhigh", "max"],
    "auto/claude-opus-5-5": ["none", "low", "medium", "high", "xhigh", "max"],
    "auto/claude-fable-5-1": ["low", "medium", "high", "xhigh", "max"],
  };

  function models(): Record<string, any> {
    return parseConfig().providers["omniroute-anthropic"].models;
  }

  test("declares base and -1h variants for all four models", () => {
    const all = models();
    for (const [modelID, baseIds] of Object.entries(EXPECTED)) {
      const variants = all[modelID]?.variants;
      expect(Array.isArray(variants)).toBe(true);
      const ids = (variants as any[]).map((v) => v.id);
      for (const base of baseIds) {
        expect(ids).toContain(base);
        expect(ids).toContain(`${base}-1h`);
      }
    }
  });

  test("-1h variants mirror base settings and carry the 1h sentinel header", () => {
    const all = models();
    for (const [modelID, baseIds] of Object.entries(EXPECTED)) {
      const variants = all[modelID].variants as any[];
      const byId = new Map<string, any>(variants.map((v) => [v.id, v]));
      for (const base of baseIds) {
        const baseVariant = byId.get(base);
        const ttlVariant = byId.get(`${base}-1h`);
        expect(baseVariant).toBeDefined();
        expect(ttlVariant).toBeDefined();
        expect(ttlVariant!.settings).toEqual(baseVariant!.settings);
        expect(ttlVariant!.headers).toEqual({ [SENTINEL_HEADER]: "1h" });
      }
    }
  });

  test("-1h variant headers drive transformHttpRequest to 1h", async () => {
    const all = models();
    for (const modelID of Object.keys(EXPECTED)) {
      for (const variant of all[modelID].variants as any[]) {
        if (!String(variant.id).endsWith("-1h")) continue;
        const request = makeRequest(JSON.stringify(sampleBody()), variant.headers);
        const out = await transformHttpRequest(request, "5m");
        expect(out.headers.has(SENTINEL_HEADER)).toBe(false);
        expect(out.headers.get("anthropic-beta")).toBe(EXTENDED_CACHE_BETA);
        const body = (await parsedBodyOf(out)) as Record<string, unknown>;
        const controls = collectCacheControls(body);
        expect(controls.length).toBeGreaterThan(0);
        for (const cc of controls) expect(cc.ttl).toBe("1h");
      }
    }
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

// ---------------------------------------------------------------------------
// TUI plugin (keymap layer + dialog modal + toasts)
// ---------------------------------------------------------------------------

type TuiMock = {
  ctx: any;
  toasts: any[];
  dialogCalls: any[];
  setSessionCalls: any[];
  layer: () => any;
  run: (input?: string) => Promise<void>;
};

function createTuiCtx(
  currentMode: string = "5m",
  dialogResult?: unknown,
  setSessionImpl?: (input: any) => Promise<unknown>,
): TuiMock {
  let layer: any;
  const toasts: any[] = [];
  const dialogCalls: any[] = [];
  const setSessionCalls: any[] = [];

  const ctx = {
    client: {
      rpc: () => ({
        getSettings: async () => ({
          global: { mode: currentMode, keepalive: true, maxPings: 5, minContextTokens: 50_000 },
          session: null,
        }),
        setSession: async (input: any) => {
          setSessionCalls.push(input);
          if (setSessionImpl) return setSessionImpl(input);
          return undefined;
        },
        events: {
          // eslint-disable-next-line require-yield
          subscribe: async function* () {},
        },
      }),
    },
    ui: {
      dialog: {
        select: async (options: any) => {
          dialogCalls.push(options);
          return dialogResult;
        },
      },
      toast: {
        show: (options: any) => {
          toasts.push(options);
        },
      },
      router: {
        current: () => ({ type: "session", sessionID: "ses_tui" }),
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
    setSessionCalls,
    layer: () => layer,
    run: (input?: string) => layer.commands[0].run(input),
  };
}

describe("cache-ttl TUI plugin", () => {
  test("no-arg run opens a dialog with the current mode and three options", async () => {
    const mock = createTuiCtx("5m", undefined);
    await (tuiPlugin as any).setup(mock.ctx);

    await mock.run("");

    expect(mock.dialogCalls).toHaveLength(1);
    const call = mock.dialogCalls[0];
    expect(call.current).toBe("5m");
    expect(call.options.map((option: any) => option.value)).toEqual(["5m", "1h", "hybrid"]);
    for (const option of call.options) {
      expect(typeof option.title).toBe("string");
      expect(option.title.length).toBeGreaterThan(0);
      expect(typeof option.description).toBe("string");
      expect(option.description.length).toBeGreaterThan(0);
    }
    expect(mock.setSessionCalls).toHaveLength(0);
    expect(mock.toasts).toHaveLength(0);
  });

  test("undefined arg also opens the dialog", async () => {
    const mock = createTuiCtx("1h", undefined);
    await (tuiPlugin as any).setup(mock.ctx);

    await mock.run(undefined);

    expect(mock.dialogCalls).toHaveLength(1);
    expect(mock.dialogCalls[0].current).toBe("1h");
  });

  test("dialog selection posts setSession and shows a success toast", async () => {
    const mock = createTuiCtx("5m", "1h");
    await (tuiPlugin as any).setup(mock.ctx);

    await mock.run("");

    expect(mock.setSessionCalls).toEqual([{ sessionID: "ses_tui", patch: { mode: "1h" } }]);
    expect(mock.toasts).toHaveLength(1);
    expect(mock.toasts[0].variant).toBe("success");
    expect(mock.toasts[0].message).toContain("1h");
  });

  test("dialog dismissal performs no RPC write and shows no toast", async () => {
    const mock = createTuiCtx("5m", undefined);
    await (tuiPlugin as any).setup(mock.ctx);

    await mock.run("");

    expect(mock.dialogCalls).toHaveLength(1);
    expect(mock.setSessionCalls).toHaveLength(0);
    expect(mock.toasts).toHaveLength(0);
  });

  test("selecting the current mode performs no RPC write and shows no toast", async () => {
    const mock = createTuiCtx("hybrid", "hybrid");
    await (tuiPlugin as any).setup(mock.ctx);

    await mock.run("");

    expect(mock.setSessionCalls).toHaveLength(0);
    expect(mock.toasts).toHaveLength(0);
  });

  test("status short-circuits to an info toast without a dialog", async () => {
    const mock = createTuiCtx("hybrid", undefined);
    await (tuiPlugin as any).setup(mock.ctx);

    await mock.run("status");

    expect(mock.dialogCalls).toHaveLength(0);
    expect(mock.setSessionCalls).toHaveLength(0);
    expect(mock.toasts).toHaveLength(1);
    expect(mock.toasts[0].variant).toBe("info");
    expect(mock.toasts[0].message).toContain("hybrid");
  });

  test("an explicit valid mode bypasses the dialog", async () => {
    const mock = createTuiCtx("hybrid", undefined);
    await (tuiPlugin as any).setup(mock.ctx);

    await mock.run("5m");

    expect(mock.dialogCalls).toHaveLength(0);
    expect(mock.setSessionCalls).toEqual([{ sessionID: "ses_tui", patch: { mode: "5m" } }]);
    expect(mock.toasts).toHaveLength(1);
    expect(mock.toasts[0].variant).toBe("success");
  });

  test("garbage input shows a warning with usage text", async () => {
    const mock = createTuiCtx("5m", undefined);
    await (tuiPlugin as any).setup(mock.ctx);

    await mock.run("garbage");

    expect(mock.dialogCalls).toHaveLength(0);
    expect(mock.setSessionCalls).toHaveLength(0);
    expect(mock.toasts).toHaveLength(1);
    expect(mock.toasts[0].variant).toBe("warning");
    expect(mock.toasts[0].message).toContain("5m");
    expect(mock.toasts[0].message).toContain("1h");
    expect(mock.toasts[0].message).toContain("hybrid");
    expect(mock.toasts[0].message).toContain("status");
  });

  test("outside a session it warns and performs no RPC write", async () => {
    const mock = createTuiCtx("5m", "1h");
    mock.ctx.ui.router.current = () => ({ type: "home" });
    await (tuiPlugin as any).setup(mock.ctx);

    await mock.run("");

    expect(mock.dialogCalls).toHaveLength(0);
    expect(mock.setSessionCalls).toHaveLength(0);
    expect(mock.toasts).toHaveLength(1);
    expect(mock.toasts[0].variant).toBe("warning");
  });

  test("an RPC failure surfaces as an error toast without throwing", async () => {
    const mock = createTuiCtx("5m", "1h", async () => {
      throw new Error("rpc down");
    });
    await (tuiPlugin as any).setup(mock.ctx);

    await expect(mock.run("")).resolves.toBeUndefined();

    expect(mock.setSessionCalls).toHaveLength(1);
    expect(mock.toasts).toHaveLength(1);
    expect(mock.toasts[0].variant).toBe("error");
    expect(mock.toasts[0].message).toContain("rpc down");
  });
});
