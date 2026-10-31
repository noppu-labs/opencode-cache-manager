import fc from 'fast-check';

import { EXTENDED_CACHE_BETA } from '../../src/constants/anthropic.ts';
import type { CacheTtlMode, CacheUsage, Ttl, Wire } from '../../src/models/cache.ts';
import type { RequestKind } from '../../src/models/keepalive.ts';
import type { LedgerTotals, ModelPrice } from '../../src/models/savings.ts';

type Rec = Record<string, unknown>;

const ROLES = ['system', 'developer', 'user', 'assistant', 'tool'] as const;

const mode = fc.constantFrom<CacheTtlMode>('5m', '1h', 'hybrid');
const kind = fc.constantFrom<RequestKind>('primary', 'compaction', 'title', 'generate');
const wire = fc.constantFrom<Wire>('anthropic-messages', 'openai-chat', 'openai-responses');
const openaiWire = fc.constantFrom<Wire>('openai-chat', 'openai-responses');

const text = fc.string({ maxLength: 8 });

/** Ephemeral with or without a TTL, or arbitrary JSON the rewrites must leave alone. */
const cacheControl: fc.Arbitrary<unknown> = fc.oneof(
  fc
    .constantFrom(undefined, '5m', '1h', '2h')
    .map((ttl) => (ttl === undefined ? { type: 'ephemeral' } : { ttl, type: 'ephemeral' })),
  fc.jsonValue()
);

const breakpoint: fc.Arbitrary<unknown> = fc.oneof(
  fc.constant(null).map(() => ({ mode: 'explicit', ttl: '12h' })),
  fc.jsonValue()
);

const optionalKey = (key: string, arb: fc.Arbitrary<unknown>): fc.Arbitrary<Rec> =>
  fc.option(arb, { nil: undefined }).map((value) => (value === undefined ? {} : { [key]: value }));

/** Adds an optional `cache_control` and `prompt_cache_breakpoint` to a block. */
const decorate = (block: fc.Arbitrary<Rec>): fc.Arbitrary<Rec> =>
  fc
    .tuple(
      block,
      optionalKey('cache_control', cacheControl),
      optionalKey('prompt_cache_breakpoint', breakpoint)
    )
    .map(([base, cc, bp]) => ({ ...base, ...cc, ...bp }));

const textPart = decorate(fc.record({ text, type: fc.constant('text') }));
const inputTextPart = decorate(fc.record({ text, type: fc.constant('input_text') }));
const otherPart = decorate(
  fc.record({ id: text, type: fc.constantFrom('image', 'tool_use', 'tool_result') })
);

const content = (part: fc.Arbitrary<Rec>): fc.Arbitrary<unknown> =>
  fc.oneof(text, fc.array(fc.oneof(part, otherPart), { maxLength: 3 }));

const tool = decorate(
  fc.record(
    { name: text, tools: fc.array(decorate(fc.record({ name: text })), { maxLength: 2 }) },
    { requiredKeys: ['name'] }
  )
);

const promptCacheOptions: fc.Arbitrary<unknown> = fc.oneof(
  fc.constant(null).map(() => ({ mode: 'explicit' })),
  fc.jsonValue()
);

/** Messages-wire and Chat Completions bodies: tools, `system` blocks and messages. */
const messagesBody: fc.Arbitrary<Rec> = fc.record(
  {
    messages: fc.array(
      decorate(fc.record({ content: content(textPart), role: fc.constantFrom(...ROLES) })),
      { maxLength: 6 }
    ),
    model: text,
    prompt_cache_options: promptCacheOptions,
    system: fc.array(textPart, { maxLength: 3 }),
    tools: fc.array(tool, { maxLength: 3 }),
  },
  { requiredKeys: ['model'] }
);

const responsesItem: fc.Arbitrary<Rec> = fc.oneof(
  decorate(
    fc.record(
      {
        content: content(inputTextPart),
        role: fc.constantFrom(...ROLES),
        type: fc.constant('message'),
      },
      { requiredKeys: ['content', 'role'] }
    )
  ),
  decorate(
    fc.record({
      call_id: text,
      output: content(inputTextPart),
      type: fc.constant('function_call_output'),
    })
  ),
  fc.record({
    arguments: text,
    call_id: text,
    type: fc.constantFrom('function_call', 'custom_tool_call'),
  })
);

/** OpenAI Responses bodies: `input` as a string or a list of items. */
const responsesBody: fc.Arbitrary<Rec> = fc.record(
  {
    input: fc.oneof(text, fc.array(responsesItem, { maxLength: 6 })),
    model: text,
    prompt_cache_options: promptCacheOptions,
    tools: fc.array(tool, { maxLength: 3 }),
  },
  { requiredKeys: ['model'] }
);

/** Any JSON object, with arbitrary JSON under the keys the rewrites read. */
const looseBody: fc.Arbitrary<Rec> = fc
  .tuple(
    fc.dictionary(text, fc.jsonValue(), { maxKeys: 4, noNullPrototype: true }),
    fc.record(
      {
        input: fc.jsonValue(),
        messages: fc.jsonValue(),
        system: fc.jsonValue(),
        tools: fc.jsonValue(),
      },
      { requiredKeys: [] }
    )
  )
  .map(([extra, known]) => ({ ...extra, ...known }));

