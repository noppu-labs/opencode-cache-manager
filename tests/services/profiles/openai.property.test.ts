import { describe, expect, test } from 'bun:test';

import fc from 'fast-check';

import type { RequestKind } from '../../../src/models/keepalive.ts';
import type { RewriteContext } from '../../../src/models/profile.ts';
import { openaiProfile } from '../../../src/services/profiles/openai.ts';
import { isRecord } from '../../../src/utils/is-record.ts';
import {
  anyBody,
  kind,
  messagesBody,
  mode,
  openaiWire,
  responsesBody,
  wire,
} from '../../helpers/arbitraries.ts';
import { breakpoints } from '../../helpers/properties.ts';

type Rec = Record<string, unknown>;

/** A body shaped for its OpenAI wire, with a non-ping context of one of `kinds`. */
const request = (
  kinds: fc.Arbitrary<RequestKind>
): fc.Arbitrary<{ body: Rec; ctx: RewriteContext }> =>
  openaiWire.chain((w) =>
    fc.record({
      body: w === 'openai-chat' ? messagesBody : responsesBody,
      ctx: fc.record({
        inject: fc.boolean(),
        isPing: fc.constant(false),
        kind: kinds,
        mode,
        wire: fc.constant(w),
      }),
    })
  );

const hasExplicitMode = (body: Rec): boolean =>
  isRecord(body.prompt_cache_options) && body.prompt_cache_options.mode === 'explicit';

describe('openai profile rewrite properties', () => {
  test('never throws on any JSON object body, wire, mode or kind', () => {
    fc.assert(
      fc.property(
        anyBody,
        fc.record({ inject: fc.boolean(), isPing: fc.boolean(), kind, mode, wire }),
        (input, ctx) => {
          openaiProfile.rewrite(structuredClone(input), ctx);
        }
      )
    );
  });

  test('leaves pings and non-OpenAI wires untouched', () => {
    fc.assert(
      fc.property(
        anyBody,
        fc
          .record({ inject: fc.boolean(), isPing: fc.boolean(), kind, mode, wire })
          .filter((ctx) => ctx.isPing || ctx.wire === 'anthropic-messages'),
        (input, ctx) => {
          const body = structuredClone(input);
          expect(openaiProfile.rewrite(body, ctx)).toBe(false);
          expect(body).toEqual(input);
        }
      )
    );
  });

  test('primary and compaction: never add prompt_cache_options, end with at most one 12h breakpoint', () => {
    fc.assert(
      fc.property(
        request(fc.constantFrom<RequestKind>('primary', 'compaction')),
        ({ body: input, ctx }) => {
          const body = structuredClone(input);
          openaiProfile.rewrite(body, ctx);
          expect(body.prompt_cache_options).toEqual(input.prompt_cache_options);
          if (ctx.mode === '5m' && hasExplicitMode(input)) {
            expect(body).toEqual(input);
            return;
          }
          const found = breakpoints(body);
          expect(found.length).toBeLessThanOrEqual(ctx.mode === '5m' ? 0 : 1);
          for (const bp of found) expect(bp).toEqual({ mode: 'explicit', ttl: '12h' });
        }
      )
    );
  });

  test('title and generate: explicit mode and no breakpoint', () => {
    fc.assert(
      fc.property(
        request(fc.constantFrom<RequestKind>('title', 'generate')),
        ({ body: input, ctx }) => {
          const body = structuredClone(input);
          openaiProfile.rewrite(body, ctx);
          expect(body.prompt_cache_options).toEqual({ mode: 'explicit' });
          expect(breakpoints(body)).toEqual([]);
        }
      )
    );
  });

  test('is idempotent', () => {
    fc.assert(
      fc.property(request(kind), ({ body: input, ctx }) => {
        const body = structuredClone(input);
        openaiProfile.rewrite(body, ctx);
        const once = structuredClone(body);
        openaiProfile.rewrite(body, ctx);
        expect(body).toEqual(once);
      })
    );
  });
});
