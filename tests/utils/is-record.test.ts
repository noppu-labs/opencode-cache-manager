import { describe, expect, test } from "bun:test";
import { isRecord } from "../../src/utils/is-record.ts";

describe("isRecord", () => {
  test("accepts plain objects", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
  });

  test("rejects null", () => {
    expect(isRecord(null)).toBe(false);
  });

  test("rejects arrays", () => {
    expect(isRecord([])).toBe(false);
    expect(isRecord([{ a: 1 }])).toBe(false);
  });

  test("rejects primitives and undefined", () => {
    for (const value of [undefined, "text", 1, true, Symbol("s"), 1n]) {
      expect(isRecord(value)).toBe(false);
    }
  });

  test("rejects functions", () => {
    expect(isRecord(() => {})).toBe(false);
  });
});
