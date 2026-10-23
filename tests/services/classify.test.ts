import { describe, expect, spyOn, test } from "bun:test";
import {
  classifyRequest,
  classifyRequestWithBody,
  isAnthropicMessagesRequest,
  observedWireFor,
  requestWire,
  routeRequest,
  shouldInject,
  type Route,
  type RouteInput,
} from "../../src/services/classify.ts";
import { parseModelPatterns } from "../../src/config/model-patterns.ts";
import { StrategyStore } from "../../src/services/strategy-store.ts";
import { memoryKv } from "../helpers/memory-kv.ts";

const chat = (url = "https://omni.example/v1/chat/completions", method = "POST") => new Request(url, { method });
const noDeps = { patterns: [] };

describe("requestWire", () => {
  const post = (url: string, method = "POST") => new Request(url, { method, body: method === "POST" ? "{}" : undefined });

  test("names the wire from the method and path alone", () => {
    expect(requestWire(post("https://api.anthropic.com/v1/messages"))).toBe("anthropic-messages");
    expect(requestWire(post("https://omni.example/v1/chat/completions"))).toBe("openai-chat");
    expect(requestWire(post("https://omni.example/v1/embeddings"))).toBeUndefined();
    expect(requestWire(post("https://omni.example/v1/chat/completions", "GET"))).toBeUndefined();
  });
});

describe("classifyRequest", () => {
  test("chat completions with a Claude model is openai-chat / explicit", () => {
    const ref = { providerID: "openrouter", id: "anthropic/claude-haiku-5.5" };
    expect(classifyRequest(chat(), ref, noDeps)).toEqual({ wire: "openai-chat", strategy: "anthropic" });
  });

  test("an auto/claude-* alias is explicit", () => {
    const ref = { providerID: "omniroute", id: "auto/claude-opus-5-5" };
    expect(classifyRequest(chat(), ref, noDeps)?.strategy).toBe("anthropic");
  });

  test("the built-in regex also checks the body model", () => {
    const ref = { providerID: "omniroute", id: "auto/opus-5" };
    expect(classifyRequest(chat(), ref, noDeps, "anthropic/claude-opus-5")?.strategy).toBe("anthropic");
  });

  test("a non-Claude model is implicit", () => {
    const ref = { providerID: "openrouter", id: "deepseek/deepseek-v4.1-flash" };
    expect(classifyRequest(chat(), ref, noDeps)).toEqual({ wire: "openai-chat", strategy: "implicit" });
  });

  test("an alias is implicit, then explicit once learned, and patterns outrank both", async () => {
    const ref = { providerID: "omniroute", id: "auto/opus-5" };
    const store = new StrategyStore(memoryKv().kv);
    await store.load();
    const learned = (r: typeof ref) => store.get(r);

    expect(classifyRequest(chat(), ref, { patterns: [], learned })?.strategy).toBe("implicit");
    await store.learnFromResponse(ref, { model: "claude-opus-5-5" });
    expect(classifyRequest(chat(), ref, { patterns: [], learned })?.strategy).toBe("anthropic");
    expect(classifyRequest(chat(), ref, { patterns: parseModelPatterns(["!opus"]), learned })?.strategy).toBe("implicit");
  });

  test("a user pattern outranks the built-in regex", () => {
    const ref = { providerID: "omniroute", id: "auto/claude-opus-5-5" };
    expect(classifyRequest(chat(), ref, { patterns: parseModelPatterns(["!claude"]) })?.strategy).toBe("implicit");
  });

  test("the built-in regex outranks a learned implicit value", () => {
    const ref = { providerID: "omniroute", id: "auto/claude-opus-5-5" };
    expect(classifyRequest(chat(), ref, { patterns: [], learned: () => "implicit" })?.strategy).toBe("anthropic");
  });

  test("a pattern can make a non-Claude model explicit", () => {
    const ref = { providerID: "omniroute", id: "auto/opus-5" };
    expect(classifyRequest(chat(), ref, { patterns: parseModelPatterns(["opus"]) })?.strategy).toBe("anthropic");
  });

  test("POST …/messages is anthropic-messages / explicit regardless of model or patterns", () => {
    const request = chat("https://api.anthropic.com/v1/messages");
    const ref = { providerID: "anthropic", id: "whatever" };
    expect(classifyRequest(request, ref, { patterns: parseModelPatterns(["!whatever"]) })).toEqual({
      wire: "anthropic-messages",
      strategy: "anthropic",
    });
  });

  test("GET and other paths are not classified", () => {
    const ref = { providerID: "openrouter", id: "anthropic/claude-haiku-5.5" };
    expect(classifyRequest(chat(undefined, "GET"), ref, noDeps)).toBeUndefined();
    expect(classifyRequest(chat("https://omni.example/v1/embeddings"), ref, noDeps)).toBeUndefined();
  });

  test("a bad URL is not classified", () => {
    const request = { method: "POST", url: "not a url" } as Request;
    expect(classifyRequest(request, { providerID: "p", id: "m" }, noDeps)).toBeUndefined();
  });
});

