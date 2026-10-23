import { describe, expect, test } from "bun:test";
import {
  firstInputItem,
  lastInputText,
  lastInputTextPart,
  toolOutputTextPart,
} from "../../src/services/openai-responses-cache.ts";

type Rec = Record<string, unknown>;

const message = (role: string, content: unknown): Rec => ({ type: "message", role, content });
const inputText = (text: string, extra: Rec = {}): Rec => ({ type: "input_text", text, ...extra });

describe("lastInputTextPart", () => {
  test("returns the last input_text part of an array", () => {
    const first = inputText("a");
    const last = inputText("b");
    const item = message("user", [first, { type: "input_image", image_url: "x" }, last]);
    expect(lastInputTextPart(item)).toBe(last);
  });

  test("turns string content into an input_text part", () => {
    const item = message("user", "hello");
    const part = lastInputTextPart(item);
    expect(part).toEqual({ type: "input_text", text: "hello" });
    expect(item.content).toEqual([{ type: "input_text", text: "hello" }]);
    expect(item.content).toEqual([part]);
  });

  test("leaves empty string content alone", () => {
    const item = message("user", "");
    expect(lastInputTextPart(item)).toBeUndefined();
    expect(item.content).toBe("");
  });

  test("ignores output_text and empty input_text parts", () => {
    expect(lastInputTextPart(message("assistant", [{ type: "output_text", text: "x" }]))).toBeUndefined();
    expect(lastInputTextPart(message("user", [inputText("")]))).toBeUndefined();
  });

  test("does not turn assistant string content into input_text", () => {
    const item = message("assistant", "hi");
    expect(lastInputTextPart(item)).toBeUndefined();
    expect(item.content).toBe("hi");
  });

  test("skips items that are not messages", () => {
    expect(lastInputTextPart({ type: "function_call_output", call_id: "c", output: "x" })).toBeUndefined();
    expect(lastInputTextPart({ type: "reasoning", content: [inputText("x")] })).toBeUndefined();
  });

  test("accepts a role-only item without a type", () => {
    expect(lastInputTextPart({ role: "user", content: "hi" })).toEqual({ type: "input_text", text: "hi" });
  });
});

describe("lastInputText", () => {
  test("walks back past items without input text", () => {
    const target = inputText("question");
    const body: Rec = {
      input: [
        message("user", [target]),
        message("assistant", [{ type: "output_text", text: "a" }]),
        { type: "function_call", call_id: "c", name: "read", arguments: "{}" },
        { type: "function_call_output", call_id: "c", output: "" },
      ],
    };
    expect(lastInputText(body)).toBe(target);
  });

  test("lands on a trailing tool output, turning string output into an input_text part", () => {
    const body: Rec = {
      input: [
        message("user", [inputText("question")]),
        { type: "function_call", call_id: "c", name: "read", arguments: "{}" },
        { type: "function_call_output", call_id: "c", output: "file contents" },
        message("assistant", [{ type: "output_text", text: "a" }]),
      ],
    };
    const part = lastInputText(body);
    expect(part).toEqual({ type: "input_text", text: "file contents" });
    expect(body.input).toEqual([
      message("user", [inputText("question")]),
      { type: "function_call", call_id: "c", name: "read", arguments: "{}" },
      { type: "function_call_output", call_id: "c", output: [{ type: "input_text", text: "file contents" }] },
      message("assistant", [{ type: "output_text", text: "a" }]),
    ]);
  });

  test("is undefined without an input array or usable items", () => {
    expect(lastInputText({})).toBeUndefined();
    expect(lastInputText({ input: "plain" })).toBeUndefined();
    expect(lastInputText({ input: [] })).toBeUndefined();
  });
});

describe("toolOutputTextPart", () => {
  test("returns the last input_text part of an output array", () => {
    const last = inputText("b");
    const item: Rec = { type: "function_call_output", call_id: "c", output: [inputText("a"), { type: "input_image", image_url: "x" }, last] };
    expect(toolOutputTextPart(item)).toBe(last);
  });

  test("turns string output into an input_text part", () => {
    const item: Rec = { type: "function_call_output", call_id: "c", output: "done" };
    const part = toolOutputTextPart(item);
    expect(item).toEqual({ type: "function_call_output", call_id: "c", output: [{ type: "input_text", text: "done" }] });
    expect(item.output).toEqual([part]);
  });

  test("ignores other items, empty output and arrays without input text", () => {
    expect(toolOutputTextPart(message("user", "hi"))).toBeUndefined();
    const empty: Rec = { type: "function_call_output", call_id: "c", output: "" };
    expect(toolOutputTextPart(empty)).toBeUndefined();
    expect(empty.output).toBe("");
    expect(toolOutputTextPart({ type: "function_call_output", output: [inputText("")] })).toBeUndefined();
  });
});

describe("firstInputItem", () => {
  test("returns the first input item", () => {
    const first = message("developer", "sys");
    expect(firstInputItem({ input: [first, message("user", "u")] })).toBe(first);
  });

  test("is undefined without an input array, when empty, or when the first entry is not a record", () => {
    expect(firstInputItem({})).toBeUndefined();
    expect(firstInputItem({ input: "plain" })).toBeUndefined();
    expect(firstInputItem({ input: [] })).toBeUndefined();
    expect(firstInputItem({ input: ["x"] })).toBeUndefined();
  });
});
