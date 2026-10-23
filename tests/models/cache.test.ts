import { describe, expect, test } from "bun:test";
import { isCacheProfileId, isCacheTtlMode } from "../../src/models/cache.ts";

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

describe("isCacheProfileId", () => {
  test("accepts the three profile IDs", () => {
    for (const id of ["anthropic", "openai", "implicit"]) expect(isCacheProfileId(id)).toBe(true);
  });

  test("rejects anything else, including the 0.4 strategy name", () => {
    for (const value of ["explicit", "", "OpenAI", undefined, null, 1]) expect(isCacheProfileId(value)).toBe(false);
  });
});