const anyBody = fc.oneof(messagesBody, responsesBody, looseBody);

/** An `anthropic-beta` value: known and unknown tokens, empty ones, two separators; or absent. */
const betaHeader = fc.option(
  fc
    .tuple(
      fc.array(fc.constantFrom('a-2025-01-01', 'b-2026-02-02', EXTENDED_CACHE_BETA, ''), {
        maxLength: 4,
        minLength: 1,
      }),
      fc.constantFrom(',', ', ')
    )
    .map(([tokens, separator]) => tokens.join(separator)),
  { nil: undefined }
);

/** An `x-cache-ttl` value: valid, valid after trim/lowercase, invalid; or absent. */
const sentinel = fc.option(fc.constantFrom('5m', '1h', 'hybrid', ' 1H ', 'HYBRID', 'bogus', ''), {
  nil: undefined,
});

const POSITIVE_INFINITY_MARKER = '"@+infinity@"';
const NEGATIVE_INFINITY_MARKER = '"@-infinity@"';

/**
 * `JSON.stringify` writes NaN and ±Infinity as `null`, which hides them from a parser. This writes
 * ±Infinity as the raw literals `1e999` and `-1e999`, which `JSON.parse` reads back as ±Infinity.
 */
const stringifyKeepingInfinity = (value: unknown): string =>
  JSON.stringify(value, (_key, child: unknown) => {
    if (child === Number.POSITIVE_INFINITY) return '@+infinity@';
    if (child === Number.NEGATIVE_INFINITY) return '@-infinity@';
    return child;
  })
    .replaceAll(POSITIVE_INFINITY_MARKER, '1e999')
    .replaceAll(NEGATIVE_INFINITY_MARKER, '-1e999');

/**
 * SSE text: `data:` lines carrying `event` (with ±Infinity as raw `1e999` literals), `[DONE]`,
 * non-JSON data and `event:` lines.
 */
const sseText = (event: fc.Arbitrary<unknown>): fc.Arbitrary<string> =>
  fc
    .array(
      fc.oneof(
        event.map((value) => `data: ${stringifyKeepingInfinity(value)}`),
        fc.constant('data: [DONE]'),
        text.map((value) => `data: ${value}`),
        text.map((value) => `event: ${value}`)
      ),
      { maxLength: 6 }
    )
    .map((lines) => lines.map((line) => `${line}\n\n`).join(''));

/** A number field as a provider might send it, or junk: any double (NaN and ±Infinity included) or JSON. */
const numberish: fc.Arbitrary<unknown> = fc.oneof(
  fc.double(),
  fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
  fc.jsonValue()
);

/**
 * Like `numberish`, but finite numbers stay within a plausible token count. The OpenAI parsers
 * subtract counts, and hugely negative inputs near `Number.MAX_VALUE` overflow to `Infinity`.
 */
const tokenish: fc.Arbitrary<unknown> = fc.oneof(
  fc.integer({ max: 1e9, min: -1e9 }),
  fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
  fc.jsonValue().filter((value) => typeof value !== 'number')
);

const ttl = fc.constantFrom<Ttl>('5m', '1h', '30m', '12h');
const tokenCount = fc.integer({ max: 10_000_000, min: 0 });
// Hundredths avoid denormals, where a ratio of two tiny floats overflows.
const priceValue = fc.integer({ max: 100_000, min: 0 }).map((hundredths) => hundredths / 100);

const cacheUsage: fc.Arbitrary<CacheUsage> = fc.record({
  cacheReadTokens: tokenCount,
  cacheWriteTokens: tokenCount,
  inputTokens: tokenCount,
  outputTokens: tokenCount,
  write1hTokens: fc.option(tokenCount, { nil: undefined }),
  write5mTokens: fc.option(tokenCount, { nil: undefined }),
});

const modelPrice: fc.Arbitrary<ModelPrice> = fc.record({
  cacheRead: priceValue,
  cacheWrite: priceValue,
  input: priceValue,
  output: priceValue,
});

const ledgerTotals: fc.Arbitrary<LedgerTotals> = fc.record({
  avoidedTokens: tokenCount,
  avoidedUnits: priceValue,
  avoidedUsd: priceValue,
  pingUnits: priceValue,
  pingUsd: priceValue,
  pings: fc.integer({ max: 1000, min: 0 }),
  rescues: fc.integer({ max: 1000, min: 0 }),
  unpricedEvents: fc.integer({ max: 5, min: 0 }),
  version: fc.constant(1 as const),
});

export {
  anyBody,
  cacheUsage,
  ledgerTotals,
  modelPrice,
  ttl,
  betaHeader,
  kind,
  looseBody,
  messagesBody,
  mode,
  numberish,
  openaiWire,
  responsesBody,
  sentinel,
  sseText,
  tokenish,
  wire,
};
