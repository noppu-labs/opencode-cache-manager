import { describe, expect, test } from 'bun:test';

import fc from 'fast-check';

import {
  BETA_HEADER,
  EXTENDED_CACHE_BETA,
  SENTINEL_HEADER,
} from '../../src/constants/anthropic.ts';
import { isCacheTtlMode } from '../../src/models/cache.ts';
import {
  betaTokens,
  rewriteAnthropicCacheTtl,
  transformHttpRequest,
} from '../../src/services/cache-ttl.ts';
import { openaiProfile } from '../../src/services/profiles/openai.ts';
import {
  betaHeader,
  looseBody,
  messagesBody,
  mode,
  openaiWire,
  responsesBody,
  sentinel,
} from '../helpers/arbitraries.ts';
import { makeRequest, transformOpts } from '../helpers/fixtures.ts';
import { ephemeralBlocks, expectedTtl, oneHourFirst, withoutTtls } from '../helpers/properties.ts';

describe('rewriteAnthropicCacheTtl properties', () => {
  test('never throws on any JSON object body', () => {
    fc.assert(
      fc.property(fc.oneof(messagesBody, looseBody), mode, (input, m) => {
        rewriteAnthropicCacheTtl(structuredClone(input), m);
      })
    );
  });

  test("gives every ephemeral breakpoint its mode's TTL", () => {
    fc.assert(
      fc.property(messagesBody, mode, (input, m) => {
        const body = structuredClone(input);
        rewriteAnthropicCacheTtl(body, m);
        for (const block of ephemeralBlocks(body, 'anthropic-messages')) {
          expect(block.ttl).toBe(expectedTtl(m, block.prefix));
        }
      })
    );
  });

  test('never leaves a 1h breakpoint after a 5m one', () => {
    fc.assert(
      fc.property(messagesBody, mode, (input, m) => {
        const body = structuredClone(input);
        rewriteAnthropicCacheTtl(body, m);
        expect(oneHourFirst(ephemeralBlocks(body, 'anthropic-messages'))).toBe(true);
      })
    );
  });

  test('changes nothing but cache_control.ttl', () => {
    fc.assert(
      fc.property(fc.oneof(messagesBody, looseBody), mode, (input, m) => {
        const body = structuredClone(input);
        rewriteAnthropicCacheTtl(body, m);
        expect(withoutTtls(body)).toEqual(withoutTtls(input));
      })
    );
  });

  test('is idempotent', () => {
    fc.assert(
      fc.property(fc.oneof(messagesBody, looseBody), mode, (input, m) => {
        const body = structuredClone(input);
        rewriteAnthropicCacheTtl(body, m);
        const once = structuredClone(body);
        rewriteAnthropicCacheTtl(body, m);
        expect(body).toEqual(once);
      })
    );
  });
});

describe('transformHttpRequest header properties', () => {
  test('anthropic profile: strips x-cache-ttl and merges the beta flag for 1h and hybrid', async () => {
    await fc.assert(
      fc.asyncProperty(
        messagesBody,
        mode,
        betaHeader,
        sentinel,
        async (body, fallback, beta, ttl) => {
          const headers: Record<string, string> = {};
          if (beta !== undefined) headers[BETA_HEADER] = beta;
          if (ttl !== undefined) headers[SENTINEL_HEADER] = ttl;
          const request = makeRequest(JSON.stringify(body), headers);
          const requested = (ttl ?? '').trim().toLowerCase();
          const active = isCacheTtlMode(requested) ? requested : fallback;
          const before = request.headers.get(BETA_HEADER);

          const out = await transformHttpRequest(request, fallback, transformOpts());

          expect(out.headers.has(SENTINEL_HEADER)).toBe(false);
          if (active === '5m') {
            expect(out.headers.get(BETA_HEADER)).toBe(before);
            return;
          }
          const tokens = betaTokens(before);
          const expected = tokens.includes(EXTENDED_CACHE_BETA)
            ? tokens
            : [...tokens, EXTENDED_CACHE_BETA];
          expect(betaTokens(out.headers.get(BETA_HEADER))).toEqual(expected);
        }
      )
    );
  });

  test('openai profile: never adds or changes anthropic-beta', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(messagesBody, responsesBody),
        mode,
        betaHeader,
        openaiWire,
        async (body, m, beta, w) => {
          const request = makeRequest(
            JSON.stringify(body),
            beta === undefined ? {} : { [BETA_HEADER]: beta }
          );
          const out = await transformHttpRequest(
            request,
            m,
            transformOpts({ profile: openaiProfile, wire: w })
          );
          expect(out.headers.get(BETA_HEADER)).toBe(request.headers.get(BETA_HEADER));
        }
      )
    );
  });
});
