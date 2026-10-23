import { isRecord } from "../utils/is-record.ts";

type Rec = Record<string, unknown>;

const BREAKPOINT = "prompt_cache_breakpoint";

const isInputText = (part: unknown): part is Rec =>
  isRecord(part) && part.type === "input_text" && typeof part.text === "string" && part.text !== "";

const isMessageItem = (item: Rec): boolean =>
  item.type === "message" || (item.type === undefined && typeof item.role === "string");

/** The last `input_text` part of a Responses `input` message; user string content becomes parts first. */
export function lastInputTextPart(item: Rec): Rec | undefined {
  if (!isMessageItem(item)) return undefined;
  const { content } = item;
  if (typeof content === "string") {
    if (content === "" || item.role === "assistant") return undefined;
    const part: Rec = { type: "input_text", text: content };
    item.content = [part];
    return part;
  }
  return Array.isArray(content) ? content.findLast(isInputText) : undefined;
}

/** The first `input` item of a Responses body. */
export function firstInputItem(body: Rec): Rec | undefined {
  if (!Array.isArray(body.input)) return undefined;
  const first: unknown = body.input[0];
  return isRecord(first) ? first : undefined;
}

/**
 * The last `input_text` part of a `function_call_output` item; string `output` becomes parts first.
 * Probe: a breakpoint on such a part is honoured, while one on the item itself is ignored.
 */
export function toolOutputTextPart(item: Rec): Rec | undefined {
  if (item.type !== "function_call_output") return undefined;
  const { output } = item;
  if (typeof output === "string") {
    if (output === "") return undefined;
    const part: Rec = { type: "input_text", text: output };
    item.output = [part];
    return part;
  }
  return Array.isArray(output) ? output.findLast(isInputText) : undefined;
}

/** The last `input_text` part of a message or tool output in the body, skipping items without one (tool calls, assistant output). */
export function lastInputText(body: Rec): Rec | undefined {
  if (!Array.isArray(body.input)) return undefined;
  for (let index = body.input.length - 1; index >= 0; index--) {
    const item: unknown = body.input[index];
    const part = isRecord(item) ? (lastInputTextPart(item) ?? toolOutputTextPart(item)) : undefined;
    if (part) return part;
  }
  return undefined;
}

function stripFrom(node: unknown, keep: Rec | undefined): boolean {
  if (!isRecord(node) || node === keep || !(BREAKPOINT in node)) return false;
  delete node[BREAKPOINT];
  return true;
}

/** Removes `prompt_cache_breakpoint` from tools, chat messages and parts, and Responses items, parts and tool output parts, except on `keep`. */
export function stripBreakpoints(body: Rec, keep?: Rec): boolean {
  let changed = false;
  const visit = (node: unknown): void => {
    changed = stripFrom(node, keep) || changed;
    if (!isRecord(node)) return;
    for (const parts of [node.content, node.output]) {
      if (Array.isArray(parts)) for (const part of parts) changed = stripFrom(part, keep) || changed;
    }
  };
  for (const key of ["tools", "messages", "input"]) {
    const list = body[key];
    if (Array.isArray(list)) list.forEach(visit);
  }
  return changed;
}