describe("classifyRequestWithBody", () => {
  const ref = { providerID: "omniroute", id: "auto/opus-5" };
  const withBody = (model: unknown) =>
    new Request("https://omni.example/v1/chat/completions", { method: "POST", body: JSON.stringify({ model }) });

  test("reads body.model when the model ID alone is implicit", async () => {
    expect((await classifyRequestWithBody(withBody("anthropic/claude-opus-5"), ref, noDeps))?.strategy).toBe("anthropic");
  });

  test("leaves the request body readable", async () => {
    const request = withBody("anthropic/claude-opus-5");
    await classifyRequestWithBody(request, ref, noDeps);
    expect(await request.json()).toEqual({ model: "anthropic/claude-opus-5" });
  });

  test("a non-Claude body model, a missing model and an unparseable body stay implicit", async () => {
    expect((await classifyRequestWithBody(withBody("deepseek/v4"), ref, noDeps))?.strategy).toBe("implicit");
    expect((await classifyRequestWithBody(withBody(7), ref, noDeps))?.strategy).toBe("implicit");
    const broken = new Request("https://omni.example/v1/chat/completions", { method: "POST", body: "{" });
    expect((await classifyRequestWithBody(broken, ref, noDeps))?.strategy).toBe("implicit");
  });

  test("does not read the body for anthropic-messages or unclassified requests", async () => {
    const messages = new Request("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" });
    expect((await classifyRequestWithBody(messages, ref, noDeps))?.wire).toBe("anthropic-messages");
    expect(await classifyRequestWithBody(new Request("https://x.test/v1/embeddings", { method: "POST" }), ref, noDeps)).toBeUndefined();
  });

  test("a pattern still outranks the body model", async () => {
    const deps = { patterns: parseModelPatterns(["!opus"]) };
    expect((await classifyRequestWithBody(withBody("anthropic/claude-opus-5"), ref, deps))?.strategy).toBe("implicit");
  });

  test("a matching pattern, either way, never parses the body", async () => {
    for (const pattern of ["!opus", "opus"]) {
      const request = withBody("anthropic/claude-opus-5");
      const spy = spyOn(request, "clone");
      await classifyRequestWithBody(request, ref, { patterns: parseModelPatterns([pattern]) });
      expect(spy).not.toHaveBeenCalled();
    }
  });
});

describe("isAnthropicMessagesRequest", () => {
  test("matches POST to a /messages path on any host", () => {
    const post = (url: string) => new Request(url, { method: "POST", body: "{}" });
    expect(isAnthropicMessagesRequest(post("https://api.anthropic.com/v1/messages"))).toBe(true);
    expect(isAnthropicMessagesRequest(post("https://omniroute.linksy.au/v1/messages"))).toBe(true);
    expect(isAnthropicMessagesRequest(post("https://omniroute.linksy.au/v1/chat/completions"))).toBe(false);
  });

  test("rejects non-POST", () => {
    expect(isAnthropicMessagesRequest(new Request("https://api.anthropic.com/v1/messages"))).toBe(false);
  });
});

