import { describe, expect, test } from 'bun:test';

import {
  parseOpenAiFinishReasonFromJson,
  parseOpenAiFinishReasonFromSse,
  parseOpenAiIdentityFromJson,
  parseOpenAiIdentityFromSse,
  parseOpenAiUsageFromJson,
  parseOpenAiUsageFromSse,
} from '../../src/services/usage-openai.ts';
import { contextTokens, grantedTtl } from '../../src/services/usage.ts';
import { openaiSse, openaiUsage } from '../helpers/fixtures.ts';

describe('parseOpenAiUsageFromJson', () => {
  test('OmniRoute auto/ write: writes are excluded from prompt_tokens', () => {
    const usage = parseOpenAiUsageFromJson({ usage: openaiUsage.omnirouteAutoWrite })!;
    expect(usage).toEqual({
      inputTokens: 1698,
      cacheReadTokens: 0,
      cacheWriteTokens: 14845,
      write5mTokens: undefined,
      write1hTokens: undefined,
    });
    expect(contextTokens(usage)).toBe(16543);
    expect(grantedTtl(usage)).toBeUndefined();
  });

  test('OmniRoute auto/ read', () => {
    expect(parseOpenAiUsageFromJson({ usage: openaiUsage.omnirouteAutoRead })).toMatchObject({
      inputTokens: 1698,
      cacheReadTokens: 14845,
      cacheWriteTokens: 0,
    });
  });

  test('gpt-6-luna write: writes are included in prompt_tokens', () => {
    expect(parseOpenAiUsageFromJson({ usage: openaiUsage.lunaWrite })).toMatchObject({
      inputTokens: 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 8884,
    });
  });

  test('gpt-6-luna read with a fresh write', () => {
    expect(parseOpenAiUsageFromJson({ usage: openaiUsage.lunaRead })).toMatchObject({
      inputTokens: 3,
      cacheReadTokens: 8884,
      cacheWriteTokens: 19,
    });
  });

  test('DeepSeek read has no write', () => {
    expect(parseOpenAiUsageFromJson({ usage: openaiUsage.deepseekRead })).toMatchObject({
      inputTokens: 83,
      cacheReadTokens: 10112,
      cacheWriteTokens: 0,
    });
  });

  test('prefers prompt_tokens_details.cache_write_tokens when present', () => {
    const usage = parseOpenAiUsageFromJson({
      usage: {
        prompt_tokens: 1000,
        cache_creation_input_tokens: 1,
        prompt_tokens_details: { cached_tokens: 100, cache_write_tokens: 400 },
      },
    });
    expect(usage).toMatchObject({ inputTokens: 500, cacheReadTokens: 100, cacheWriteTokens: 400 });
  });

  test('falls back through the read field aliases', () => {
    expect(
      parseOpenAiUsageFromJson({ usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 60 } })
    ).toMatchObject({
      inputTokens: 40,
      cacheReadTokens: 60,
    });
    expect(
      parseOpenAiUsageFromJson({ usage: { prompt_tokens: 100, cached_tokens: 30 } })
    ).toMatchObject({
      inputTokens: 70,
      cacheReadTokens: 30,
    });
  });

  test('never reports negative input tokens', () => {
    expect(
      parseOpenAiUsageFromJson({
        usage: { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 50 } },
      })
    ).toMatchObject({ inputTokens: 0, cacheReadTokens: 50 });
  });

  test('returns undefined without a usage object', () => {
    expect(parseOpenAiUsageFromJson({})).toBeUndefined();
    expect(parseOpenAiUsageFromJson({ usage: null })).toBeUndefined();
    expect(parseOpenAiUsageFromJson({ usage: {} })).toBeUndefined();
    expect(parseOpenAiUsageFromJson(null)).toBeUndefined();
  });
});

