import { FINISH_REASON_MAP } from '../constants/openai.ts';
import { SSE_DATA_PREFIX } from '../constants/sse.ts';
import type { CacheUsage, ResponseIdentity, ResponseParsers } from '../models/cache.ts';
import { isRecord } from '../utils/is-record.ts';
import { num } from '../utils/num.ts';

/**
 * Maps a Chat Completions `usage` block into `CacheUsage`. Cache writes are
 * excluded from `prompt_tokens` only when `cache_creation_in_prompt === false`.
 */
function readOpenAiUsage(raw: unknown): CacheUsage | undefined {
  if (!isRecord(raw)) return undefined;
  const promptTokens = num(raw.prompt_tokens);
  if (promptTokens === undefined) return undefined;
  const details = isRecord(raw.prompt_tokens_details) ? raw.prompt_tokens_details : {};
  const read =
    num(details.cached_tokens) ??
    num(raw.cache_read_input_tokens) ??
    num(raw.prompt_cache_hit_tokens) ??
    num(raw.cached_tokens) ??
    0;
  const write = num(details.cache_write_tokens) ?? num(raw.cache_creation_input_tokens) ?? 0;
  const writeInPrompt = details.cache_creation_in_prompt === false ? 0 : write;
  return {
    cacheReadTokens: read,
    cacheWriteTokens: write,
    inputTokens: Math.max(0, promptTokens - read - writeInPrompt),
    write1hTokens: undefined,
    write5mTokens: undefined,
  };
}

function mapFinishReason(reason: unknown): string | undefined {
  return typeof reason === 'string' ? (FINISH_REASON_MAP[reason] ?? reason) : undefined;
}

function readFinishReason(body: unknown): string | undefined {
  if (!isRecord(body) || !Array.isArray(body.choices)) return undefined;
  const choice: unknown = body.choices[0];
  return isRecord(choice) ? mapFinishReason(choice.finish_reason) : undefined;
}

function readIdentity(body: unknown): ResponseIdentity | undefined {
  if (!isRecord(body)) return undefined;
  const model = typeof body.model === 'string' && body.model !== '' ? body.model : undefined;
  const provider =
    typeof body.provider === 'string' && body.provider !== '' ? body.provider : undefined;
  if (model === undefined && provider === undefined) return undefined;
  const out: ResponseIdentity = {};
  if (model !== undefined) out.model = model;
  if (provider !== undefined) out.provider = provider;
  return out;
}

/** Parsed JSON payload of every `data:` line; `[DONE]` and junk are skipped. */
function sseEvents(text: string): unknown[] {
  const events: unknown[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith(SSE_DATA_PREFIX)) continue;
    try {
      events.push(JSON.parse(line.slice(SSE_DATA_PREFIX.length).trim()));
    } catch {
      continue;
    }
  }
  return events;
}

/** Parses the `usage` block of a non-streaming Chat Completions body. */
function parseOpenAiUsageFromJson(body: unknown): CacheUsage | undefined {
  return isRecord(body) ? readOpenAiUsage(body.usage) : undefined;
}

/** The last chunk carrying `usage` wins (it is usually the final, choice-less chunk). */
function parseOpenAiUsageFromSse(text: string): CacheUsage | undefined {
  let usage: CacheUsage | undefined;
  for (const event of sseEvents(text)) {
    if (!isRecord(event)) continue;
    usage = readOpenAiUsage(event.usage) ?? usage;
  }
  return usage;
}

/** `choices[0].finish_reason` of a non-streaming body, with `tool_calls` normalised to `tool_use`. */
function parseOpenAiFinishReasonFromJson(body: unknown): string | undefined {
  return readFinishReason(body);
}

/** The last non-null `choices[0].finish_reason` of a stream. */
function parseOpenAiFinishReasonFromSse(text: string): string | undefined {
  let reason: string | undefined;
  for (const event of sseEvents(text)) reason = readFinishReason(event) ?? reason;
  return reason;
}

/** Top-level `model` and `provider` of a non-streaming body. */
function parseOpenAiIdentityFromJson(body: unknown): ResponseIdentity | undefined {
  return readIdentity(body);
}

/** `model` and `provider` of a stream; later chunks override earlier ones field by field. */
function parseOpenAiIdentityFromSse(text: string): ResponseIdentity | undefined {
  let merged: ResponseIdentity | undefined;
  for (const event of sseEvents(text)) {
    const identity = readIdentity(event);
    if (identity) merged = { ...merged, ...identity };
  }
  return merged;
}

/** The Chat Completions parsers for the response tee. */
const OPENAI_PARSERS: ResponseParsers = {
  fromJson: (body) => ({
    identity: parseOpenAiIdentityFromJson(body),
    stopReason: parseOpenAiFinishReasonFromJson(body),
    usage: parseOpenAiUsageFromJson(body),
  }),
  fromSse: (text) => ({
    identity: parseOpenAiIdentityFromSse(text),
    stopReason: parseOpenAiFinishReasonFromSse(text),
    usage: parseOpenAiUsageFromSse(text),
  }),
};

export {
  sseEvents,
  parseOpenAiUsageFromJson,
  parseOpenAiUsageFromSse,
  parseOpenAiFinishReasonFromJson,
  parseOpenAiFinishReasonFromSse,
  parseOpenAiIdentityFromJson,
  parseOpenAiIdentityFromSse,
  OPENAI_PARSERS,
};
