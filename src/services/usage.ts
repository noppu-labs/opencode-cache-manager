import type { CacheUsage, ResponseParsers, Ttl } from '../models/cache.ts';
import { isRecord } from '../utils/is-record.ts';
import { num } from '../utils/num.ts';

/** Total prompt size: uncached input plus cache reads plus cache writes. */
function contextTokens(u: CacheUsage): number {
  return u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
}

function hasCacheActivity(u: CacheUsage): boolean {
  return u.cacheReadTokens + u.cacheWriteTokens > 0;
}

/**
 * The TTL the response was actually billed at. Any 5m write wins because a
 * request with a 5m breakpoint expires its tail at 5m; `undefined` when there
 * was no write or no breakdown.
 */
function grantedTtl(u: CacheUsage): Ttl | undefined {
  if ((u.write5mTokens ?? 0) > 0) return '5m';
  if ((u.write1hTokens ?? 0) > 0) return '1h';
  return undefined;
}

type PartialUsage = Partial<CacheUsage>;

/** Reads only the fields actually present so later events can override selectively. */
function readUsage(raw: unknown): PartialUsage | undefined {
  if (!isRecord(raw)) return undefined;
  const out: PartialUsage = {
    inputTokens: num(raw.input_tokens),
    cacheReadTokens: num(raw.cache_read_input_tokens),
    cacheWriteTokens: num(raw.cache_creation_input_tokens),
  };
  if (isRecord(raw.cache_creation)) {
    out.write5mTokens = num(raw.cache_creation.ephemeral_5m_input_tokens) ?? 0;
    out.write1hTokens = num(raw.cache_creation.ephemeral_1h_input_tokens) ?? 0;
  }
  return out;
}

function finalize(partial: PartialUsage): CacheUsage {
  return {
    inputTokens: partial.inputTokens ?? 0,
    cacheReadTokens: partial.cacheReadTokens ?? 0,
    cacheWriteTokens: partial.cacheWriteTokens ?? 0,
    write5mTokens: partial.write5mTokens,
    write1hTokens: partial.write1hTokens,
  };
}

/** Parses the `usage` block of a non-streaming Messages response body. */
function parseUsageFromJson(body: unknown): CacheUsage | undefined {
  if (!isRecord(body)) return undefined;
  const partial = readUsage(body.usage);
  return partial && finalize(partial);
}

/**
 * Parses a streamed Messages response: `message_start` carries the prompt
 * usage and `message_delta` updates the fields it reports.
 */
function parseUsageFromSse(text: string): CacheUsage | undefined {
  let merged: PartialUsage | undefined;

  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    let event: unknown;
    try {
      event = JSON.parse(line.slice(5).trim());
    } catch {
      continue;
    }
    if (!isRecord(event)) continue;

    const raw =
      event.type === 'message_start' && isRecord(event.message)
        ? event.message.usage
        : event.type === 'message_delta'
          ? event.usage
          : undefined;
    const partial = readUsage(raw);
    if (!partial) continue;

    merged ??= {};
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `partial` is built by readUsage, so its keys are exactly PartialUsage's
    for (const key of Object.keys(partial) as (keyof PartialUsage)[]) {
      if (partial[key] !== undefined) merged[key] = partial[key];
    }
  }

  return merged && finalize(merged);
}

/** The top-level `stop_reason` of a non-streaming Messages response. */
function parseStopReasonFromJson(body: unknown): string | undefined {
  return isRecord(body) && typeof body.stop_reason === 'string' ? body.stop_reason : undefined;
}

/** The last `message_delta.delta.stop_reason` of a streamed Messages response. */
function parseStopReasonFromSse(text: string): string | undefined {
  let stopReason: string | undefined;
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try {
      const event: unknown = JSON.parse(line.slice(5).trim());
      if (isRecord(event) && event.type === 'message_delta' && isRecord(event.delta)) {
        const reason = event.delta.stop_reason;
        if (typeof reason === 'string') stopReason = reason;
      }
    } catch {
      continue;
    }
  }
  return stopReason;
}

/** The top-level `model` of a non-streaming Messages response. */
function parseModelFromJson(body: unknown): string | undefined {
  return isRecord(body) && typeof body.model === 'string' && body.model !== ''
    ? body.model
    : undefined;
}

/** The `message.model` of the first `message_start` event of a streamed Messages response. */
function parseModelFromSse(text: string): string | undefined {
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try {
      const event: unknown = JSON.parse(line.slice(5).trim());
      if (isRecord(event) && event.type === 'message_start' && isRecord(event.message)) {
        const model = event.message.model;
        if (typeof model === 'string' && model !== '') return model;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

/** The Anthropic Messages parsers; the wire reports the resolved model but no provider. */
const ANTHROPIC_PARSERS: ResponseParsers = {
  fromJson: (body) => {
    const model = parseModelFromJson(body);
    return {
      usage: parseUsageFromJson(body),
      stopReason: parseStopReasonFromJson(body),
      identity: model === undefined ? undefined : { model },
    };
  },
  fromSse: (text) => {
    const model = parseModelFromSse(text);
    return {
      usage: parseUsageFromSse(text),
      stopReason: parseStopReasonFromSse(text),
      identity: model === undefined ? undefined : { model },
    };
  },
};

export {
  contextTokens,
  hasCacheActivity,
  grantedTtl,
  parseUsageFromJson,
  parseUsageFromSse,
  parseStopReasonFromJson,
  parseStopReasonFromSse,
  parseModelFromJson,
  parseModelFromSse,
  ANTHROPIC_PARSERS,
};