describe("routeRequest", () => {
  const base: RouteInput = { cls: undefined, anthropicProvider: false, hasSentinel: false, openaiCompatible: false };
  const route = (over: Partial<RouteInput>) => routeRequest({ ...base, ...over });
  const none: Route = { rewrites: false, observedWire: undefined, implicit: false, transformWire: undefined, explicitChat: false };

  test("an unclassified request is left alone", () => {
    expect(route({})).toEqual(none);
    expect(route({ openaiCompatible: true })).toEqual(none);
  });

  test("an Anthropic provider on /messages is rewritten and observed as anthropic-messages", () => {
    const cls = { wire: "anthropic-messages", strategy: "anthropic" } as const;
    for (const openaiCompatible of [false, true]) {
      expect(route({ cls, anthropicProvider: true, openaiCompatible })).toEqual({
        ...none,
        rewrites: true,
        observedWire: "anthropic-messages",
      });
    }
  });

  test("a proxied /messages request is observed but not rewritten", () => {
    const cls = { wire: "anthropic-messages", strategy: "anthropic" } as const;
    expect(route({ cls })).toEqual({ ...none, observedWire: "anthropic-messages" });
  });

  test("an Anthropic provider on /chat/completions with the option off is rewritten as an Anthropic body", () => {
    const cls = { wire: "openai-chat", strategy: "anthropic" } as const;
    expect(route({ cls, anthropicProvider: true })).toEqual({
      ...none,
      rewrites: true,
      observedWire: "anthropic-messages",
    });
  });

  test("openai-chat explicit with the option on is rewritten, injected and observed as openai-chat", () => {
    const cls = { wire: "openai-chat", strategy: "anthropic" } as const;
    expect(route({ cls, openaiCompatible: true })).toEqual({
      rewrites: true,
      observedWire: "openai-chat",
      implicit: false,
      transformWire: "openai-chat",
      explicitChat: true,
    });
  });

  test("openai-chat explicit with the option off is untouched", () => {
    const cls = { wire: "openai-chat", strategy: "anthropic" } as const;
    expect(route({ cls })).toEqual(none);
  });

  test("openai-chat implicit with the option on is observed only", () => {
    const cls = { wire: "openai-chat", strategy: "implicit" } as const;
    expect(route({ cls, openaiCompatible: true })).toEqual({
      ...none,
      observedWire: "openai-chat",
      implicit: true,
      transformWire: "openai-chat",
    });
  });

  test("openai-chat implicit with the option off is untouched", () => {
    const cls = { wire: "openai-chat", strategy: "implicit" } as const;
    expect(route({ cls })).toEqual(none);
  });

  test("the sentinel alone rewrites, through the OpenAI rewriter only on openai-chat", () => {
    expect(route({ hasSentinel: true })).toEqual({ ...none, rewrites: true });
    expect(route({ hasSentinel: true, cls: { wire: "openai-chat", strategy: "implicit" } })).toEqual({
      ...none,
      rewrites: true,
      transformWire: "openai-chat",
    });
    expect(route({ hasSentinel: true, cls: { wire: "anthropic-messages", strategy: "anthropic" } })).toEqual({
      ...none,
      rewrites: true,
      observedWire: "anthropic-messages",
    });
  });

  test("matches the former inline expressions for every input", () => {
    const wires = [undefined, "anthropic-messages", "openai-chat"] as const;
    const strategies = ["anthropic", "implicit"] as const;
    const bools = [false, true];
    for (const wire of wires)
      for (const strategy of strategies)
        for (const anthropicProvider of bools)
          for (const hasSentinel of bools)
            for (const openaiCompatible of bools) {
              const cls = wire ? { wire, strategy } : undefined;
              const chat = cls?.wire === "openai-chat";
              const explicitChat = chat && openaiCompatible && cls.strategy === "anthropic";
              const observed = anthropicProvider || cls?.wire === "anthropic-messages" || (chat && openaiCompatible);
              const got = route({ cls, anthropicProvider, hasSentinel, openaiCompatible });
              expect(got.explicitChat).toBe(explicitChat);
              expect(got.implicit).toBe(chat && openaiCompatible && cls.strategy === "implicit");
              expect(got.rewrites).toBe(anthropicProvider || hasSentinel || explicitChat);
              expect(got.observedWire !== undefined).toBe(observed);
              expect(got.transformWire).toBe(chat && (openaiCompatible || hasSentinel) ? "openai-chat" : undefined);
              const responseWire =
                cls?.wire === "openai-chat" && openaiCompatible
                  ? "openai-chat"
                  : anthropicProvider || cls?.wire === "anthropic-messages"
                    ? "anthropic-messages"
                    : undefined;
              expect(got.observedWire).toBe(responseWire);
              expect(observedWireFor(cls?.wire, anthropicProvider, openaiCompatible)).toBe(responseWire);
            }
  });

  test("observedWireFor needs only the wire, the provider and the option", () => {
    expect(observedWireFor("openai-chat", false, true)).toBe("openai-chat");
    expect(observedWireFor("openai-chat", false, false)).toBeUndefined();
    expect(observedWireFor("openai-chat", true, false)).toBe("anthropic-messages");
    expect(observedWireFor(undefined, true, true)).toBe("anthropic-messages");
    expect(observedWireFor(undefined, false, true)).toBeUndefined();
  });
});

describe("shouldInject", () => {
  const explicit = routeRequest({
    cls: { wire: "openai-chat", strategy: "anthropic" },
    anthropicProvider: false,
    hasSentinel: false,
    openaiCompatible: true,
  });
  const implicit = routeRequest({
    cls: { wire: "openai-chat", strategy: "implicit" },
    anthropicProvider: false,
    hasSentinel: false,
    openaiCompatible: true,
  });

  test("injects on an explicit chat primary or compaction request that is not a ping", () => {
    expect(shouldInject(explicit, "primary", false)).toBe(true);
    expect(shouldInject(explicit, "compaction", false)).toBe(true);
    expect(shouldInject(explicit, "title", false)).toBe(false);
    expect(shouldInject(explicit, "generate", false)).toBe(false);
  });

  test("never injects a ping", () => {
    for (const kind of ["primary", "compaction", "title", "generate"] as const) {
      expect(shouldInject(explicit, kind, true)).toBe(false);
    }
  });

  test("never injects a route that is not explicit chat", () => {
    expect(shouldInject(implicit, "primary", false)).toBe(false);
    expect(shouldInject(routeRequest({ cls: undefined, anthropicProvider: true, hasSentinel: false, openaiCompatible: true }), "primary", false)).toBe(false);
  });
});
