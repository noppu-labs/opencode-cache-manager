import { describe, expect, test } from "bun:test";
import { matchModelPatterns, parseModelPatterns } from "../../src/services/model-patterns.ts";

const ref = { providerID: "omniroute", id: "auto/opus-5" };

describe("matchModelPatterns", () => {
  test("a plain string is a case-insensitive substring match", () => {
    expect(matchModelPatterns(parseModelPatterns(["OPUS"]), ref)).toBe("explicit");
  });

  test("a /…/flags string is a regex", () => {
    expect(matchModelPatterns(parseModelPatterns(["/^omniroute\\/auto\\//i"]), ref)).toBe("explicit");
  });

  test("a leading ! forces implicit", () => {
    const gpt = { providerID: "openai", id: "gpt-6" };
    expect(matchModelPatterns(parseModelPatterns(["!gpt"]), gpt)).toBe("implicit");
  });

  test("a leading ! also works on a regex", () => {
    expect(matchModelPatterns(parseModelPatterns(["!/opus/"]), ref)).toBe("implicit");
  });

  test("the first matching pattern wins", () => {
    expect(matchModelPatterns(parseModelPatterns(["!opus", "omniroute"]), ref)).toBe("implicit");
    expect(matchModelPatterns(parseModelPatterns(["omniroute", "!opus"]), ref)).toBe("explicit");
  });

  test("no match returns undefined", () => {
    expect(matchModelPatterns(parseModelPatterns(["haiku"]), ref)).toBeUndefined();
    expect(matchModelPatterns([], ref)).toBeUndefined();
  });
});

describe("parseModelPatterns", () => {
  test("drops an invalid regex", () => {
    expect(parseModelPatterns(["/(/", "opus"])).toHaveLength(1);
  });

  test("drops non-string and empty entries", () => {
    expect(parseModelPatterns([1, null, {}, "", "!", "opus"])).toHaveLength(1);
  });

  test("a missing or non-array option gives []", () => {
    expect(parseModelPatterns(undefined)).toEqual([]);
    expect(parseModelPatterns("opus")).toEqual([]);
  });
});
