import { describe, expect, test } from "bun:test";
import { isCacheTtlMode } from "../../src/models/cache.ts";

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
