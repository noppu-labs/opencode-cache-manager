import { describe, expect, test } from 'bun:test';

import { BETA_HEADER, EXTENDED_CACHE_BETA } from '../../../src/constants/anthropic.ts';
import type { CacheTtlMode } from '../../../src/models/cache.ts';
import { hasOneHourCacheControl } from '../../../src/services/cache-control.ts';
import { rewriteAnthropicCacheTtl, ttlForMode } from '../../../src/services/cache-ttl.ts';
import {
  injectOpenAiBreakpoints,
  rewriteOpenAiCacheTtl,
} from '../../../src/services/openai-cache-ttl.ts';
import { anthropicProfile } from '../../../src/services/profiles/anthropic.ts';
import { sampleBody } from '../../helpers/fixtures.ts';

type Rec = Record<string, unknown>;

const MODES: CacheTtlMode[] = ['5m', '1h', 'hybrid'];

function chatBody(): Rec {
  return {
    model: 'anthropic/claude-sonnet-5-5',
    tools: [{ type: 'function', function: { name: 't' } }],
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'tail' },
    ],
  };
}

function markedChatBody(): Rec {
  const body = chatBody();
  injectOpenAiBreakpoints(body);
  return body;
}

const ctx = (wire: 'anthropic-messages' | 'openai-chat', mode: CacheTtlMode, inject = false) =>
  ({ wire, mode, kind: 'primary', isPing: false, inject }) as const;

describe('anthropic profile', () => {
  test('describes the Anthropic and OpenAI-chat wires with pings', () => {
    expect(anthropicProfile.id).toBe('anthropic');
    expect(anthropicProfile.pings).toBe(true);
    expect(anthropicProfile.wires).toEqual(['anthropic-messages', 'openai-chat']);
  });

  test('ttlForMode matches the existing function', () => {
    for (const mode of MODES) expect(anthropicProfile.ttlForMode(mode)).toBe(ttlForMode(mode));
    expect(anthropicProfile.ttlForMode('hybrid')).toBe('5m');
    expect(anthropicProfile.ttlForMode('1h')).toBe('1h');
  });

  for (const mode of MODES) {
    test(`anthropic-messages ${mode}: body and headers match rewriteAnthropicCacheTtl`, () => {
      const expected = sampleBody();
      const expectedChanged = rewriteAnthropicCacheTtl(expected, mode);
      const actual = sampleBody();
      expect(anthropicProfile.rewrite(actual, ctx('anthropic-messages', mode))).toBe(
        expectedChanged
      );
      expect(actual).toEqual(expected);

      const headers = anthropicProfile.headers?.(actual, { wire: 'anthropic-messages', mode });
      expect(headers).toEqual(mode === '5m' ? {} : { [BETA_HEADER]: EXTENDED_CACHE_BETA });
    });

    for (const inject of [false, true]) {
      test(`openai-chat ${mode} inject=${inject}: body and headers match the existing rewriters`, () => {
        const make = inject ? chatBody : markedChatBody;
        const reference = make();
        const actual = make();
        const injected = inject && injectOpenAiBreakpoints(reference);
        const rewritten = rewriteOpenAiCacheTtl(reference, mode);

        expect(anthropicProfile.rewrite(actual, ctx('openai-chat', mode, inject))).toBe(
          injected || rewritten
        );
        expect(actual).toEqual(reference);

        const headers = anthropicProfile.headers?.(actual, { wire: 'openai-chat', mode });
        expect(headers).toEqual(
          hasOneHourCacheControl(reference) ? { [BETA_HEADER]: EXTENDED_CACHE_BETA } : {}
        );
      });
    }
  }

  test('openai-chat runs the rewrite even when injection already reported a change', () => {
    const body = chatBody();
    expect(anthropicProfile.rewrite(body, ctx('openai-chat', '1h', true))).toBe(true);
    expect(hasOneHourCacheControl(body)).toBe(true);
  });

  test('openai-chat without breakpoints and inject off changes nothing', () => {
    const body = chatBody();
    expect(anthropicProfile.rewrite(body, ctx('openai-chat', '1h', false))).toBe(false);
    expect(body).toEqual(chatBody());
    expect(anthropicProfile.headers?.(body, { wire: 'openai-chat', mode: '1h' })).toEqual({});
  });
});
