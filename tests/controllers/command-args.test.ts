import { describe, expect, test } from "bun:test";
import { parseCommandArg } from "../../src/controllers/command-args.ts";

// ---------------------------------------------------------------------------
// parseCommandArg
// ---------------------------------------------------------------------------

describe("parseCommandArg", () => {
  test("parses mode arguments case-insensitively", () => {
    expect(parseCommandArg("5m")).toEqual({ type: "set", patch: { mode: "5m" } });
    expect(parseCommandArg("1h")).toEqual({ type: "set", patch: { mode: "1h" } });
    expect(parseCommandArg("hybrid")).toEqual({ type: "set", patch: { mode: "hybrid" } });
    expect(parseCommandArg("HyBrId")).toEqual({ type: "set", patch: { mode: "hybrid" } });
    expect(parseCommandArg("  1H  ")).toEqual({ type: "set", patch: { mode: "1h" } });
    expect(parseCommandArg("5M")).toEqual({ type: "set", patch: { mode: "5m" } });
  });

  test("parses status, reset and toggle", () => {
    expect(parseCommandArg("status")).toEqual({ type: "status" });
    expect(parseCommandArg(" STATUS ")).toEqual({ type: "status" });
    expect(parseCommandArg("reset")).toEqual({ type: "reset" });
    expect(parseCommandArg("Reset")).toEqual({ type: "reset" });
    expect(parseCommandArg("toggle")).toEqual({ type: "toggle" });
    expect(parseCommandArg("TOGGLE")).toEqual({ type: "toggle" });
  });

  test("empty input means toggle", () => {
    expect(parseCommandArg("")).toEqual({ type: "toggle" });
    expect(parseCommandArg("   ")).toEqual({ type: "toggle" });
  });

  test("parses keepalive on and off", () => {
    expect(parseCommandArg("keepalive on")).toEqual({ type: "set", patch: { keepalive: true } });
    expect(parseCommandArg("KEEPALIVE OFF")).toEqual({ type: "set", patch: { keepalive: false } });
    expect(parseCommandArg("keepalive   off")).toEqual({ type: "set", patch: { keepalive: false } });
    expect(parseCommandArg("keepalive maybe")).toEqual({ type: "invalid" });
    expect(parseCommandArg("keepalive")).toEqual({ type: "invalid" });
  });

  test("parses pings within 0..100", () => {
    expect(parseCommandArg("pings 3")).toEqual({ type: "set", patch: { maxPings: 3 } });
    expect(parseCommandArg("pings 0")).toEqual({ type: "set", patch: { maxPings: 0 } });
    expect(parseCommandArg("pings 100")).toEqual({ type: "set", patch: { maxPings: 100 } });
    expect(parseCommandArg("pings 101")).toEqual({ type: "invalid" });
    expect(parseCommandArg("pings -1")).toEqual({ type: "invalid" });
    expect(parseCommandArg("pings 2.5")).toEqual({ type: "invalid" });
    expect(parseCommandArg("pings many")).toEqual({ type: "invalid" });
    expect(parseCommandArg("pings")).toEqual({ type: "invalid" });
  });

  test("parses min as an integer or a k-suffixed integer", () => {
    expect(parseCommandArg("min 20000")).toEqual({ type: "set", patch: { minContextTokens: 20000 } });
    expect(parseCommandArg("min 50k")).toEqual({ type: "set", patch: { minContextTokens: 50000 } });
    expect(parseCommandArg("MIN 50K")).toEqual({ type: "set", patch: { minContextTokens: 50000 } });
    expect(parseCommandArg("min 0")).toEqual({ type: "set", patch: { minContextTokens: 0 } });
    expect(parseCommandArg("min -5")).toEqual({ type: "invalid" });
    expect(parseCommandArg("min 1.5k")).toEqual({ type: "invalid" });
    expect(parseCommandArg("min k")).toEqual({ type: "invalid" });
    expect(parseCommandArg("min")).toEqual({ type: "invalid" });
  });

  test("unknown input is invalid", () => {
    expect(parseCommandArg("banana")).toEqual({ type: "invalid" });
    expect(parseCommandArg("5")).toEqual({ type: "invalid" });
    expect(parseCommandArg("1hour")).toEqual({ type: "invalid" });
    expect(parseCommandArg("1h extra")).toEqual({ type: "invalid" });
  });

  test("parses the PromptInput.Prompt object shape", () => {
    expect(parseCommandArg({ text: "1h" })).toEqual({ type: "set", patch: { mode: "1h" } });
    expect(parseCommandArg({ text: "  status " })).toEqual({ type: "status" });
    expect(parseCommandArg({ text: "" })).toEqual({ type: "toggle" });
    expect(parseCommandArg({ text: "nonsense" })).toEqual({ type: "invalid" });
    expect(parseCommandArg({ text: "pings 4", files: [] })).toEqual({
      type: "set",
      patch: { maxPings: 4 },
    });
  });

  test("parses arrays of { text } parts joined by spaces", () => {
    expect(parseCommandArg([{ text: "1h" }])).toEqual({ type: "set", patch: { mode: "1h" } });
    expect(parseCommandArg([{ text: "keepalive" }, { text: "off" }])).toEqual({
      type: "set",
      patch: { keepalive: false },
    });
    expect(parseCommandArg([])).toEqual({ type: "toggle" });
    expect(parseCommandArg([{ text: "nope" }])).toEqual({ type: "invalid" });
  });

  test("handles unexpected shapes without throwing", () => {
    expect(parseCommandArg(undefined)).toEqual({ type: "toggle" });
    expect(parseCommandArg(null)).toEqual({ type: "toggle" });
    expect(parseCommandArg(42)).toEqual({ type: "toggle" });
    expect(parseCommandArg({ foo: "bar" })).toEqual({ type: "toggle" });
  });
});
