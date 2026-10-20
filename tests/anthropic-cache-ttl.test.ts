import { afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import plugin from "../server.ts";
import { PING_PROMPT } from "../keepalive.ts";
import {
  EXTENDED_CACHE_BETA,
  SENTINEL_HEADER,
  alignPingMessages,
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

describe("alignPingMessages", () => {
  test("replaces the ping history with the primary prefix and keeps the ping tail", () => {
    const ping = [{ id: "p0" }, { id: "p1" }, { id: "ping" }];
    const primary = [{ id: "a0" }, { id: "a1" }, { id: "a2" }];
    expect(alignPingMessages(ping, primary)).toEqual([{ id: "a0" }, { id: "a1" }, { id: "ping" }]);
  });

  test("a shorter primary leaves the extra ping entries untouched", () => {
    const ping = [{ id: "p0" }, { id: "p1" }, { id: "p2" }, { id: "ping" }];
    const primary = [{ id: "a0" }];
    expect(alignPingMessages(ping, primary)).toEqual([{ id: "a0" }, { id: "p1" }, { id: "p2" }, { id: "ping" }]);
  });

  test("an empty primary returns the ping unchanged", () => {
    const ping = [{ id: "p0" }, { id: "ping" }];
    expect(alignPingMessages(ping, [])).toEqual(ping);
  });

  test("returns a new array and does not mutate its inputs", () => {
    const ping = [{ id: "p0" }, { id: "ping" }];
    const primary = [{ id: "a0" }];
    const out = alignPingMessages(ping, primary);
    expect(out).not.toBe(ping);
    expect(ping).toEqual([{ id: "p0" }, { id: "ping" }]);
    expect(primary).toEqual([{ id: "a0" }]);
  });

  test("messages copied from the primary keep their cache_control byte-identical", () => {
    const primary = [
      { role: "user", content: [{ type: "text", text: "a", cache_control: { type: "ephemeral", ttl: "1h" } }] },
      { role: "assistant", cache_control: { type: "ephemeral" }, content: "b" },
    ];
    const ping = [{ role: "user", content: "x" }, { role: "assistant", content: "y" }, { role: "user", content: "ping" }];
    const out = alignPingMessages(ping, primary);
    expect(JSON.stringify(out.slice(0, 2))).toBe(JSON.stringify(primary));
    expect(out[0]).toBe(primary[0]);
  });

  test("the tail and extra entries carry no cache_control at message or part level", () => {
    const marked = (text: string) => ({
      role: "user",
      cache_control: { type: "ephemeral" },
      content: [
        { type: "text", text, cache_control: { type: "ephemeral", ttl: "1h" } },
        { type: "text", text: "plain" },
      ],
    });
    const primary = [marked("a0")];
    const ping = [marked("p0"), marked("p1"), marked("p2"), marked("ping")];
    const out = alignPingMessages(ping, primary) as any[];

    expect(out[0]).toBe(primary[0]);
    for (const message of out.slice(1)) {
      expect("cache_control" in message).toBe(false);
      for (const part of message.content) expect("cache_control" in part).toBe(false);
    }
    expect(out.map((m) => m.content[0].text)).toEqual(["a0", "p1", "p2", "ping"]);
    expect(out[3].content[1]).toEqual({ type: "text", text: "plain" });
    // inputs untouched
    expect(ping[3].cache_control).toEqual({ type: "ephemeral" });
    expect(ping[3].content[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  test("an empty primary still strips cache_control from the ping", () => {
    const out = alignPingMessages([{ role: "user", content: "x", cache_control: { type: "ephemeral" } }], []);
    expect(out).toEqual([{ role: "user", content: "x" }]);
  });

  test("an empty ping stays empty", () => {
    expect(alignPingMessages([], [{ id: "a0" }])).toEqual([]);
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

  test("RPC getKeepalive returns the current snapshot", async () => {
    const mock = await start();
    await roundTrip(mock);
    await flush();

    expect(await mock.rpc().getKeepalive({ sessionID: "ses_a" })).toEqual(lastSnapshot(mock));
    expect(await mock.rpc().getKeepalive({ sessionID: "ses_unknown" })).toMatchObject({
      sessionID: "ses_unknown",
      ttl: null,
      nextPingAt: null,
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

type TuiMockOptions = {
  route?: { type: "home" } | { type: "session"; sessionID: string };
  global?: Record<string, unknown>;
  session?: Record<string, unknown> | null;
  selects?: unknown[];
  prompts?: unknown[];
  setSessionImpl?: (input: any) => Promise<unknown>;
};

type TuiMock = {
  ctx: any;
  toasts: any[];
  dialogCalls: any[];
  promptCalls: any[];
  setSessionCalls: any[];
  setGlobalCalls: any[];
  resetCalls: any[];
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
        events: {
          // eslint-disable-next-line require-yield
          subscribe: async function* () {},
        },
      }),
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
    layer: () => layer,
    run: (input?: string) => layer.commands[0].run(input),
  };
}

async function setupTui(options: TuiMockOptions = {}): Promise<TuiMock> {
  const mock = createTuiCtx(options);
  await (tuiPlugin as any).setup(mock.ctx);
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
});
