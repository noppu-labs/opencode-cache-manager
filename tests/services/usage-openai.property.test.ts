import { describe, expect, test } from 'bun:test';

import fc from 'fast-check';

import { OPENAI_PARSERS } from '../../src/services/usage-openai.ts';
import { sseText, tokenish } from '../helpers/arbitraries.ts';
import { expectFiniteUsage } from '../helpers/properties.ts';

const junkUsage = fc.record(
  {
    cache_creation_input_tokens: tokenish,
    cache_read_input_tokens: tokenish,
    cached_tokens: tokenish,
    prompt_cache_hit_tokens: tokenish,
    prompt_tokens: tokenish,
    prompt_tokens_details: fc.oneof(
      fc.jsonValue(),
      fc.record(
        {
          cache_creation_in_prompt: fc.jsonValue(),
          cache_write_tokens: tokenish,
          cached_tokens: tokenish,
        },
        { requiredKeys: [] }
      )
    ),
  },
  { requiredKeys: [] }
);

/** A usage block with known counts and the CacheUsage it must parse to. */
const known = fc
  .record({ extra: fc.nat(), inPrompt: fc.boolean(), read: fc.nat(), write: fc.nat() })
  .map(({ extra, inPrompt, read, write }) => ({
    expected: {
      cacheReadTokens: read,
      cacheWriteTokens: write,
      inputTokens: extra,
      write1hTokens: undefined,
      write5mTokens: undefined,
    },
    usage: {
      prompt_tokens: read + (inPrompt ? write : 0) + extra,
      prompt_tokens_details: inPrompt
        ? { cache_write_tokens: write, cached_tokens: read }
        : { cache_creation_in_prompt: false, cache_write_tokens: write, cached_tokens: read },
    },
  }));

describe('OPENAI_PARSERS properties', () => {
  test('fromJson never throws and reports finite, non-negative input', () => {
    fc.assert(
      fc.property(fc.oneof(fc.jsonValue(), fc.record({ usage: junkUsage })), (body) => {
        const { usage } = OPENAI_PARSERS.fromJson(body);
        expectFiniteUsage(usage);
        if (usage) expect(usage.inputTokens).toBeGreaterThanOrEqual(0);
      })
    );
  });

  test('fromSse never throws and reports only finite usage', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), sseText(fc.oneof(fc.jsonValue(), fc.record({ usage: junkUsage })))),
        (text) => {
          expectFiniteUsage(OPENAI_PARSERS.fromSse(text).usage);
        }
      )
    );
  });

  test('fromJson reads back known counts', () => {
    fc.assert(
      fc.property(known, ({ expected, usage }) => {
        expect(OPENAI_PARSERS.fromJson({ usage }).usage).toEqual(expected);
      })
    );
  });

  test('fromSse takes the last chunk that carries usage', () => {
    fc.assert(
      fc.property(fc.array(known, { maxLength: 4, minLength: 1 }), (chunks) => {
        const text = chunks
          .map(
            ({ usage }) =>
              `data: ${JSON.stringify({ choices: [{ delta: { content: 'x' } }] })}\n\n` +
              `data: ${JSON.stringify({ choices: [], usage })}\n\n`
          )
          .join('');
        expect(OPENAI_PARSERS.fromSse(`${text}data: [DONE]\n\n`).usage).toEqual(
          chunks.at(-1)?.expected
        );
      })
    );
  });
});
