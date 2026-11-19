import { isRecord } from '../utils/is-record.ts';

type Rec = Record<string, unknown>;

const isInputText = (part: unknown): part is Rec =>
  isRecord(part) && part.type === 'input_text' && typeof part.text === 'string' && part.text !== '';

const findLastInputText = (parts: unknown[]): Rec | undefined =>
  parts.findLast((part): part is Rec => isInputText(part));

const isMessageItem = (item: Rec): boolean =>
  item.type === 'message' || (item.type === undefined && typeof item.role === 'string');

/** The last `input_text` part of a Responses `input` message; user string content becomes parts first. */
function lastInputTextPart(item: Rec): Rec | undefined {
  if (!isMessageItem(item)) return undefined;
  const { content } = item;
  if (typeof content === 'string') {
    if (content === '' || item.role === 'assistant') return undefined;
    const part: Rec = { text: content, type: 'input_text' };
    item.content = [part];
    return part;
  }
  return Array.isArray(content) ? findLastInputText(content) : undefined;
}

const isPrefixMessage = (item: unknown): item is Rec =>
  isRecord(item) && isMessageItem(item) && (item.role === 'developer' || item.role === 'system');

/**
 * The `input_text` part that carries the hybrid breakpoint, at the end of the system prompt.
 * OpenCode >= 2.3.2 sends the system prompt as a leading developer message, possibly after
 * `additional_tools` items; older bodies use `instructions`, which can't carry a breakpoint,
 * so their first item stands in.
 */
function responsesPrefixText(body: Rec): Rec | undefined {
  const { input } = body;
  if (!Array.isArray(input)) return undefined;
  const start = input.findIndex(
    (item: unknown) => !(isRecord(item) && item.type === 'additional_tools')
  );
  if (start === -1) return undefined;
  const first: unknown = input[start];
  if (!isPrefixMessage(first)) return isRecord(first) ? lastInputTextPart(first) : undefined;
  let end = start;
  while (end < input.length && isPrefixMessage(input[end])) end++;
  for (let index = end - 1; index >= start; index--) {
    const item: unknown = input[index];
    const part = isRecord(item) ? lastInputTextPart(item) : undefined;
    if (part) return part;
  }
  return undefined;
}

/**
 * The last `input_text` part of a `function_call_output` item; string `output` becomes parts first.
 * Probe: a breakpoint on such a part is honoured, while one on the item itself is ignored.
 */
function toolOutputTextPart(item: Rec): Rec | undefined {
  if (item.type !== 'function_call_output') return undefined;
  const { output } = item;
  if (typeof output === 'string') {
    if (output === '') return undefined;
    const part: Rec = { text: output, type: 'input_text' };
    item.output = [part];
    return part;
  }
  return Array.isArray(output) ? findLastInputText(output) : undefined;
}

/** The last `input_text` part of a message or tool output in the body, skipping items without one (tool calls, assistant output). */
function lastInputText(body: Rec): Rec | undefined {
  if (!Array.isArray(body.input)) return undefined;
  for (let index = body.input.length - 1; index >= 0; index--) {
    const item: unknown = body.input[index];
    const part = isRecord(item) ? (lastInputTextPart(item) ?? toolOutputTextPart(item)) : undefined;
    if (part) return part;
  }
  return undefined;
}

export { lastInputTextPart, responsesPrefixText, toolOutputTextPart, lastInputText };
