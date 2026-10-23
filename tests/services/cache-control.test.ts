import { describe, expect, test } from "bun:test";
import { applyTtlToBlock, hasOneHourCacheControl } from "../../src/services/cache-control.ts";

describe("applyTtlToBlock", () => {
  test("sets 1h on an ephemeral block and reports the change once", () => {
    const block: { cache_control: Record<string, unknown> } = { cache_control: { type: "ephemeral" } };
    expect(applyTtlToBlock(block, "1h")).toBe(true);
    expect(block.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(applyTtlToBlock(block, "1h")).toBe(false);
  });

  test("removes the ttl when undefined", () => {
    const block: { cache_control: Record<string, unknown> } = { cache_control: { type: "ephemeral", ttl: "1h" } };
    expect(applyTtlToBlock(block, undefined)).toBe(true);
    expect(block.cache_control).toEqual({ type: "ephemeral" });
    expect(applyTtlToBlock(block, undefined)).toBe(false);
  });

  test("ignores non-ephemeral cache_control and non-objects", () => {
    const block = { cache_control: { type: "persistent", ttl: "9h" } };
    expect(applyTtlToBlock(block, "1h")).toBe(false);
    expect(applyTtlToBlock(block, undefined)).toBe(false);
    expect(block.cache_control).toEqual({ type: "persistent", ttl: "9h" });
    expect(applyTtlToBlock(null, "1h")).toBe(false);
    expect(applyTtlToBlock("x", "1h")).toBe(false);
  });
});

describe("hasOneHourCacheControl", () => {
  const oneHour = { type: "ephemeral", ttl: "1h" };

  test("finds a 1h breakpoint on a tool, nested tool, system block, message or part", () => {
    expect(hasOneHourCacheControl({ tools: [{ cache_control: oneHour }] })).toBe(true);
    expect(hasOneHourCacheControl({ tools: [{ tools: [{ cache_control: oneHour }] }] })).toBe(true);
    expect(hasOneHourCacheControl({ system: [{ cache_control: oneHour }] })).toBe(true);
    expect(hasOneHourCacheControl({ messages: [{ cache_control: oneHour }] })).toBe(true);
    expect(hasOneHourCacheControl({ messages: [{ content: [{ cache_control: oneHour }] }] })).toBe(true);
  });

  test("is false for 5m breakpoints and empty bodies", () => {
    expect(hasOneHourCacheControl({})).toBe(false);
    expect(hasOneHourCacheControl({ tools: [{ cache_control: { type: "ephemeral" } }] })).toBe(false);
  });
});