describe('parseOpenAiUsageFromSse', () => {
  test('reads the usage-only final chunk and skips [DONE]', () => {
    expect(parseOpenAiUsageFromSse(openaiSse(openaiUsage.lunaRead))).toMatchObject({
      inputTokens: 3,
      cacheReadTokens: 8884,
      cacheWriteTokens: 19,
    });
  });

  test('the last chunk with usage wins and junk lines are skipped', () => {
    const text =
      `data: ${JSON.stringify({ usage: openaiUsage.lunaWrite })}\n\n` +
      `data: not json\n\n` +
      `: keep-alive\n\n` +
      `data: ${JSON.stringify({ choices: [], usage: openaiUsage.deepseekRead })}\n\n` +
      `data: {"choices":[{"delta":{"content":"x"}}]}\n\n` +
      `data: [DONE]\n\n`;
    expect(parseOpenAiUsageFromSse(text)).toMatchObject({
      inputTokens: 83,
      cacheReadTokens: 10112,
    });
  });

  test('a usage chunk without prompt_tokens does not overwrite a valid one', () => {
    const text =
      `data: ${JSON.stringify({ usage: openaiUsage.lunaRead })}\n\n` +
      `data: ${JSON.stringify({ usage: {} })}\n\n`;
    expect(parseOpenAiUsageFromSse(text)).toMatchObject({ inputTokens: 3, cacheReadTokens: 8884 });
  });

  test('returns undefined when no chunk carries usage', () => {
    expect(parseOpenAiUsageFromSse(`data: {"choices":[]}\n\ndata: [DONE]\n\n`)).toBeUndefined();
  });
});

describe('parseOpenAiFinishReason', () => {
  test('JSON: reads choices[0].finish_reason and maps tool_calls to tool_use', () => {
    expect(parseOpenAiFinishReasonFromJson({ choices: [{ finish_reason: 'stop' }] })).toBe('stop');
    expect(parseOpenAiFinishReasonFromJson({ choices: [{ finish_reason: 'tool_calls' }] })).toBe(
      'tool_use'
    );
    expect(parseOpenAiFinishReasonFromJson({ choices: [{ finish_reason: null }] })).toBeUndefined();
    expect(parseOpenAiFinishReasonFromJson({ choices: [] })).toBeUndefined();
    expect(parseOpenAiFinishReasonFromJson(null)).toBeUndefined();
  });

  test('SSE: the last non-null finish_reason wins', () => {
    expect(
      parseOpenAiFinishReasonFromSse(
        openaiSse(openaiUsage.lunaRead, { finishReason: 'tool_calls' })
      )
    ).toBe('tool_use');
    expect(parseOpenAiFinishReasonFromSse(openaiSse(openaiUsage.lunaRead))).toBe('stop');
    expect(
      parseOpenAiFinishReasonFromSse(`data: {"choices":[{"finish_reason":null}]}\n\n`)
    ).toBeUndefined();
  });
});

describe('parseOpenAiIdentity', () => {
  test('SSE: reads model and provider from the chunks', () => {
    expect(
      parseOpenAiIdentityFromSse(
        openaiSse(openaiUsage.lunaRead, {
          model: 'claude-haiku-5-5',
          provider: 'Claude Platform on AWS',
        })
      )
    ).toEqual({ model: 'claude-haiku-5-5', provider: 'Claude Platform on AWS' });
  });

  test('SSE: model alone when there is no provider', () => {
    expect(
      parseOpenAiIdentityFromSse(`data: {"model":"claude-haiku-5-5","choices":[]}\n\n`)
    ).toEqual({
      model: 'claude-haiku-5-5',
    });
  });

  test('JSON: top-level model and provider', () => {
    expect(parseOpenAiIdentityFromJson({ model: 'openai/gpt-6-luna', provider: 'OpenAI' })).toEqual(
      {
        model: 'openai/gpt-6-luna',
        provider: 'OpenAI',
      }
    );
  });

  test('undefined when neither is present', () => {
    expect(parseOpenAiIdentityFromJson({})).toBeUndefined();
    expect(parseOpenAiIdentityFromJson(null)).toBeUndefined();
    expect(parseOpenAiIdentityFromSse(`data: {"choices":[]}\n\ndata: [DONE]\n\n`)).toBeUndefined();
  });
});
