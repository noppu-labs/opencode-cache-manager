import { describe, expect, test } from "bun:test";
import {
  contextTokens,
  grantedTtl,
  hasCacheActivity,
  parseStopReasonFromJson,
  parseStopReasonFromSse,
  parseUsageFromJson,
  parseUsageFromSse,
} from "../../src/services/usage.ts";
import type { CacheUsage } from "../../src/models/cache.ts";

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
