import { describe, expect, test } from 'bun:test';

import fc from 'fast-check';

import {
  injectOpenAiBreakpoints,
  rewriteOpenAiCacheTtl,
} from '../../src/services/openai-cache-ttl.ts';
import { looseBody, messagesBody, mode } from '../helpers/arbitraries.ts';
import { collectCacheControls } from '../helpers/fixtures.ts';
import {
  ephemeralBlocks,
  expectedTtl,
  oneHourFirst,
  withoutKey,
  withoutTtls,
} from '../helpers/properties.ts';

describe('rewriteOpenAiCacheTtl properties', () => {
  test('never throws on any JSON object body', () => {
    fc.assert(
      fc.property(fc.oneof(messagesBody, looseBody), mode, (input, m) => {
        rewriteOpenAiCacheTtl(structuredClone(input), m);
      })
    );
  });

  test("gives every ephemeral breakpoint its mode's TTL", () => {
    fc.assert(
      fc.property(messagesBody, mode, (input, m) => {
        const body = structuredClone(input);
        rewriteOpenAiCacheTtl(body, m);
        for (const block of ephemeralBlocks(body, 'openai-chat')) {
          expect(block.ttl).toBe(expectedTtl(m, block.prefix));
        }
      })
    );
  });

  test('never leaves a 1h breakpoint after a 5m one', () => {
    fc.assert(
      fc.property(messagesBody, mode, (input, m) => {
        const body = structuredClone(input);
        rewriteOpenAiCacheTtl(body, m);
        expect(oneHourFirst(ephemeralBlocks(body, 'openai-chat'))).toBe(true);
      })
    );
  });

  test('changes nothing but cache_control.ttl', () => {
    fc.assert(
      fc.property(fc.oneof(messagesBody, looseBody), mode, (input, m) => {
        const body = structuredClone(input);
        rewriteOpenAiCacheTtl(body, m);
        expect(withoutTtls(body)).toEqual(withoutTtls(input));
      })
    );
  });

  test('is idempotent', () => {
    fc.assert(
      fc.property(fc.oneof(messagesBody, looseBody), mode, (input, m) => {
        const body = structuredClone(input);
        rewriteOpenAiCacheTtl(body, m);
        const once = structuredClone(body);
        rewriteOpenAiCacheTtl(body, m);
        expect(body).toEqual(once);
      })
    );
  });
});

describe('injectOpenAiBreakpoints properties', () => {
  test('adds at most 3 ephemeral breakpoints to a body that has none', () => {
    fc.assert(
      fc.property(fc.oneof(messagesBody, looseBody), (input) => {
        const body = withoutKey(input, 'cache_control') as Record<string, unknown>;
        injectOpenAiBreakpoints(body);
        const added = collectCacheControls(body);
        expect(added.length).toBeLessThanOrEqual(3);
        for (const cc of added) expect(cc).toEqual({ type: 'ephemeral' });
      })
    );
  });
});
