import { describe, expect, test } from "bun:test";
import { RESPONSES_PARSERS } from "../../src/services/usage-responses.ts";
import { responsesSse, responsesUsage } from "../helpers/fixtures.ts";

const writeParsed = {
  inputTokens: 3,
  cacheReadTokens: 0,
  cacheWriteTokens: 8885,
  write5mTokens: undefined,
  write1hTokens: undefined,
};
const readParsed = {
  inputTokens: 3,
  cacheReadTokens: 8885,
  cacheWriteTokens: 19,
  write5mTokens: undefined,
  write1hTokens: undefined,
};

const jsonBody = (usage: unknown, extra: Record<string, unknown> = {}) => ({
  model: "openai/gpt-6-luna",
  status: "completed",
  output: [{ type: "message", content: [] }],
  usage,
  ...extra,
});

describe("RESPONSES_PARSERS.fromJson", () => {
  test("reads cache writes and reads from input_tokens_details", () => {
    expect(RESPONSES_PARSERS.fromJson(jsonBody(responsesUsage.write)).usage).toEqual(writeParsed);
    expect(RESPONSES_PARSERS.fromJson(jsonBody(responsesUsage.read)).usage).toEqual(readParsed);
  });

  test("without cache details the whole input is uncached", () => {
    const usage = RESPONSES_PARSERS.fromJson(jsonBody({ input_tokens: 100, output_tokens: 3 })).usage;
    expect(usage).toEqual({ inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, write5mTokens: undefined, write1hTokens: undefined });
  });

  test("input never goes negative", () => {
    const usage = RESPONSES_PARSERS.fromJson(
      jsonBody({ input_tokens: 10, input_tokens_details: { cached_tokens: 50 } }),
    ).usage;
    expect(usage?.inputTokens).toBe(0);
  });

  test("a body without usage, or with a non-numeric input_tokens, has none", () => {
    expect(RESPONSES_PARSERS.fromJson({ model: "m" }).usage).toBeUndefined();
    expect(RESPONSES_PARSERS.fromJson(jsonBody({ input_tokens: "x" })).usage).toBeUndefined();
    expect(RESPONSES_PARSERS.fromJson(null).usage).toBeUndefined();
    expect(RESPONSES_PARSERS.fromJson("text").usage).toBeUndefined();
  });

  test("completed is stop, a trailing function call is tool_use", () => {
    expect(RESPONSES_PARSERS.fromJson(jsonBody(responsesUsage.write)).stopReason).toBe("stop");
    const withTool = jsonBody(responsesUsage.write, {
      output: [{ type: "message", content: [] }, { type: "function_call", name: "read" }],
    });
    expect(RESPONSES_PARSERS.fromJson(withTool).stopReason).toBe("tool_use");
  });

  test("another status passes through, and a missing one is undefined", () => {
    expect(RESPONSES_PARSERS.fromJson(jsonBody(responsesUsage.write, { status: "incomplete" })).stopReason).toBe("incomplete");
    expect(RESPONSES_PARSERS.fromJson({ usage: responsesUsage.write }).stopReason).toBeUndefined();
  });

  test("identity is the model", () => {
    expect(RESPONSES_PARSERS.fromJson(jsonBody(responsesUsage.write)).identity).toEqual({ model: "openai/gpt-6-luna" });
    expect(RESPONSES_PARSERS.fromJson({ usage: responsesUsage.write }).identity).toBeUndefined();
  });
});

describe("RESPONSES_PARSERS.fromSse", () => {
  test("takes usage, stop reason and model from response.completed", () => {
    const parsed = RESPONSES_PARSERS.fromSse(responsesSse(responsesUsage.read));
    expect(parsed.usage).toEqual(readParsed);
    expect(parsed.stopReason).toBe("stop");
    expect(parsed.identity).toEqual({ model: "openai/gpt-6-luna" });
  });

  test("a function call output reads as tool_use", () => {
    expect(RESPONSES_PARSERS.fromSse(responsesSse(responsesUsage.write, { toolCall: true })).stopReason).toBe("tool_use");
  });

  test("response.incomplete carries usage too", () => {
    const text = responsesSse(responsesUsage.write, { event: "response.incomplete", status: "incomplete" });
    const parsed = RESPONSES_PARSERS.fromSse(text);
    expect(parsed.usage).toEqual(writeParsed);
    expect(parsed.stopReason).toBe("incomplete");
  });

  test("the in-progress response.created event is not read as the final one", () => {
    const created = `data: ${JSON.stringify({ type: "response.created", response: { model: "m", usage: responsesUsage.read } })}\n\n`;
    expect(RESPONSES_PARSERS.fromSse(created)).toEqual({});
  });

  test("the last terminal event wins", () => {
    const text = responsesSse(responsesUsage.write) + responsesSse(responsesUsage.read);
    expect(RESPONSES_PARSERS.fromSse(text).usage).toEqual(readParsed);
  });

  test("a bare response object on a data line is accepted", () => {
    const text = `data: ${JSON.stringify(jsonBody(responsesUsage.write))}\n\ndata: [DONE]\n\n`;
    const parsed = RESPONSES_PARSERS.fromSse(text);
    expect(parsed.usage).toEqual(writeParsed);
    expect(parsed.stopReason).toBe("stop");
  });

  test("junk, [DONE] and empty text yield nothing", () => {
    expect(RESPONSES_PARSERS.fromSse("")).toEqual({});
    expect(RESPONSES_PARSERS.fromSse("data: [DONE]\n\ndata: {oops\n\n")).toEqual({});
  });

  test("a stream cut before the terminal event yields nothing", () => {
    const cut = responsesSse(responsesUsage.write).split("event: response.completed")[0] ?? "";
    expect(RESPONSES_PARSERS.fromSse(cut)).toEqual({});
  });
});
