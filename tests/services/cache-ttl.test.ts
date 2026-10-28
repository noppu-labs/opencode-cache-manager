import { describe, expect, test } from 'bun:test';

import { EXTENDED_CACHE_BETA, SENTINEL_HEADER } from '../../src/constants/anthropic.ts';
import type { CacheProfile } from '../../src/models/profile.ts';
import { hasOneHourCacheControl } from '../../src/services/cache-control.ts';
import {
  betaTokens,
  mergeBetaHeader,
  resolveActiveMode,
  rewriteAnthropicCacheTtl,
  transformHttpRequest,
  ttlForMode,
} from '../../src/services/cache-ttl.ts';
import { implicitProfile } from '../../src/services/profiles/implicit.ts';
import { openaiProfile } from '../../src/services/profiles/openai.ts';
import {
  collectCacheControls,
  makeRequest,
  parsedBodyOf,
  sampleBody,
  transformOpts,
} from '../helpers/fixtures.ts';

// ---------------------------------------------------------------------------
// ttlForMode / resolveActiveMode
// ---------------------------------------------------------------------------

describe('ttlForMode', () => {
  test('hybrid pings at 5m, matching its message breakpoints', () => {
    expect(ttlForMode('5m')).toBe('5m');
    expect(ttlForMode('1h')).toBe('1h');
    expect(ttlForMode('hybrid')).toBe('5m');
  });
});

describe('resolveActiveMode', () => {
  test('honours a valid x-cache-ttl header', () => {
    const request = makeRequest('{}', { [SENTINEL_HEADER]: ' 1H ' });
    expect(resolveActiveMode(request, '5m')).toBe('1h');
  });

  test('ignores an invalid header', () => {
    const request = makeRequest('{}', { [SENTINEL_HEADER]: 'bogus' });
    expect(resolveActiveMode(request, 'hybrid')).toBe('hybrid');
  });

  test('uses the fallback when the header is absent', () => {
    expect(resolveActiveMode(makeRequest('{}'), '1h')).toBe('1h');
  });
});

// ---------------------------------------------------------------------------
// betaTokens
// ---------------------------------------------------------------------------

describe('betaTokens', () => {
  test('splits, trims and drops empty tokens', () => {
    expect(betaTokens(null)).toEqual([]);
    expect(betaTokens('')).toEqual([]);
    expect(betaTokens(' a, ,b ,,c')).toEqual(['a', 'b', 'c']);
  });
});

// ---------------------------------------------------------------------------
// mergeBetaHeader
// ---------------------------------------------------------------------------

describe('mergeBetaHeader', () => {
  test('returns null when nothing to include', () => {
    expect(mergeBetaHeader(null, false)).toBeNull();
    expect(mergeBetaHeader('', false)).toBeNull();
    expect(mergeBetaHeader('   ', false)).toBeNull();
  });

  test('adds the extended cache beta to an empty header', () => {
    expect(mergeBetaHeader(null, true)).toBe(EXTENDED_CACHE_BETA);
    expect(mergeBetaHeader('', true)).toBe(EXTENDED_CACHE_BETA);
  });

  test('appends the extended cache beta after existing tokens', () => {
    expect(mergeBetaHeader('interleaved-thinking-2025-05-14', true)).toBe(
      'interleaved-thinking-2025-05-14,extended-cache-ttl-2025-04-11'
    );
  });

  test('does not duplicate an existing extended cache beta', () => {
    expect(mergeBetaHeader(`interleaved-thinking-2025-05-14,${EXTENDED_CACHE_BETA}`, true)).toBe(
      'interleaved-thinking-2025-05-14,extended-cache-ttl-2025-04-11'
    );
    expect(mergeBetaHeader(EXTENDED_CACHE_BETA, true)).toBe(EXTENDED_CACHE_BETA);
  });

  test('normalizes whitespace around existing tokens', () => {
    expect(mergeBetaHeader('  interleaved-thinking-2025-05-14 ,  ', true)).toBe(
      'interleaved-thinking-2025-05-14,extended-cache-ttl-2025-04-11'
    );
  });

  test('leaves existing tokens untouched when not including', () => {
    expect(mergeBetaHeader('interleaved-thinking-2025-05-14', false)).toBe(
      'interleaved-thinking-2025-05-14'
    );
    expect(mergeBetaHeader(`a,${EXTENDED_CACHE_BETA}`, false)).toBe(`a,${EXTENDED_CACHE_BETA}`);
  });
});

// ---------------------------------------------------------------------------
// rewriteAnthropicCacheTtl
// ---------------------------------------------------------------------------

