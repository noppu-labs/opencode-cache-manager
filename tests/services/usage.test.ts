import { describe, expect, test } from "bun:test";
import {
  ANTHROPIC_PARSERS,
  contextTokens,
  grantedTtl,
  hasCacheActivity,
  parseStopReasonFromJson,
  parseStopReasonFromSse,
  parseUsageFromJson,
  parseUsageFromSse,
} from "../../src/services/usage.ts";
import { fullParsed, fullUsage, sse } from "../helpers/fixtures.ts";

describe("parseUsageFromJson", () => {
  test("reads a full usage block", () => {
    const usage = parseUsageFromJson({ usage: fullUsage });
    expect(usage).toEqual(fullParsed);
    expect(grantedTtl(usage!)).toBe("1h");
    expect(contextTokens(usage!)).toBe(60510);
    expect(hasCacheActivity(usage!)).toBe(true);
  });

  test("leaves the breakdown undefined when cache_creation is absent", () => {
    const { cache_creation: _omit, ...rest } = fullUsage;
    const usage = parseUsageFromJson({ usage: rest })!;
    expect(usage.write5mTokens).toBeUndefined();
    expect(usage.write1hTokens).toBeUndefined();
    expect(grantedTtl(usage)).toBeUndefined();
  });

  test("mixed writes grant 5m", () => {
    const usage = parseUsageFromJson({
      usage: {
        ...fullUsage,
        cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 400 },
      },
    })!;
    expect(grantedTtl(usage)).toBe("5m");
  });

  test("a pure cache read grants nothing", () => {
    const usage = parseUsageFromJson({
      usage: {
        input_tokens: 5,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 0,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
      },
    })!;
    expect(grantedTtl(usage)).toBeUndefined();
    expect(hasCacheActivity(usage)).toBe(true);
  });

  test("no activity when read and write are both zero", () => {
    const usage = parseUsageFromJson({ usage: { input_tokens: 5 } })!;
    expect(hasCacheActivity(usage)).toBe(false);
  });

  test("non-numeric fields default to 0", () => {
    const usage = parseUsageFromJson({ usage: { input_tokens: "x", cache_read_input_tokens: null } })!;
    expect(usage.inputTokens).toBe(0);
    expect(usage.cacheReadTokens).toBe(0);
    expect(usage.cacheWriteTokens).toBe(0);
  });

  test("returns undefined for bodies without usage", () => {
    expect(parseUsageFromJson({})).toBeUndefined();
    expect(parseUsageFromJson(null)).toBeUndefined();
    expect(parseUsageFromJson("x")).toBeUndefined();
  });
});

describe("parseUsageFromSse", () => {
  test("message_delta overrides defined fields from message_start", () => {
    const usage = parseUsageFromSse(sse(fullUsage))!;
    expect(usage.cacheReadTokens).toBe(61000);
    expect(usage.inputTokens).toBe(10);
    expect(usage.cacheWriteTokens).toBe(500);
    expect(usage.write1hTokens).toBe(500);
    expect(usage.write5mTokens).toBe(0);
  });

  test("skips malformed data lines", () => {
    const text = `event: ping\ndata: {not json\n\n` + sse(fullUsage);
    expect(parseUsageFromSse(text)?.cacheReadTokens).toBe(61000);
  });

  test("returns undefined without any usage", () => {
    expect(parseUsageFromSse("event: ping\ndata: {}\n\n")).toBeUndefined();
    expect(parseUsageFromSse("")).toBeUndefined();
  });
});

describe("parseStopReason", () => {
  test("reads message_delta.delta.stop_reason from SSE and top-level stop_reason from JSON", () => {
    expect(parseStopReasonFromSse(`data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n`)).toBe(
      "tool_use",
    );
    expect(parseStopReasonFromSse(sse(fullUsage))).toBeUndefined();
    expect(parseStopReasonFromJson({ stop_reason: "end_turn" })).toBe("end_turn");
    expect(parseStopReasonFromJson({ stop_reason: null })).toBeUndefined();
    expect(parseStopReasonFromJson(null)).toBeUndefined();
  });
});

describe("ANTHROPIC_PARSERS identity", () => {
  const start = (message: unknown) => `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message })}\n\n`;

  test("reads the model of a JSON body", () => {
    expect(ANTHROPIC_PARSERS.fromJson({ model: "claude-haiku-5-5", usage: fullUsage }).identity).toEqual({
      model: "claude-haiku-5-5",
    });
  });

  test("reports no identity for a JSON body without a model", () => {
    expect(ANTHROPIC_PARSERS.fromJson({ usage: fullUsage }).identity).toBeUndefined();
    expect(ANTHROPIC_PARSERS.fromJson({ model: "" }).identity).toBeUndefined();
    expect(ANTHROPIC_PARSERS.fromJson({ model: 5 }).identity).toBeUndefined();
    expect(ANTHROPIC_PARSERS.fromJson("nope").identity).toBeUndefined();
  });

  test("reads the model of the message_start event", () => {
    const text = start({ model: "claude-haiku-5-5", usage: fullUsage });
    expect(ANTHROPIC_PARSERS.fromSse(text).identity).toEqual({ model: "claude-haiku-5-5" });
  });

  test("keeps a router-prefixed model as reported", () => {
    const text = start({ model: "deepseek/deepseek-v4.1-flash" });
    expect(ANTHROPIC_PARSERS.fromSse(text).identity).toEqual({ model: "deepseek/deepseek-v4.1-flash" });
  });

  test("the first message_start wins and junk lines are skipped", () => {
    const text = `data: {nope\n\n${start({ model: "first" })}${start({ model: "second" })}`;
    expect(ANTHROPIC_PARSERS.fromSse(text).identity).toEqual({ model: "first" });
  });

  test("reports no identity for a stream without a message model", () => {
    expect(ANTHROPIC_PARSERS.fromSse(sse(fullUsage)).identity).toBeUndefined();
    expect(ANTHROPIC_PARSERS.fromSse(start({ model: "" })).identity).toBeUndefined();
  });
});
