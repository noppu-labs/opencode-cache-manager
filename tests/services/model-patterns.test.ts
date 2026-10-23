import { describe, expect, test } from "bun:test";
import { parseModelPatterns } from "../../src/config/model-patterns.ts";
import { matchModelPatterns } from "../../src/services/model-patterns.ts";

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

describe("parseModelPatterns with matchModelPatterns", () => {
  test("a /…/x string with invalid regex flags falls back to a substring match", () => {
    const patterns = parseModelPatterns(["/auto/opus"]);
    expect(patterns).toHaveLength(1);
    expect(matchModelPatterns(patterns, ref)).toBe("explicit");
    expect(matchModelPatterns(patterns, { providerID: "omniroute", id: "auto/haiku-5" })).toBeUndefined();
  });
});
