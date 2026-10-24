import { describe, expect, test } from "bun:test";
import { stripBreakpoints } from "../../src/services/openai-breakpoints.ts";

type Rec = Record<string, unknown>;

const message = (role: string, content: unknown): Rec => ({ type: "message", role, content });
const inputText = (text: string, extra: Rec = {}): Rec => ({ type: "input_text", text, ...extra });
const BP = { mode: "explicit", ttl: "12h" };

describe("stripBreakpoints", () => {
  test("removes breakpoints from chat messages, responses input, and their parts", () => {
    const body: Rec = {
      messages: [
        { role: "user", prompt_cache_breakpoint: BP, content: [{ type: "text", text: "a", prompt_cache_breakpoint: BP }] },
      ],
      input: [
        message("user", [inputText("b", { prompt_cache_breakpoint: BP })]),
        { ...message("user", "c"), prompt_cache_breakpoint: BP },
      ],
      tools: [{ type: "function", prompt_cache_breakpoint: BP }],
    };
    expect(stripBreakpoints(body)).toBe(true);
    expect(JSON.stringify(body)).not.toContain("prompt_cache_breakpoint");
  });

  test("keeps the given part and reports false when nothing else was removed", () => {
    const keep = inputText("b", { prompt_cache_breakpoint: BP });
    const body: Rec = { input: [message("user", [keep])] };
    expect(stripBreakpoints(body, keep)).toBe(false);
    expect(keep.prompt_cache_breakpoint).toEqual(BP);
  });

  test("keeps the given part but strips every other breakpoint", () => {
    const keep = inputText("b", { prompt_cache_breakpoint: BP });
    const other = inputText("a", { prompt_cache_breakpoint: BP });
    const body: Rec = { input: [message("user", [other]), message("user", [keep])] };
    expect(stripBreakpoints(body, keep)).toBe(true);
    expect(other).not.toHaveProperty("prompt_cache_breakpoint");
    expect(keep.prompt_cache_breakpoint).toEqual(BP);
  });

  test("removes breakpoints from tool output parts", () => {
    const body: Rec = {
      input: [{ type: "function_call_output", call_id: "c", output: [inputText("x", { prompt_cache_breakpoint: BP })] }],
    };
    expect(stripBreakpoints(body)).toBe(true);
    expect(body.input).toEqual([{ type: "function_call_output", call_id: "c", output: [inputText("x")] }]);
  });

  test("returns false for bodies without breakpoints", () => {
    expect(stripBreakpoints({ messages: [{ role: "user", content: "x" }], input: [message("user", "y")] })).toBe(false);
    expect(stripBreakpoints({})).toBe(false);
  });
});
