import { describe, expect, test } from "bun:test";
import { parseModelPatterns } from "../../src/config/model-patterns.ts";

describe("parseModelPatterns", () => {
  test("drops an invalid regex", () => {
    expect(parseModelPatterns(["/(/", "opus"])).toHaveLength(1);
  });

  test("an invalid regex body with valid flags is still dropped", () => {
    expect(parseModelPatterns(["/(/i", "/[/"])).toEqual([]);
  });

  test("drops non-string and empty entries", () => {
    expect(parseModelPatterns([1, null, {}, "", "!", "opus"])).toHaveLength(1);
  });

  test("a missing or non-array option gives []", () => {
    expect(parseModelPatterns(undefined)).toEqual([]);
    expect(parseModelPatterns("opus")).toEqual([]);
  });
});
