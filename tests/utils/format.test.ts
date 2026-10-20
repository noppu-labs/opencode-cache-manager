import { describe, expect, test } from "bun:test";
import { formatRemaining } from "../../src/utils/format.ts";

const MIN = 60_000;

describe("formatRemaining", () => {
  test("minutes, seconds and hours", () => {
    expect(formatRemaining(3_120_000)).toBe("52m");
    expect(formatRemaining(3 * MIN)).toBe("3m");
    expect(formatRemaining(45_000)).toBe("45s");
    expect(formatRemaining(3_900_000)).toBe("1h 05m");
    expect(formatRemaining(2 * 3_600_000)).toBe("2h 00m");
  });

  test("clamps negative durations to zero seconds", () => {
    expect(formatRemaining(-5)).toBe("0s");
  });
});
