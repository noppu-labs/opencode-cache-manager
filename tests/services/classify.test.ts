import { describe, expect, spyOn, test } from "bun:test";
import { classifyRequest, classifyRequestWithBody, requestWire } from "../../src/services/classify.ts";
import { parseModelPatterns } from "../../src/services/model-patterns.ts";
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
    expect(classifyRequest(chat(), ref, noDeps)).toEqual({ wire: "openai-chat", strategy: "explicit" });
  });

  test("an auto/claude-* alias is explicit", () => {
    const ref = { providerID: "omniroute", id: "auto/claude-opus-5-5" };
    expect(classifyRequest(chat(), ref, noDeps)?.strategy).toBe("explicit");
  });

  test("the built-in regex also checks the body model", () => {
    const ref = { providerID: "omniroute", id: "auto/opus-5" };
    expect(classifyRequest(chat(), ref, noDeps, "anthropic/claude-opus-5")?.strategy).toBe("explicit");
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
    expect(classifyRequest(chat(), ref, { patterns: [], learned })?.strategy).toBe("explicit");
    expect(classifyRequest(chat(), ref, { patterns: parseModelPatterns(["!opus"]), learned })?.strategy).toBe("implicit");
  });

  test("a user pattern outranks the built-in regex", () => {
    const ref = { providerID: "omniroute", id: "auto/claude-opus-5-5" };
    expect(classifyRequest(chat(), ref, { patterns: parseModelPatterns(["!claude"]) })?.strategy).toBe("implicit");
  });

  test("the built-in regex outranks a learned implicit value", () => {
    const ref = { providerID: "omniroute", id: "auto/claude-opus-5-5" };
    expect(classifyRequest(chat(), ref, { patterns: [], learned: () => "implicit" })?.strategy).toBe("explicit");
  });

  test("a pattern can make a non-Claude model explicit", () => {
    const ref = { providerID: "omniroute", id: "auto/opus-5" };
    expect(classifyRequest(chat(), ref, { patterns: parseModelPatterns(["opus"]) })?.strategy).toBe("explicit");
  });

  test("POST …/messages is anthropic-messages / explicit regardless of model or patterns", () => {
    const request = chat("https://api.anthropic.com/v1/messages");
    const ref = { providerID: "anthropic", id: "whatever" };
    expect(classifyRequest(request, ref, { patterns: parseModelPatterns(["!whatever"]) })).toEqual({
      wire: "anthropic-messages",
      strategy: "explicit",
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
    expect((await classifyRequestWithBody(withBody("anthropic/claude-opus-5"), ref, noDeps))?.strategy).toBe("explicit");
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
