import { describe, expect, test } from "bun:test";
import { createResponseHook, type HttpResponseEvent } from "../../src/middleware/response.ts";
import type { PluginOptions } from "../../src/config/settings.ts";
import type { ModelRef } from "../../src/models/cache.ts";
import type { KeepaliveEngine } from "../../src/services/keepalive-engine.ts";
import { PingTracker } from "../../src/services/ping-tracker.ts";
import { makeRequest, openaiSse, openaiUsage } from "../helpers/fixtures.ts";

const WRITE_1H = {
  input_tokens: 10,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 60_000,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 60_000 },
};

const WRITE_1H_PARSED = {
  inputTokens: 10,
  cacheReadTokens: 0,
  cacheWriteTokens: 60_000,
  write5mTokens: 0,
  write1hTokens: 60_000,
};

async function flush() {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

function harness(config: { options?: Partial<PluginOptions> } = {}) {
  const options: PluginOptions = { openaiCompatible: true, cacheProfiles: [], ...config.options };
  const learnCalls: Array<{ ref: ModelRef; identity: unknown }> = [];
  const strategies = {
    learnFromResponse: async (ref: ModelRef, identity: unknown) => {
      learnCalls.push({ ref, identity });
    },
  };
  const observed: Array<{ sessionID: string; info: Record<string, unknown> }> = [];
  const fake = {
    pending: undefined as Promise<void> | undefined,
    fail: false,
  };
  const engine = {
    responseObserved: (sessionID: string, info: Record<string, unknown>) => {
      observed.push({ sessionID, info });
      if (fake.fail) throw new Error("engine down");
      return fake.pending ?? Promise.resolve();
    },
  } as unknown as KeepaliveEngine;
  const pings = new PingTracker();
  const hook = createResponseHook({ engine, pings, options, strategies });
  return { hook, pings, observed, fake, learnCalls };
}

function jsonResponse(body: unknown = { usage: WRITE_1H }, status = 200) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function event(overrides: Partial<HttpResponseEvent> = {}): HttpResponseEvent {
  return {
    sessionID: "ses_a",
    kind: "primary",
    model: { providerID: "anthropic", id: "claude-sonnet-5-5" },
    request: makeRequest("{}"),
    response: jsonResponse(),
    ...overrides,
  };
}

describe("createResponseHook", () => {
  test("reports usage, status and kind for an Anthropic provider", async () => {
    const { hook, observed } = harness();
    await hook(event());
    await flush();

    expect(observed).toEqual([
      {
        sessionID: "ses_a",
        info: { usage: WRITE_1H_PARSED, ok: true, isPing: false, kind: "primary", stopReason: undefined },
      },
    ]);
  });

  test("reports the stop reason of a JSON response", async () => {
    const { hook, observed } = harness();
    await hook(event({ response: jsonResponse({ stop_reason: "tool_use", usage: WRITE_1H }) }));
    await flush();

    expect(observed[0].info).toMatchObject({ stopReason: "tool_use", usage: WRITE_1H_PARSED });
  });

  test("reports usage and the stop reason of a streamed response", async () => {
    const { hook, observed } = harness();
    const text = [
      `data: ${JSON.stringify({ type: "message_start", message: { usage: WRITE_1H } })}`,
      `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } })}`,
      "",
    ].join("\n");
    await hook(event({ response: new Response(text, { headers: { "content-type": "text/event-stream" } }) }));
    await flush();

    expect(observed[0].info).toMatchObject({ stopReason: "end_turn", usage: WRITE_1H_PARSED });
  });

  test("passes the session and kind through", async () => {
    const { hook, observed } = harness();
    await hook(event({ sessionID: "ses_b", kind: "title" }));
    await flush();

    expect(observed[0].sessionID).toBe("ses_b");
    expect(observed[0].info.kind).toBe("title");
  });

  test("reports a failed response as not ok, without usage", async () => {
    const { hook, observed } = harness();
    await hook(event({ response: jsonResponse({}, 529) }));
    await flush();

    expect(observed[0].info).toMatchObject({ ok: false, usage: undefined });
  });

  test("reports no usage for a response without a usage block", async () => {
    const { hook, observed } = harness();
    await hook(event({ response: jsonResponse({}) }));
    await flush();

    expect(observed[0].info).toMatchObject({ ok: true, usage: undefined });
  });

  test("the response left on the event still has the original body and status", async () => {
    const { hook } = harness();
    const original = JSON.stringify({ usage: WRITE_1H });
    const evt = event({ response: jsonResponse(original) });
    await hook(evt);

    expect(evt.response.status).toBe(200);
    expect(await evt.response.text()).toBe(original);
  });

  test("a non-Anthropic provider and URL are not observed", async () => {
    const { hook, observed } = harness();
    const response = jsonResponse();
    const evt = event({
      model: { providerID: "openai", id: "gpt-6" },
      request: new Request("https://api.openai.com/v1/embeddings", { method: "POST", body: "{}" }),
      response,
    });
    await hook(evt);
    await flush();

    expect(observed).toHaveLength(0);
    expect(evt.response).toBe(response);
  });

  test("an Anthropic-shaped URL on an unknown provider is observed", async () => {
    const { hook, observed } = harness();
    await hook(
      event({
        model: { providerID: "some-proxy", id: "m" },
        request: new Request("https://proxy.example/anthropic/v1/messages", { method: "POST", body: "{}" }),
      }),
    );
    await flush();

    expect(observed).toHaveLength(1);
    expect(observed[0].info.usage).toEqual(WRITE_1H_PARSED);
  });

  test("a non-POST request to a messages path on an unknown provider is not observed", async () => {
    const { hook, observed } = harness();
    await hook(
      event({
        model: { providerID: "some-proxy", id: "m" },
        request: new Request("https://proxy.example/v1/messages", { method: "GET" }),
      }),
    );
    await flush();

    expect(observed).toHaveLength(0);
  });

  test("a response whose body is already locked passes through unchanged", async () => {
    const { hook, observed } = harness();
    const response = jsonResponse();
    response.body!.getReader();
    const evt = event({ response });
    await hook(evt);
    await flush();

    expect(evt.response).toBe(response);
    expect(observed).toHaveLength(0);
  });

  test("a response without a body is still reported", async () => {
    const { hook, observed } = harness();
    await hook(event({ response: new Response(null, { status: 204 }) }));
    await flush();

    expect(observed[0].info).toMatchObject({ ok: true, usage: undefined, stopReason: undefined });
  });
});

describe("createResponseHook ping handling", () => {
  test("a generate response during a pending ping is reported as a ping", async () => {
    const { hook, pings, observed } = harness();
    await pings.send("ses_a", () => hook(event({ kind: "generate" })));

    expect(observed).toHaveLength(1);
    expect(observed[0].info).toMatchObject({ isPing: true, kind: "generate" });
  });

  test("a generate response without a pending ping is not a ping", async () => {
    const { hook, observed } = harness();
    await hook(event({ kind: "generate" }));
    await flush();

    expect(observed[0].info.isPing).toBe(false);
  });

  test("a primary response during a pending ping is not a ping", async () => {
    const { hook, pings, observed } = harness();
    const g = gate();
    const sending = pings.send("ses_a", () => g.promise);

    await hook(event({ kind: "primary" }));
    await flush();
    expect(observed[0].info.isPing).toBe(false);

    g.open();
    await sending;
  });

  test("the ping flag is per session", async () => {
    const { hook, pings, observed } = harness();
    const g = gate();
    const sending = pings.send("ses_a", () => g.promise);

    await hook(event({ sessionID: "ses_b", kind: "generate" }));
    await flush();
    expect(observed[0]).toMatchObject({ sessionID: "ses_b", info: { isPing: false } });

    g.open();
    await sending;
  });

  test("send settles only after the engine has been told about the ping response", async () => {
    const { hook, pings, observed, fake } = harness();
    const engineDone = gate();
    fake.pending = engineDone.promise;
    let settled = false;

    const sending = pings.send("ses_a", () => hook(event({ kind: "generate" }))).then(() => {
      settled = true;
    });
    await flush();

    expect(observed).toHaveLength(1);
    expect(settled).toBe(false);

    engineDone.open();
    await sending;
    expect(settled).toBe(true);
  });

  test("an engine failure does not leave a ping hanging", async () => {
    const { hook, pings, fake } = harness();
    fake.fail = true;

    await pings.send("ses_a", () => hook(event({ kind: "generate" })));

    expect(pings.isPing("generate", "ses_a")).toBe(false);
  });

  test("an engine failure does not fail the hook", async () => {
    const { hook, observed, fake } = harness();
    fake.fail = true;

    await expect(hook(event())).resolves.toBeUndefined();
    await flush();
    expect(observed).toHaveLength(1);
  });

  test("an ignored response during a ping does not make send wait", async () => {
    const { hook, pings, observed } = harness();
    await pings.send("ses_a", () =>
      hook(
        event({
          kind: "generate",
          model: { providerID: "openai", id: "gpt-6" },
          request: new Request("https://api.openai.com/v1/embeddings", { method: "POST", body: "{}" }),
        }),
      ),
    );

    expect(observed).toHaveLength(0);
  });
});

describe("createResponseHook on openai-chat", () => {
  const CHAT = () => new Request("https://omni.example/v1/chat/completions", { method: "POST", body: "{}" });
  const sse = (text: string) => new Response(text, { headers: { "content-type": "text/event-stream" } });
  const chatEvent = (overrides: Partial<HttpResponseEvent> = {}) =>
    event({
      model: { providerID: "omniroute", id: "auto/opus-5" },
      request: CHAT(),
      response: sse(openaiSse(openaiUsage.lunaRead, { model: "claude-opus-5-5", provider: "Anthropic" })),
      ...overrides,
    });

  test("reports usage and the finish reason, and learns the identity", async () => {
    const { hook, observed, learnCalls } = harness();
    const evt = chatEvent();
    await hook(evt);
    await flush();

    expect(observed[0]?.info).toMatchObject({
      ok: true,
      stopReason: "stop",
      usage: { inputTokens: 3, cacheReadTokens: 8884 },
    });
    expect(learnCalls).toEqual([
      { ref: { providerID: "omniroute", id: "auto/opus-5" }, identity: { model: "claude-opus-5-5", provider: "Anthropic" } },
    ]);
  });

  test("the caller still receives the untouched stream", async () => {
    const { hook } = harness();
    const original = openaiSse(openaiUsage.lunaRead);
    const evt = chatEvent({ response: sse(original) });
    await hook(evt);
    expect(await evt.response.text()).toBe(original);
  });

  test("a learning failure never reaches the host", async () => {
    const { hook, observed } = harness();
    const throwing = createResponseHook({
      engine: { responseObserved: () => Promise.resolve() } as unknown as KeepaliveEngine,
      pings: new PingTracker(),
      options: { openaiCompatible: true, cacheProfiles: [] },
      strategies: {
        learnFromResponse: async () => {
          throw new Error("storage down");
        },
      },
    });
    await throwing(chatEvent());
    await flush();
    await hook(chatEvent());
    await flush();
    expect(observed).toHaveLength(1);
  });

  test("a ping response is tracked as on the Anthropic wire", async () => {
    const { hook, pings, observed } = harness();
    let release!: () => void;
    const sending = pings.send("ses_a", () => new Promise<void>((resolve) => (release = resolve)));
    await hook(chatEvent({ kind: "generate" }));
    release();
    await sending;
    expect(observed[0]?.info).toMatchObject({ isPing: true, kind: "generate" });
  });

  test("with the option off the response is left alone and nothing is learned", async () => {
    const { hook, observed, learnCalls } = harness({ options: { openaiCompatible: false } });
    const evt = chatEvent();
    const original = evt.response;
    await hook(evt);
    await flush();
    expect(evt.response).toBe(original);
    expect(observed).toHaveLength(0);
    expect(learnCalls).toHaveLength(0);
  });

  test("anthropic-messages responses never trigger learning", async () => {
    const { hook, learnCalls } = harness();
    await hook(event());
    await flush();
    expect(learnCalls).toHaveLength(0);
  });
});
