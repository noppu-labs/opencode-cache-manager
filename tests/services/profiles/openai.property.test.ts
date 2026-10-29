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
import { breakpoints, withoutKey } from '../../helpers/properties.ts';

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

/** Where the 12h breakpoint lands in the rewritten body: a list, an item index, a part field and a part index. */
interface Target {
  field: 'content' | 'output';
  index: number;
  list: 'input' | 'messages';
  part: number;
}

const items = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const lastIndex = (parts: unknown[], type: 'input_text' | 'text'): number =>
  parts.findLastIndex(
    (part) =>
      isRecord(part) && part.type === type && typeof part.text === 'string' && part.text !== ''
  );

/** The part holding the last text of `value`; string content becomes a single part at 0. */
const textPart = (value: unknown, type: 'input_text' | 'text', allowString = true): number => {
  if (typeof value === 'string') return allowString && value !== '' ? 0 : -1;
  return lastIndex(items(value), type);
};

const isChatTailRole = (item: unknown): item is Rec =>
  isRecord(item) && ['developer', 'system', 'tool', 'user'].includes(String(item.role));

const isResponsesMessage = (item: Rec): boolean =>
  item.type === 'message' || (item.type === undefined && typeof item.role === 'string');

/** A Responses item's last text part: message content (string content not for assistant), then tool output. */
function responsesTarget(item: unknown, index: number): Target | undefined {
  if (!isRecord(item)) return undefined;
  if (isResponsesMessage(item)) {
    const part = textPart(item.content, 'input_text', item.role !== 'assistant');
    if (part !== -1) return { field: 'content', index, list: 'input', part };
  }
  if (item.type === 'function_call_output') {
    const part = textPart(item.output, 'input_text');
    if (part !== -1) return { field: 'output', index, list: 'input', part };
  }
  return undefined;
}

/** Derives the expected 12h breakpoint position from the documented rules, independent of src. */
function expectedTarget(body: Rec, ctx: RewriteContext): Target | undefined {
  if (ctx.wire === 'openai-chat') {
    const messages = items(body.messages);
    let end = messages.findIndex(
      (message) => !(isRecord(message) && ['developer', 'system'].includes(String(message.role)))
    );
    if (end === -1) end = messages.length;
    const candidates = ctx.mode === '1h' ? messages.length : end;
    for (let index = candidates - 1; index >= 0; index--) {
      const message = messages[index];
      if (!isRecord(message) || (ctx.mode === '1h' && !isChatTailRole(message))) continue;
      const part = textPart(message.content, 'text');
      if (part !== -1) return { field: 'content', index, list: 'messages', part };
    }
    return undefined;
  }
  const input = items(body.input);
  if (ctx.mode === 'hybrid') {
    const item: unknown = input[0];
    const target = responsesTarget(item, 0);
    return target?.field === 'content' ? target : undefined;
  }
  for (let index = input.length - 1; index >= 0; index--) {
    const target = responsesTarget(input[index], index);
    if (target) return target;
  }
  return undefined;
}

const partAt = (body: Rec, { field, index, list, part }: Target): unknown => {
  const item: unknown = items(body[list])[index];
  return isRecord(item) ? items(item[field])[part] : undefined;
};

const expectReturnMatchesChange = (input: Rec, ctx: RewriteContext): void => {
  const body = structuredClone(input);
  const returned = openaiProfile.rewrite(body, ctx);
  expect(returned).toBe(!Bun.deepEquals(input, body, true));
};

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

  test('changes nothing but the breakpoint, the explicit option and the target string-to-part conversion', () => {
    fc.assert(
      fc.property(request(kind), ({ body: input, ctx }) => {
        const body = structuredClone(input);
        openaiProfile.rewrite(body, ctx);

        const expected = structuredClone(input);
        const target =
          ctx.kind === 'primary' || ctx.kind === 'compaction'
            ? expectedTarget(input, ctx)
            : undefined;
        if (target && ctx.mode !== '5m') {
          const item: unknown = items(expected[target.list])[target.index];
          if (isRecord(item) && typeof item[target.field] === 'string') {
            item[target.field] = [
              {
                text: item[target.field],
                type: ctx.wire === 'openai-chat' ? 'text' : 'input_text',
              },
            ];
          }
        }

        const strip = (value: unknown): unknown => {
          const stripped = withoutKey(value, 'prompt_cache_breakpoint');
          return ctx.kind === 'title' || ctx.kind === 'generate'
            ? withoutKey(stripped, 'prompt_cache_options')
            : stripped;
        };
        expect(strip(body)).toEqual(strip(expected));
      })
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

  test('1h and hybrid on primary and compaction: one 12h breakpoint on the expected target, or none', () => {
    fc.assert(
      fc.property(
        request(fc.constantFrom<RequestKind>('primary', 'compaction')).filter(
          ({ ctx }) => ctx.mode !== '5m'
        ),
        ({ body: input, ctx }) => {
          const body = structuredClone(input);
          openaiProfile.rewrite(body, ctx);
          const target = expectedTarget(input, ctx);
          if (!target) {
            expect(breakpoints(body)).toEqual([]);
            return;
          }
          expect(breakpoints(body)).toEqual([{ mode: 'explicit', ttl: '12h' }]);
          const part = partAt(body, target);
          expect(isRecord(part) && part.prompt_cache_breakpoint).toEqual({
            mode: 'explicit',
            ttl: '12h',
          });
        }
      )
    );
  });

  test('returns true exactly when the body changed, on any JSON object body', () => {
    fc.assert(
      fc.property(
        anyBody,
        fc.record({ inject: fc.boolean(), isPing: fc.boolean(), kind, mode, wire }),
        (input, ctx) => {
          expectReturnMatchesChange(input, ctx);
        }
      )
    );
  });

  test('returns true exactly when the body changed, on bodies shaped for their wire', () => {
    fc.assert(
      fc.property(request(kind), ({ body, ctx }) => {
        expectReturnMatchesChange(body, ctx);
      })
    );
  });

  test('a second rewrite of a non-ping OpenAI request reports no change', () => {
    fc.assert(
      fc.property(request(kind), ({ body: input, ctx }) => {
        const body = structuredClone(input);
        openaiProfile.rewrite(body, ctx);
        const once = structuredClone(body);
        expect(openaiProfile.rewrite(body, ctx)).toBe(false);
        expect(body).toEqual(once);
      })
    );
  });

  test('injecting into a body without breakpoints reports a change', () => {
    fc.assert(
      fc.property(
        request(fc.constantFrom<RequestKind>('primary', 'compaction'))
          .map(({ body, ctx }) => ({
            body: withoutKey(body, 'prompt_cache_breakpoint') as Rec,
            ctx,
          }))
          .filter(({ body, ctx }) => ctx.mode !== '5m' && expectedTarget(body, ctx) !== undefined),
        ({ body: input, ctx }) => {
          const body = structuredClone(input);
          expect(openaiProfile.rewrite(body, ctx)).toBe(true);
          expect(body).not.toEqual(input);
          expect(breakpoints(body)).toEqual([{ mode: 'explicit', ttl: '12h' }]);
        }
      )
    );
  });
});
