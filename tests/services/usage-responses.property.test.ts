import { describe, expect, test } from 'bun:test';

import fc from 'fast-check';

import { RESPONSES_PARSERS } from '../../src/services/usage-responses.ts';
import { sseText, tokenish } from '../helpers/arbitraries.ts';
import { expectFiniteUsage } from '../helpers/properties.ts';

const junkResponse = fc.record(
  {
    output: fc.jsonValue(),
    status: fc.jsonValue(),
    usage: fc.record(
      {
        input_tokens: tokenish,
        input_tokens_details: fc.oneof(
          fc.jsonValue(),
          fc.record({ cache_write_tokens: tokenish, cached_tokens: tokenish }, { requiredKeys: [] })
        ),
      },
      { requiredKeys: [] }
    ),
  },
  { requiredKeys: [] }
);

const event = fc.oneof(
  fc.jsonValue(),
  fc.record({
    response: junkResponse,
    type: fc.constantFrom('response.completed', 'response.incomplete', 'response.created'),
  })
);

const known = fc
  .record({ extra: fc.nat(), read: fc.nat(), write: fc.nat() })
  .map(({ extra, read, write }) => ({
    expected: {
      cacheReadTokens: read,
      cacheWriteTokens: write,
      inputTokens: extra,
      write1hTokens: undefined,
      write5mTokens: undefined,
    },
    response: {
      status: 'completed',
      usage: {
        input_tokens: read + write + extra,
        input_tokens_details: { cache_write_tokens: write, cached_tokens: read },
      },
    },
  }));

describe('RESPONSES_PARSERS properties', () => {
  test('fromJson never throws and reports finite, non-negative input', () => {
    fc.assert(
      fc.property(fc.oneof(fc.jsonValue(), junkResponse), (body) => {
        const { usage } = RESPONSES_PARSERS.fromJson(body);
        expectFiniteUsage(usage);
        if (usage) expect(usage.inputTokens).toBeGreaterThanOrEqual(0);
      })
    );
  });

  test('fromSse never throws and reports only finite usage', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), sseText(event)), (text) => {
        expectFiniteUsage(RESPONSES_PARSERS.fromSse(text).usage);
      })
    );
  });

  test('reads back known counts from a body and from response.completed', () => {
    fc.assert(
      fc.property(known, ({ expected, response }) => {
        expect(RESPONSES_PARSERS.fromJson(response).usage).toEqual(expected);
        const text = `event: response.completed\ndata: ${JSON.stringify({ response, type: 'response.completed' })}\n\n`;
        expect(RESPONSES_PARSERS.fromSse(text).usage).toEqual(expected);
      })
    );
  });
});
