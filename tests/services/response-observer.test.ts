import { describe, expect, test } from "bun:test";
import { observeResponseUsage } from "../../src/services/response-observer.ts";
import { OPENAI_PARSERS } from "../../src/services/usage-openai.ts";
import type { CacheUsage } from "../../src/models/cache.ts";
import { openaiSse, openaiUsage } from "../helpers/fixtures.ts";

const fullUsage = {
  input_tokens: 10,
  cache_read_input_tokens: 60000,
  cache_creation_input_tokens: 500,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 500 },
};

const fullParsed: CacheUsage = {
  inputTokens: 10,
  cacheReadTokens: 60000,
  cacheWriteTokens: 500,
  write5mTokens: 0,
  write1hTokens: 500,
};

function sse(usage: unknown): string {
  return (
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage } })}\n\n` +
    `event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":5,"cache_read_input_tokens":61000}}\n\n`
  );
}

describe("observeResponseUsage", () => {
  test("passes SSE through unchanged and resolves usage", async () => {
    const text = sse(fullUsage);
    const original = new Response(text, {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "text/event-stream", "x-test": "1" },
    });
    const { response, usage } = observeResponseUsage(original);
    expect(response.status).toBe(200);
    expect(response.statusText).toBe("OK");
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("x-test")).toBe("1");
    expect(await response.text()).toBe(text);
    expect((await usage)?.cacheReadTokens).toBe(61000);
  });

  test("passes JSON through unchanged and resolves usage", async () => {
    const text = JSON.stringify({ usage: fullUsage });
    const { response, usage } = observeResponseUsage(
      new Response(text, { headers: { "content-type": "application/json" } }),
    );
    expect(await response.text()).toBe(text);
    expect(await usage).toEqual(fullParsed);
  });

  test("error responses pass through and resolve undefined", async () => {
    const text = JSON.stringify({ type: "error", error: { type: "invalid_request_error" } });
    const { response, usage } = observeResponseUsage(
      new Response(text, { status: 400, headers: { "content-type": "application/json" } }),
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toBe(text);
    expect(await usage).toBeUndefined();
  });

  test("bodyless responses resolve undefined", async () => {
    const { response, usage } = observeResponseUsage(new Response(null, { status: 204 }));
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
    expect(await usage).toBeUndefined();
  });

  test("unparseable JSON resolves undefined without rejecting", async () => {
    const { response, usage } = observeResponseUsage(
      new Response("not json", { headers: { "content-type": "application/json" } }),
    );
    expect(await response.text()).toBe("not json");
    expect(await usage).toBeUndefined();
  });

  test("resolves the stop reason of SSE and JSON responses", async () => {
    const streamed = sse(fullUsage) + `data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{}}\n\n`;
    const fromSse = observeResponseUsage(
      new Response(streamed, { headers: { "content-type": "text/event-stream" } }),
    );
    await fromSse.response.text();
    expect(await fromSse.stopReason).toBe("tool_use");

    const fromJson = observeResponseUsage(
      new Response(JSON.stringify({ stop_reason: "end_turn", usage: fullUsage }), {
        headers: { "content-type": "application/json" },
      }),
    );
    await fromJson.response.text();
    expect(await fromJson.stopReason).toBe("end_turn");

    const failed = observeResponseUsage(new Response("not json", { headers: { "content-type": "application/json" } }));
    await failed.response.text();
    expect(await failed.stopReason).toBeUndefined();
  });

  test("openai-chat wire resolves usage, finish reason and identity from SSE", async () => {
    const text = openaiSse(openaiUsage.lunaRead, { finishReason: "tool_calls" });
    const observed = observeResponseUsage(
      new Response(text, { headers: { "content-type": "text/event-stream" } }),
      OPENAI_PARSERS,
    );
    expect(await observed.response.text()).toBe(text);
    expect(await observed.usage).toMatchObject({ inputTokens: 3, cacheReadTokens: 8884, cacheWriteTokens: 19 });
    expect(await observed.stopReason).toBe("tool_use");
    expect(await observed.identity).toEqual({ model: "openai/gpt-6-luna", provider: "OpenAI" });
  });

  test("openai-chat wire parses a JSON body", async () => {
    const observed = observeResponseUsage(
      new Response(
        JSON.stringify({
          model: "claude-haiku-5-5",
          choices: [{ finish_reason: "stop" }],
          usage: openaiUsage.deepseekRead,
        }),
        { headers: { "content-type": "application/json" } },
      ),
      OPENAI_PARSERS,
    );
    expect(await observed.usage).toMatchObject({ inputTokens: 83, cacheReadTokens: 10112 });
    expect(await observed.stopReason).toBe("stop");
    expect(await observed.identity).toEqual({ model: "claude-haiku-5-5" });
  });

  test("identity is undefined on the Anthropic wire", async () => {
    const observed = observeResponseUsage(
      new Response(sse(fullUsage), { headers: { "content-type": "text/event-stream" } }),
    );
    expect(await observed.identity).toBeUndefined();
    expect(await observed.usage).toMatchObject({ inputTokens: 10 });
  });

  test("cancelling the returned body cancels the source stream", async () => {
    let pulled = 0;
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled++;
          if (pulled > 1000) controller.close();
          else controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const { response, usage } = observeResponseUsage(
      new Response(source, { headers: { "content-type": "text/event-stream" } }),
    );
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel("user abort");
    expect(cancelled).toBe(true);
    expect(await usage).toBeUndefined();
    const pulledAfterCancel = pulled;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(pulled).toBe(pulledAfterCancel);
  });
});
