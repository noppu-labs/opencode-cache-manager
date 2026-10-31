import { describe, expect, test } from 'bun:test';

import fc from 'fast-check';

import { ANTHROPIC_PARSERS } from '../../src/services/usage.ts';
import { numberish, sseText } from '../helpers/arbitraries.ts';
import { expectFiniteUsage } from '../helpers/properties.ts';

const junkUsage = fc.record(
  {
    cache_creation: fc.oneof(
      fc.jsonValue(),
      fc.record(
        { ephemeral_1h_input_tokens: numberish, ephemeral_5m_input_tokens: numberish },
        { requiredKeys: [] }
      )
    ),
    cache_creation_input_tokens: numberish,
    cache_read_input_tokens: numberish,
    input_tokens: numberish,
  },
  { requiredKeys: [] }
);

const event = fc.oneof(
  fc.jsonValue(),
  fc.record({ message: fc.record({ usage: junkUsage }), type: fc.constant('message_start') }),
  fc.record({ type: fc.constant('message_delta'), usage: junkUsage })
);

interface Counts {
  input: number;
  output: number;
  read: number;
  w1h: number;
  w5m: number;
  write: number;
}

const counts: fc.Arbitrary<Counts> = fc.record({
  input: fc.nat(),
  output: fc.nat(),
  read: fc.nat(),
  w1h: fc.nat(),
  w5m: fc.nat(),
  write: fc.nat(),
});

const wireUsage = (c: Counts): Record<string, unknown> => ({
  cache_creation: { ephemeral_1h_input_tokens: c.w1h, ephemeral_5m_input_tokens: c.w5m },
  cache_creation_input_tokens: c.write,
  cache_read_input_tokens: c.read,
  input_tokens: c.input,
  output_tokens: c.output,
});

describe('ANTHROPIC_PARSERS properties', () => {
  test('fromJson never throws and reports only finite usage', () => {
    fc.assert(
      fc.property(fc.oneof(fc.jsonValue(), fc.record({ usage: junkUsage })), (body) => {
        expectFiniteUsage(ANTHROPIC_PARSERS.fromJson(body).usage);
      })
    );
  });

  test('fromSse never throws and reports only finite usage', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), sseText(event)), (text) => {
        expectFiniteUsage(ANTHROPIC_PARSERS.fromSse(text).usage);
      })
    );
  });

  test('fromJson reads back a full usage block', () => {
    fc.assert(
      fc.property(counts, (c) => {
        expect(ANTHROPIC_PARSERS.fromJson({ usage: wireUsage(c) }).usage).toEqual({
          cacheReadTokens: c.read,
          cacheWriteTokens: c.write,
          inputTokens: c.input,
          outputTokens: c.output,
          write1hTokens: c.w1h,
          write5mTokens: c.w5m,
        });
      })
    );
  });

  test('fromSse lets message_delta override the fields it reports', () => {
    fc.assert(
      fc.property(
        counts,
        fc.record(
          { cache_read_input_tokens: fc.nat(), input_tokens: fc.nat(), output_tokens: fc.nat() },
          { requiredKeys: [] }
        ),
        (c, delta) => {
          const text =
            `event: message_start\ndata: ${JSON.stringify({ message: { usage: wireUsage(c) }, type: 'message_start' })}\n\n` +
            `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', usage: delta })}\n\n`;
          expect(ANTHROPIC_PARSERS.fromSse(text).usage).toEqual({
            cacheReadTokens: delta.cache_read_input_tokens ?? c.read,
            cacheWriteTokens: c.write,
            inputTokens: delta.input_tokens ?? c.input,
            outputTokens: delta.output_tokens ?? c.output,
            write1hTokens: c.w1h,
            write5mTokens: c.w5m,
          });
        }
      )
    );
  });
});
