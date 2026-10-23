import { describe, expect, test } from "bun:test";
import { parseCacheProfiles } from "../../src/config/model-patterns.ts";
import { matchProfilePatterns } from "../../src/services/model-patterns.ts";

const ref = { providerID: "omniroute", id: "auto/opus-5" };

describe("matchProfilePatterns", () => {
  test("a plain string is a case-insensitive substring match", () => {
    expect(matchProfilePatterns(parseCacheProfiles({ OPUS: "anthropic" }), ref)).toBe("anthropic");
  });

  test("a /…/flags string is a regex", () => {
    expect(matchProfilePatterns(parseCacheProfiles({ "/^omniroute\\/auto\\//i": "anthropic" }), ref)).toBe("anthropic");
  });

  test("the profile value decides the result", () => {
    const gpt = { providerID: "openai", id: "gpt-6" };
    expect(matchProfilePatterns(parseCacheProfiles({ gpt: "implicit" }), gpt)).toBe("implicit");
    expect(matchProfilePatterns(parseCacheProfiles({ gpt: "openai" }), gpt)).toBe("openai");
  });

  test("a regex pattern can map to implicit", () => {
    expect(matchProfilePatterns(parseCacheProfiles({ "/opus/": "implicit" }), ref)).toBe("implicit");
  });

  test("the key is <providerID>/<id>", () => {
    expect(matchProfilePatterns(parseCacheProfiles({ "omniroute/auto": "openai" }), ref)).toBe("openai");
  });

  test("the first matching pattern wins", () => {
    expect(matchProfilePatterns(parseCacheProfiles({ opus: "implicit", omniroute: "anthropic" }), ref)).toBe("implicit");
    expect(matchProfilePatterns(parseCacheProfiles({ omniroute: "anthropic", opus: "implicit" }), ref)).toBe("anthropic");
  });

  test("a global regex pattern matches repeatedly", () => {
    const patterns = parseCacheProfiles({ "/opus/g": "anthropic" });
    expect(matchProfilePatterns(patterns, ref)).toBe("anthropic");
    expect(matchProfilePatterns(patterns, ref)).toBe("anthropic");
  });

  test("no match returns undefined", () => {
    expect(matchProfilePatterns(parseCacheProfiles({ haiku: "anthropic" }), ref)).toBeUndefined();
    expect(matchProfilePatterns([], ref)).toBeUndefined();
  });

  test("a /…/x string with invalid regex flags falls back to a substring match", () => {
    const patterns = parseCacheProfiles({ "/auto/opus": "anthropic" });
    expect(patterns).toHaveLength(1);
    expect(matchProfilePatterns(patterns, ref)).toBe("anthropic");
    expect(matchProfilePatterns(patterns, { providerID: "omniroute", id: "auto/haiku-5" })).toBeUndefined();
  });
});
