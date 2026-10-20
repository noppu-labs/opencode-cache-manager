import { describe, expect, test } from "bun:test";
import { BUILTIN_DEFAULTS, mergeSettings, sanitizePatch, settingsFromOptions } from "../../src/config/settings.ts";

describe("mergeSettings", () => {
  test("no layers yields the built-in defaults", () => {
    expect(mergeSettings()).toEqual(BUILTIN_DEFAULTS);
    expect(BUILTIN_DEFAULTS).toEqual({
      mode: "5m",
      keepalive: true,
      maxPings: 5,
      minContextTokens: 50_000,
    });
  });

  test("later layers win field by field", () => {
    expect(mergeSettings({ maxPings: 3 }, { maxPings: 7 }).maxPings).toBe(7);
    const merged = mergeSettings({ mode: "1h", maxPings: 3 }, { maxPings: 7 });
    expect(merged.mode).toBe("1h");
    expect(merged.keepalive).toBe(true);
  });
});

describe("sanitizePatch", () => {
  test("keeps valid fields", () => {
    const patch = { mode: "hybrid", keepalive: false, maxPings: 0, minContextTokens: 0 };
    expect(sanitizePatch(patch)).toEqual(patch);
  });

  test("drops invalid fields and unknown keys", () => {
    expect(
      sanitizePatch({
        mode: "2h",
        keepalive: "yes",
        maxPings: 101,
        minContextTokens: -1,
        extra: 1,
      }),
    ).toEqual({});
    expect(sanitizePatch({ maxPings: 1.5 })).toEqual({});
    expect(sanitizePatch({ maxPings: -1 })).toEqual({});
    expect(sanitizePatch({ minContextTokens: 1.5 })).toEqual({});
  });

  test("non-objects yield an empty patch", () => {
    expect(sanitizePatch(undefined)).toEqual({});
    expect(sanitizePatch(null)).toEqual({});
    expect(sanitizePatch("1h")).toEqual({});
    expect(sanitizePatch([])).toEqual({});
  });
});

describe("settingsFromOptions", () => {
  test("maps every option field", () => {
    expect(
      settingsFromOptions({
        defaultMode: "1h",
        keepalive: { enabled: false, maxPings: 2, minContextTokens: 20000 },
      }),
    ).toEqual({ mode: "1h", keepalive: false, maxPings: 2, minContextTokens: 20000 });
  });

  test("drops invalid values", () => {
    expect(
      settingsFromOptions({
        defaultMode: "2h",
        keepalive: { enabled: "x", maxPings: -1, minContextTokens: "x" },
      }),
    ).toEqual({});
    expect(settingsFromOptions({ keepalive: { maxPings: "x" } })).toEqual({});
  });

  test("tolerates missing or malformed options", () => {
    expect(settingsFromOptions(undefined)).toEqual({});
    expect(settingsFromOptions(null)).toEqual({});
    expect(settingsFromOptions({ keepalive: "on" })).toEqual({});
  });
});
