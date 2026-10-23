import { describe, expect, test } from "bun:test";
import { parseModelPatterns } from "../../src/config/model-patterns.ts";
import { matchModelPatterns } from "../../src/services/model-patterns.ts";

const ref = { providerID: "omniroute", id: "auto/opus-5" };

describe("parseModelPatterns", () => {
  test("drops an invalid regex", () => {
    expect(parseModelPatterns(["/(/", "opus"])).toHaveLength(1);
  });

  test("a /…/x string with invalid regex flags falls back to a substring match", () => {
    const patterns = parseModelPatterns(["/auto/opus"]);
    expect(patterns).toHaveLength(1);
    expect(matchModelPatterns(patterns, ref)).toBe("explicit");
    expect(matchModelPatterns(patterns, { providerID: "omniroute", id: "auto/haiku-5" })).toBeUndefined();
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
