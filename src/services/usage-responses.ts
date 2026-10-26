import type { CacheUsage, ObservedResponse, OpenAiIdentity, ResponseParsers } from "../models/cache.ts";
import { isRecord } from "../utils/is-record.ts";
import { num } from "../utils/num.ts";
import { sseEvents } from "./usage-openai.ts";

const TERMINAL_EVENTS = new Set(["response.completed", "response.incomplete"]);
const TOOL_CALL_ITEMS = new Set(["function_call", "custom_tool_call"]);

/**
 * Maps a Responses `usage` block into `CacheUsage`. Like Chat Completions, writes count
 * inside `input_tokens`, so the uncached input is what is left after reads and writes.
 */
function readResponsesUsage(raw: unknown): CacheUsage | undefined {
  if (!isRecord(raw)) return undefined;
  const inputTokens = num(raw.input_tokens);
  if (inputTokens === undefined) return undefined;
  const details = isRecord(raw.input_tokens_details) ? raw.input_tokens_details : {};
  const read = num(details.cached_tokens) ?? 0;
  const write = num(details.cache_write_tokens) ?? 0;
  return {
    inputTokens: Math.max(0, inputTokens - read - write),
    cacheReadTokens: read,
    cacheWriteTokens: write,
    write5mTokens: undefined,
    write1hTokens: undefined,
  };
}

/** `completed` reads as `stop`, a trailing tool call as `tool_use`; any other status passes through. */
function readStopReason(response: Record<string, unknown>): string | undefined {
  const last: unknown = Array.isArray(response.output) ? response.output[response.output.length - 1] : undefined;
  if (isRecord(last) && typeof last.type === "string" && TOOL_CALL_ITEMS.has(last.type)) return "tool_use";
  if (typeof response.status !== "string") return undefined;
  return response.status === "completed" ? "stop" : response.status;
}

function readIdentity(response: Record<string, unknown>): OpenAiIdentity | undefined {
  return typeof response.model === "string" && response.model ? { model: response.model } : undefined;
}

function observe(response: unknown): ObservedResponse {
  if (!isRecord(response)) return {};
  return { usage: readResponsesUsage(response.usage), stopReason: readStopReason(response), identity: readIdentity(response) };
}

/** The final `response` of a stream event: `event.response` of `response.completed` / `response.incomplete`, or a bare response object. */
function terminalResponse(event: unknown): unknown {
  if (!isRecord(event)) return undefined;
  if (typeof event.type === "string") return TERMINAL_EVENTS.has(event.type) ? event.response : undefined;
  return isRecord(event.usage) ? event : undefined;
}

/** Response parsers for the OpenAI Responses wire: a body, or the `response.completed` event of a stream. */
export const RESPONSES_PARSERS: ResponseParsers = {
  fromJson: observe,
  fromSse(text) {
    let observed: ObservedResponse = {};
    for (const event of sseEvents(text)) {
      const response = terminalResponse(event);
      if (response !== undefined) observed = observe(response);
    }
    return observed;
  },
};