describe('rewriteAnthropicCacheTtl', () => {
  test('1h mode sets ttl on every ephemeral block across tools, system and messages', () => {
    const body = sampleBody();
    const changed = rewriteAnthropicCacheTtl(body, '1h');
    expect(changed).toBe(true);

    const ccs = collectCacheControls(body);
    expect(ccs.length).toBe(5);
    for (const cc of ccs) {
      expect(cc.type).toBe('ephemeral');
      expect(cc.ttl).toBe('1h');
    }
    expect(hasOneHourCacheControl(body)).toBe(true);
  });

  test('1h mode recurses into namespace tools', () => {
    const body = sampleBody();
    rewriteAnthropicCacheTtl(body, '1h');
    const namespace = (body.tools as Record<string, unknown>[])[2] as {
      tools: { name: string; cache_control?: Record<string, unknown> }[];
    };
    expect(namespace.tools[0].cache_control?.ttl).toBe('1h');
    expect(namespace.tools[1].cache_control).toBeUndefined();
  });

  test('5m mode removes any ttl property', () => {
    const body = sampleBody();
    // Seed every ephemeral block with an existing 1h ttl to prove deletion.
    for (const cc of collectCacheControls(body)) cc.ttl = '1h';
    const changed = rewriteAnthropicCacheTtl(body, '5m');
    expect(changed).toBe(true);
    for (const cc of collectCacheControls(body)) {
      expect('ttl' in cc).toBe(false);
    }
    expect(hasOneHourCacheControl(body)).toBe(false);
  });

  test('5m mode leaves a clean body unchanged', () => {
    const body = sampleBody();
    const changed = rewriteAnthropicCacheTtl(body, '5m');
    expect(changed).toBe(false);
    for (const cc of collectCacheControls(body)) {
      expect('ttl' in cc).toBe(false);
    }
  });

  test('hybrid mode uses 1h for tools and system but 5m for messages', () => {
    const body = sampleBody();
    const changed = rewriteAnthropicCacheTtl(body, 'hybrid');
    expect(changed).toBe(true);

    const tools = body.tools as Record<string, unknown>[];
    // tool_a and the namespace's nested_a flipped to 1h.
    expect((tools[0].cache_control as Record<string, unknown>).ttl).toBe('1h');
    const namespace = tools[2] as { tools: { cache_control?: Record<string, unknown> }[] };
    expect(namespace.tools[0].cache_control?.ttl).toBe('1h');

    const system = body.system as Record<string, unknown>[];
    expect((system[0].cache_control as Record<string, unknown>).ttl).toBe('1h');

    // Every message-level breakpoint stays at the 5m default (no ttl property).
    const messages = body.messages as Record<string, unknown>[];
    for (const message of messages) {
      const cc = message.cache_control as Record<string, unknown> | undefined;
      if (cc) expect('ttl' in cc).toBe(false);
      if (Array.isArray(message.content)) {
        for (const part of message.content as Record<string, unknown>[]) {
          const partCc = part.cache_control as Record<string, unknown> | undefined;
          if (partCc) expect('ttl' in partCc).toBe(false);
        }
      }
    }
    expect(hasOneHourCacheControl(body)).toBe(true);
  });

  test('hybrid keeps 1h prefixes ahead of 5m messages (ordering invariant)', () => {
    const body = sampleBody();
    rewriteAnthropicCacheTtl(body, 'hybrid');
    // Walk the payload in Anthropic's cache-prefix order and assert there is no
    // 1h breakpoint after a 5m breakpoint.
    const order: string[] = [];
    const visit = (block: unknown) => {
      if (!block || typeof block !== 'object') return;
      const cc = (block as Record<string, unknown>).cache_control as
        | Record<string, unknown>
        | undefined;
      if (cc && cc.type === 'ephemeral') order.push(cc.ttl === '1h' ? '1h' : '5m');
    };
    for (const tool of body.tools as unknown[]) {
      visit(tool);
      const nested = (tool as Record<string, unknown>).tools;
      if (Array.isArray(nested)) nested.forEach(visit);
    }
    for (const block of body.system as unknown[]) visit(block);
    for (const message of body.messages as Record<string, unknown>[]) {
      visit(message);
      if (Array.isArray(message.content)) (message.content as unknown[]).forEach(visit);
    }
    const firstFiveMin = order.indexOf('5m');
    if (firstFiveMin !== -1) {
      expect(order.slice(firstFiveMin)).not.toContain('1h');
    }
  });

  test('ignores non-ephemeral and malformed cache_control', () => {
    const body = {
      tools: [
        { cache_control: { type: 'persistent' } },
        { cache_control: 'not-an-object' },
        { cache_control: null },
        {},
      ],
      system: 'not-an-array',
      messages: [{ content: 'not-an-array' }],
    } as Record<string, unknown>;
    expect(rewriteAnthropicCacheTtl(body, '1h')).toBe(false);
  });

  test('empty body is a no-op', () => {
    const body = {} as Record<string, unknown>;
    expect(rewriteAnthropicCacheTtl(body, '1h')).toBe(false);
    expect(hasOneHourCacheControl(body)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// transformHttpRequest
// ---------------------------------------------------------------------------

describe('transformHttpRequest', () => {
  test('1h fallback rewrites body and appends the extended beta header', async () => {
    const request = makeRequest(JSON.stringify(sampleBody()), {
      'anthropic-beta': 'interleaved-thinking-2025-05-14',
    });
    const out = await transformHttpRequest(request, '1h', transformOpts());

    expect(out.headers.get('anthropic-beta')).toBe(
      'interleaved-thinking-2025-05-14,extended-cache-ttl-2025-04-11'
    );
    const body = await parsedBodyOf(out);
    for (const cc of collectCacheControls(body)) expect(cc.ttl).toBe('1h');
  });

  test('hybrid fallback rewrites body and appends the extended beta header', async () => {
    const out = await transformHttpRequest(
      makeRequest(JSON.stringify(sampleBody())),
      'hybrid',
      transformOpts()
    );
    expect(out.headers.get('anthropic-beta')).toBe(EXTENDED_CACHE_BETA);
    const body = (await parsedBodyOf(out)) as { messages: Record<string, unknown>[] };
    const tail = body.messages[2].cache_control as Record<string, unknown>;
    expect('ttl' in tail).toBe(false);
  });

  test('5m fallback does not add the extended beta header', async () => {
    const out = await transformHttpRequest(
      makeRequest(JSON.stringify(sampleBody())),
      '5m',
      transformOpts()
    );
    expect(out.headers.get('anthropic-beta')).toBeNull();
    const body = await parsedBodyOf(out);
    for (const cc of collectCacheControls(body)) expect('ttl' in cc).toBe(false);
  });

  test.each([
    ['x-cache-ttl: 1h overrides a 5m fallback and is stripped', '1h', '5m', '1h'],
    ['x-cache-ttl: 5m overrides a 1h fallback and is stripped', '5m', '1h', '5m'],
    ['an invalid sentinel value falls back to the fallback mode', 'bogus', '1h', '1h'],
  ] as const)('%s', async (_label, sentinel, fallback, applied) => {
    const out = await transformHttpRequest(
      makeRequest(JSON.stringify(sampleBody()), { [SENTINEL_HEADER]: sentinel }),
      fallback,
      transformOpts()
    );
    expect(out.headers.has(SENTINEL_HEADER)).toBe(false);
    expect(out.headers.get('anthropic-beta')).toBe(applied === '1h' ? EXTENDED_CACHE_BETA : null);
    const body = await parsedBodyOf(out);
    for (const cc of collectCacheControls(body)) {
      if (applied === '1h') expect(cc.ttl).toBe('1h');
      else expect('ttl' in cc).toBe(false);
    }
  });

  test('5m mode with no body and no sentinel returns the same request', async () => {
    const request = new Request('https://api.anthropic.com/v1/models', { method: 'GET' });
    const out = await transformHttpRequest(request, '5m', transformOpts());
    expect(out).toBe(request);
  });

  test('strips the sentinel from a bodyless request', async () => {
    const request = new Request('https://api.anthropic.com/v1/models', {
      method: 'GET',
      headers: { [SENTINEL_HEADER]: '1h' },
    });
    const out = await transformHttpRequest(request, '1h', transformOpts());
    expect(out).not.toBe(request);
    expect(out.headers.has(SENTINEL_HEADER)).toBe(false);
  });

  test('handles non-JSON bodies gracefully without throwing', async () => {
    const request = makeRequest('this is definitely not json', { [SENTINEL_HEADER]: '1h' });
    const out = await transformHttpRequest(request, '1h', transformOpts());
    expect(out.headers.has(SENTINEL_HEADER)).toBe(false);
    expect(await out.text()).toBe('this is definitely not json');
  });

  test('non-JSON body without a sentinel is returned untouched', async () => {
    const request = makeRequest('plain text', {}, { method: 'POST' });
    const out = await transformHttpRequest(request, '5m', transformOpts());
    expect(out).toBe(request);
  });

  test('handles an empty JSON object body', async () => {
    const out = await transformHttpRequest(makeRequest('{}'), '1h', transformOpts());
    expect(out.headers.get('anthropic-beta')).toBe(EXTENDED_CACHE_BETA);
    expect(await out.text()).toBe('{}');
  });

  test('handles a JSON array body without throwing', async () => {
    const out = await transformHttpRequest(
      makeRequest('[1,2,3]', { [SENTINEL_HEADER]: '1h' }),
      '5m',
      transformOpts()
    );
    expect(out.headers.has(SENTINEL_HEADER)).toBe(false);
    expect(await out.text()).toBe('[1,2,3]');
  });

  test('every rebuilt request keeps the original abort signal', async () => {
    const cases: Array<[Request, '5m' | '1h']> = [];
    const controllers: AbortController[] = [];
    const build = (init: RequestInit & { url?: string }, mode: '5m' | '1h') => {
      const controller = new AbortController();
      controllers.push(controller);
      const { url, ...rest } = init;
      cases.push([
        new Request(url ?? 'https://api.anthropic.com/v1/messages', {
          ...rest,
          signal: controller.signal,
        }),
        mode,
      ]);
    };
    build({ method: 'POST', body: JSON.stringify(sampleBody()) }, '1h');
    build(
      {
        method: 'GET',
        url: 'https://api.anthropic.com/v1/models',
        headers: { [SENTINEL_HEADER]: '1h' },
      },
      '5m'
    );
    build({ method: 'POST', body: 'not json', headers: { [SENTINEL_HEADER]: '1h' } }, '5m');

    for (const [i, [request, mode]] of cases.entries()) {
      const out = await transformHttpRequest(request, mode, transformOpts());
      expect(out).not.toBe(request);
      expect(out.signal.aborted).toBe(false);
      controllers[i].abort();
      expect(out.signal.aborted).toBe(true);
    }
  });
});

describe('transformHttpRequest through a profile', () => {
  const responses = (value: unknown, headers: Record<string, string> = {}) =>
    new Request('https://openrouter.ai/api/v1/responses', {
      method: 'POST',
      headers,
      body: JSON.stringify(value),
    });
  const input = () => [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }];

  test('the openai profile marks the last Responses input_text in 1h', async () => {
    const out = await transformHttpRequest(
      responses({ input: input() }),
      '1h',
      transformOpts({ wire: 'openai-responses', profile: openaiProfile })
    );
    expect(await parsedBodyOf(out)).toEqual({
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'hi',
              prompt_cache_breakpoint: { mode: 'explicit', ttl: '12h' },
            },
          ],
        },
      ],
    });
    expect(out.headers.get('anthropic-beta')).toBeNull();
  });

  test('an OpenAI-wire request the profile does not change is returned as is', async () => {
    const request = responses({ input: input() });
    const out = await transformHttpRequest(
      request,
      '5m',
      transformOpts({ wire: 'openai-responses', profile: openaiProfile })
    );
    expect(out).toBe(request);
  });

  test('an unchanged OpenAI-wire request with the sentinel is rebuilt without it', async () => {
    const out = await transformHttpRequest(
      responses({ input: input() }, { [SENTINEL_HEADER]: '1h' }),
      '5m',
      transformOpts({ wire: 'openai-responses', profile: implicitProfile })
    );
    expect(out.headers.has(SENTINEL_HEADER)).toBe(false);
    expect(await parsedBodyOf(out)).toEqual({ input: input() });
  });

  test('an implicit Messages request with the sentinel keeps its original body bytes', async () => {
    const text =
      '{"model":"deepseek-v4","temperature":1.0,"seed":12345678901234567890,"messages":[]}';
    const out = await transformHttpRequest(
      makeRequest(text, { [SENTINEL_HEADER]: '1h' }),
      '5m',
      transformOpts({ profile: implicitProfile })
    );
    expect(out.headers.has(SENTINEL_HEADER)).toBe(false);
    expect(await out.text()).toBe(text);
  });

  test('profile headers are set, and beta values merged without duplicates', async () => {
    const profile: CacheProfile = {
      ...implicitProfile,
      headers: () => ({ 'x-extra': '1', 'anthropic-beta': `${EXTENDED_CACHE_BETA},other-beta` }),
    };
    const request = makeRequest(JSON.stringify(sampleBody()), {
      'anthropic-beta': `a-beta, ${EXTENDED_CACHE_BETA}`,
    });
    const out = await transformHttpRequest(request, '5m', transformOpts({ profile }));
    expect(out.headers.get('x-extra')).toBe('1');
    expect(out.headers.get('anthropic-beta')).toBe(`a-beta,${EXTENDED_CACHE_BETA},other-beta`);
  });
});
