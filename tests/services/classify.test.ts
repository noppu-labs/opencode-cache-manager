import { describe, expect, spyOn, test } from 'bun:test';

import { parseCacheProfiles } from '../../src/config/model-patterns.ts';
import type { Wire } from '../../src/models/cache.ts';
import {
  classifyRequest,
  classifyRequestWithBody,
  isAnthropicMessagesRequest,
  keepsWarm,
  observedWireFor,
  profileForRoute,
  requestWire,
  routeRequest,
  shouldInject,
  type Route,
  type RouteInput,
} from '../../src/services/classify.ts';
import { ProfileStore } from '../../src/services/profile-store.ts';
import { memoryKv } from '../helpers/memory-kv.ts';

const chat = (url = 'https://omni.example/v1/chat/completions', method = 'POST') =>
  new Request(url, { method });
const noDeps = { patterns: [] };
const on = { openaiWires: true };
const off = { openaiWires: false };

describe('requestWire', () => {
  const post = (url: string, method = 'POST') =>
    new Request(url, method === 'POST' ? { method, body: '{}' } : { method });

  test('names the wire from the method and path alone', () => {
    expect(requestWire(post('https://api.anthropic.com/v1/messages'))).toBe('anthropic-messages');
    expect(requestWire(post('https://omni.example/v1/chat/completions'))).toBe('openai-chat');
    expect(requestWire(post('https://omni.example/v1/responses'))).toBe('openai-responses');
    expect(requestWire(post('https://omni.example/v1/embeddings'))).toBeUndefined();
    expect(requestWire(post('https://omni.example/v1/chat/completions', 'GET'))).toBeUndefined();
    expect(requestWire(post('https://omni.example/v1/responses', 'GET'))).toBeUndefined();
  });
});

describe('classifyRequest', () => {
  test('chat completions with a Claude model is openai-chat / explicit', () => {
    const ref = { providerID: 'openrouter', id: 'anthropic/claude-haiku-5.5' };
    expect(classifyRequest(chat(), ref, noDeps)).toEqual({
      wire: 'openai-chat',
      profile: 'anthropic',
    });
  });

  test('an auto/claude-* alias is explicit', () => {
    const ref = { providerID: 'omniroute', id: 'auto/claude-opus-5-5' };
    expect(classifyRequest(chat(), ref, noDeps)?.profile).toBe('anthropic');
  });

  test('the built-in regex also checks the body model', () => {
    const ref = { providerID: 'omniroute', id: 'auto/opus-5' };
    expect(classifyRequest(chat(), ref, noDeps, 'anthropic/claude-opus-5')?.profile).toBe(
      'anthropic'
    );
  });

  test('a non-Claude model is implicit', () => {
    const ref = { providerID: 'openrouter', id: 'deepseek/deepseek-v4.1-flash' };
    expect(classifyRequest(chat(), ref, noDeps)).toEqual({
      wire: 'openai-chat',
      profile: 'implicit',
    });
  });

  test('an alias is implicit, then explicit once learned, and patterns outrank both', async () => {
    const ref = { providerID: 'omniroute', id: 'auto/opus-5' };
    const store = new ProfileStore(memoryKv().kv);
    await store.load();
    const learned = (r: typeof ref) => store.get(r);

    expect(classifyRequest(chat(), ref, { patterns: [], learned })?.profile).toBe('implicit');
    await store.learnFromResponse(ref, { model: 'claude-opus-5-5' });
    expect(classifyRequest(chat(), ref, { patterns: [], learned })?.profile).toBe('anthropic');
    expect(
      classifyRequest(chat(), ref, { patterns: parseCacheProfiles({ opus: 'implicit' }), learned })
        ?.profile
    ).toBe('implicit');
  });

  test('a user pattern outranks the built-in regex', () => {
    const ref = { providerID: 'omniroute', id: 'auto/claude-opus-5-5' };
    expect(
      classifyRequest(chat(), ref, { patterns: parseCacheProfiles({ claude: 'implicit' }) })
        ?.profile
    ).toBe('implicit');
  });

  test('the built-in regex outranks a learned implicit value', () => {
    const ref = { providerID: 'omniroute', id: 'auto/claude-opus-5-5' };
    expect(classifyRequest(chat(), ref, { patterns: [], learned: () => 'implicit' })?.profile).toBe(
      'anthropic'
    );
  });

  test('a pattern can make a non-Claude model explicit', () => {
    const ref = { providerID: 'omniroute', id: 'auto/opus-5' };
    expect(
      classifyRequest(chat(), ref, { patterns: parseCacheProfiles({ opus: 'anthropic' }) })?.profile
    ).toBe('anthropic');
  });

  test('POST …/messages from an Anthropic provider is anthropic-messages / explicit regardless of model or patterns', () => {
    const request = chat('https://api.anthropic.com/v1/messages');
    const ref = { providerID: 'anthropic', id: 'whatever' };
    expect(
      classifyRequest(request, ref, { patterns: parseCacheProfiles({ whatever: 'implicit' }) })
    ).toEqual({
      wire: 'anthropic-messages',
      profile: 'anthropic',
    });
  });

  test('the Messages wire is classified by model outside the Anthropic provider IDs', () => {
    const messages = chat('https://proxy.example/v1/messages');
    const claude = ['claude-haiku-5-5', 'anthropic/claude-haiku-5.5', 'auto/claude-haiku-5-5'];
    const others = ['deepseek/deepseek-v4.1-flash', 'auto/fast', 'gpt-6-luna'];
    const got: string[] = [];
    const want: string[] = [];
    for (const providerID of ['anthropic', 'omniroute-anthropic', 'some-proxy']) {
      for (const id of [...claude, ...others]) {
        got.push(
          `${providerID}/${id} ${JSON.stringify(classifyRequest(messages, { providerID, id }, noDeps))}`
        );
        const profile =
          providerID !== 'some-proxy' || claude.includes(id) ? 'anthropic' : 'implicit';
        want.push(`${providerID}/${id} ${JSON.stringify({ profile, wire: 'anthropic-messages' })}`);
      }
    }
    expect(got).toEqual(want);
  });

  test('on the Messages wire a pattern decides for other providers and is ignored for the Anthropic IDs', () => {
    const messages = chat('https://proxy.example/v1/messages');
    const fast = { patterns: parseCacheProfiles({ 'auto/fast': 'anthropic' }) };
    expect(
      classifyRequest(messages, { providerID: 'some-proxy', id: 'auto/fast' }, fast)?.profile
    ).toBe('anthropic');
    const noClaude = { patterns: parseCacheProfiles({ claude: 'implicit' }) };
    expect(
      classifyRequest(messages, { providerID: 'some-proxy', id: 'claude-haiku-5-5' }, noClaude)
        ?.profile
    ).toBe('implicit');
    expect(
      classifyRequest(messages, { providerID: 'anthropic', id: 'claude-haiku-5-5' }, noClaude)
        ?.profile
    ).toBe('anthropic');
  });

  test('on the Messages wire a learned profile counts after the Claude regex', () => {
    const messages = chat('https://proxy.example/v1/messages');
    const ref = { providerID: 'some-proxy', id: 'auto/fast' };
    expect(
      classifyRequest(messages, ref, { patterns: [], learned: () => 'anthropic' })?.profile
    ).toBe('anthropic');
    expect(
      classifyRequest(messages, ref, { patterns: [], learned: () => 'implicit' })?.profile
    ).toBe('implicit');
    expect(classifyRequest(messages, ref, { patterns: [], learned: () => 'openai' })?.profile).toBe(
      'implicit'
    );
    const gpt = { providerID: 'some-proxy', id: 'gpt-6-luna' };
    expect(classifyRequest(messages, gpt, { patterns: [], learned: () => 'openai' })?.profile).toBe(
      'implicit'
    );
    expect(classifyRequest(messages, gpt, noDeps)?.profile).toBe('implicit');
  });

  test('on the Messages wire a pattern mapping to openai classifies implicit', () => {
    const messages = chat('https://proxy.example/v1/messages');
    const deps = { patterns: parseCacheProfiles({ 'auto/fast': 'openai' }) };
    expect(
      classifyRequest(messages, { providerID: 'some-proxy', id: 'auto/fast' }, deps)?.profile
    ).toBe('implicit');
  });

  test('GET and other paths are not classified', () => {
    const ref = { providerID: 'openrouter', id: 'anthropic/claude-haiku-5.5' };
    expect(classifyRequest(chat(undefined, 'GET'), ref, noDeps)).toBeUndefined();
    expect(
      classifyRequest(chat('https://omni.example/v1/embeddings'), ref, noDeps)
    ).toBeUndefined();
  });

  test('a GPT-5.6+ model is openai on both OpenAI wires, an older one is implicit', () => {
    const responses = (url = 'https://omni.example/v1/responses') =>
      new Request(url, { method: 'POST' });
    for (const id of ['openai/gpt-6-luna', 'auto/gpt-5.6', 'gpt-5.7-mini']) {
      const ref = { providerID: 'openrouter', id };
      expect(classifyRequest(chat(), ref, noDeps)).toEqual({
        wire: 'openai-chat',
        profile: 'openai',
      });
      expect(classifyRequest(responses(), ref, noDeps)).toEqual({
        wire: 'openai-responses',
        profile: 'openai',
      });
    }
    for (const id of ['openai/gpt-5', 'openai/gpt-5.5', 'openai/gpt-4o', 'azure/gpt-35-turbo']) {
      const ref = { providerID: 'openrouter', id };
      expect(classifyRequest(chat(), ref, noDeps)?.profile).toBe('implicit');
      expect(classifyRequest(responses(), ref, noDeps)?.profile).toBe('implicit');
    }
  });

  test('a Responses request resolves Claude, learned and user profiles like chat', () => {
    const post = new Request('https://omni.example/v1/responses', { method: 'POST' });
    const claude = { providerID: 'omniroute', id: 'auto/claude-opus-5-5' };
    expect(classifyRequest(post, claude, noDeps)).toEqual({
      wire: 'openai-responses',
      profile: 'anthropic',
    });
    const alias = { providerID: 'omniroute', id: 'auto/alias' };
    expect(
      classifyRequest(post, alias, { patterns: [], learned: () => 'anthropic' })?.profile
    ).toBe('anthropic');
    expect(
      classifyRequest(post, alias, { patterns: parseCacheProfiles({ alias: 'openai' }) })?.profile
    ).toBe('openai');
  });

  test('a user pattern outranks the GPT regex, which outranks a learned profile', () => {
    const ref = { providerID: 'openrouter', id: 'openai/gpt-6-luna' };
    expect(
      classifyRequest(chat(), ref, { patterns: parseCacheProfiles({ 'gpt-6': 'implicit' }) })
        ?.profile
    ).toBe('implicit');
    expect(classifyRequest(chat(), ref, { patterns: [], learned: () => 'implicit' })?.profile).toBe(
      'openai'
    );
  });

  test('the Claude regex wins over the GPT regex', () => {
    const ref = { providerID: 'omniroute', id: 'auto/claude-gpt-6' };
    expect(classifyRequest(chat(), ref, noDeps)?.profile).toBe('anthropic');
  });

  test('the built-in GPT regex also checks the body model', () => {
    const ref = { providerID: 'omniroute', id: 'auto/fast' };
    expect(classifyRequest(chat(), ref, noDeps, 'openai/gpt-6-luna')?.profile).toBe('openai');
  });

  test('a bad URL is not classified', () => {
    const request = { method: 'POST', url: 'not a url' } as Request;
    expect(classifyRequest(request, { providerID: 'p', id: 'm' }, noDeps)).toBeUndefined();
  });
});

describe('classifyRequestWithBody', () => {
  const ref = { providerID: 'omniroute', id: 'auto/opus-5' };
  const withBody = (model: unknown) =>
    new Request('https://omni.example/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model }),
    });

  test('reads body.model when the model ID alone is implicit', async () => {
    expect(
      (await classifyRequestWithBody(withBody('anthropic/claude-opus-5'), ref, noDeps, on))?.profile
    ).toBe('anthropic');
  });

  test('leaves the request body readable', async () => {
    const request = withBody('anthropic/claude-opus-5');
    await classifyRequestWithBody(request, ref, noDeps, on);
    expect(await request.json()).toEqual({ model: 'anthropic/claude-opus-5' });
  });

  test('a non-Claude body model, a missing model and an unparseable body stay implicit', async () => {
    expect((await classifyRequestWithBody(withBody('deepseek/v4'), ref, noDeps, on))?.profile).toBe(
      'implicit'
    );
    expect((await classifyRequestWithBody(withBody(7), ref, noDeps, on))?.profile).toBe('implicit');
    const broken = new Request('https://omni.example/v1/chat/completions', {
      method: 'POST',
      body: '{',
    });
    expect((await classifyRequestWithBody(broken, ref, noDeps, on))?.profile).toBe('implicit');
  });

  test('does not read the body for an unclassified request', async () => {
    const request = new Request('https://x.test/v1/embeddings', { method: 'POST', body: '{}' });
    const spy = spyOn(request, 'clone');
    expect(await classifyRequestWithBody(request, ref, noDeps, on)).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  test('on the Messages wire reads body.model behind an alias, with or without the option', async () => {
    const messages = () =>
      new Request('https://proxy.example/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ model: 'anthropic/claude-x' }),
      });
    const alias = { providerID: 'some-proxy', id: 'auto/fast' };
    for (const openaiWires of [false, true]) {
      expect(await classifyRequestWithBody(messages(), alias, noDeps, { openaiWires })).toEqual({
        wire: 'anthropic-messages',
        profile: 'anthropic',
      });
    }
    const deepseek = new Request('https://proxy.example/v1/messages', {
      method: 'POST',
      body: JSON.stringify({ model: 'deepseek/deepseek-v4.1-flash' }),
    });
    expect((await classifyRequestWithBody(deepseek, alias, noDeps, off))?.profile).toBe('implicit');
  });

  test('on the Messages wire never reads the body for an Anthropic ID or a Claude model ID', async () => {
    for (const trusted of [
      { providerID: 'anthropic', id: 'auto/fast' },
      { providerID: 'omniroute-anthropic', id: 'auto/fast' },
      { providerID: 'some-proxy', id: 'claude-haiku-5-5' },
    ]) {
      const request = new Request('https://proxy.example/v1/messages', {
        method: 'POST',
        body: '{}',
      });
      const spy = spyOn(request, 'clone');
      expect((await classifyRequestWithBody(request, trusted, noDeps, off))?.profile).toBe(
        'anthropic'
      );
      expect(spy).not.toHaveBeenCalled();
    }
  });

  test('with the option off an OpenAI-wire request never costs a parse', async () => {
    const request = withBody('anthropic/claude-opus-5');
    const spy = spyOn(request, 'clone');
    expect((await classifyRequestWithBody(request, ref, noDeps, off))?.profile).toBe('implicit');
    expect(spy).not.toHaveBeenCalled();
  });

  test('a learned openai never widens the GPT regex: the body model decides', async () => {
    const learned = () => 'openai' as const;
    expect(classifyRequest(withBody('gpt-6-luna'), ref, { patterns: [], learned })?.profile).toBe(
      'implicit'
    );
    expect(
      (await classifyRequestWithBody(withBody('gpt-5'), ref, { patterns: [], learned }, on))
        ?.profile
    ).toBe('implicit');
    expect(
      (await classifyRequestWithBody(withBody('gpt-6-luna'), ref, { patterns: [], learned }, on))
        ?.profile
    ).toBe('openai');
  });

  test('reads body.model on the Responses wire too', async () => {
    const request = new Request('https://omni.example/v1/responses', {
      method: 'POST',
      body: JSON.stringify({ model: 'openai/gpt-6-luna' }),
    });
    expect(await classifyRequestWithBody(request, ref, noDeps, on)).toEqual({
      wire: 'openai-responses',
      profile: 'openai',
    });
    expect(await request.json()).toEqual({ model: 'openai/gpt-6-luna' });
  });

  test('a pattern still outranks the body model', async () => {
    const deps = { patterns: parseCacheProfiles({ opus: 'implicit' }) };
    expect(
      (await classifyRequestWithBody(withBody('anthropic/claude-opus-5'), ref, deps, on))?.profile
    ).toBe('implicit');
  });

  test('a matching pattern, either way, never parses the body', async () => {
    for (const profile of ['implicit', 'anthropic'] as const) {
      const request = withBody('anthropic/claude-opus-5');
      const spy = spyOn(request, 'clone');
      await classifyRequestWithBody(
        request,
        ref,
        { patterns: parseCacheProfiles({ opus: profile }) },
        on
      );
      expect(spy).not.toHaveBeenCalled();
    }
  });
});

describe('isAnthropicMessagesRequest', () => {
  test('matches POST to a /messages path on any host', () => {
    const post = (url: string) => new Request(url, { method: 'POST', body: '{}' });
    expect(isAnthropicMessagesRequest(post('https://api.anthropic.com/v1/messages'))).toBe(true);
    expect(isAnthropicMessagesRequest(post('https://omniroute.linksy.au/v1/messages'))).toBe(true);
    expect(
      isAnthropicMessagesRequest(post('https://omniroute.linksy.au/v1/chat/completions'))
    ).toBe(false);
  });

  test('rejects non-POST', () => {
    expect(isAnthropicMessagesRequest(new Request('https://api.anthropic.com/v1/messages'))).toBe(
      false
    );
  });
});

describe('routeRequest', () => {
  const base: RouteInput = {
    cls: undefined,
    anthropicProvider: false,
    hasSentinel: false,
    openaiCompatible: false,
  };
  const route = (over: Partial<RouteInput>) => routeRequest({ ...base, ...over });
  const none: Route = {
    rewrites: false,
    wire: undefined,
    observedWire: undefined,
    profile: undefined,
    managed: false,
    transformWire: undefined,
  };

  test('an unclassified request is left alone', () => {
    expect(route({})).toEqual(none);
    expect(route({ openaiCompatible: true })).toEqual(none);
  });

  test('an Anthropic provider on /messages is rewritten and observed as anthropic-messages', () => {
    const cls = { wire: 'anthropic-messages', profile: 'anthropic' } as const;
    for (const openaiCompatible of [false, true]) {
      expect(route({ cls, anthropicProvider: true, openaiCompatible })).toEqual({
        ...none,
        rewrites: true,
        wire: 'anthropic-messages',
        observedWire: 'anthropic-messages',
        profile: 'anthropic',
        managed: true,
      });
    }
  });

  test('a proxied /messages request is rewritten when it is Claude, and only observed when implicit', () => {
    for (const openaiCompatible of [false, true]) {
      const claude = { wire: 'anthropic-messages', profile: 'anthropic' } as const;
      expect(route({ cls: claude, openaiCompatible })).toEqual({
        ...none,
        rewrites: true,
        wire: 'anthropic-messages',
        observedWire: 'anthropic-messages',
        profile: 'anthropic',
        managed: true,
      });
      const implicit = { wire: 'anthropic-messages', profile: 'implicit' } as const;
      expect(route({ cls: implicit, openaiCompatible })).toEqual({
        ...none,
        wire: 'anthropic-messages',
        observedWire: 'anthropic-messages',
        profile: 'implicit',
      });
      expect(route({ cls: implicit, openaiCompatible, hasSentinel: true })).toEqual({
        ...none,
        rewrites: true,
        wire: 'anthropic-messages',
        observedWire: 'anthropic-messages',
        profile: 'implicit',
      });
    }
  });

  test('an Anthropic provider on /chat/completions with the option off is rewritten as an Anthropic body', () => {
    const cls = { wire: 'openai-chat', profile: 'anthropic' } as const;
    expect(route({ cls, anthropicProvider: true })).toEqual({
      ...none,
      rewrites: true,
      wire: 'openai-chat',
      observedWire: 'anthropic-messages',
      profile: 'anthropic',
    });
  });

  test('openai-chat explicit with the option on is rewritten, injected and observed as openai-chat', () => {
    const cls = { wire: 'openai-chat', profile: 'anthropic' } as const;
    expect(route({ cls, openaiCompatible: true })).toEqual({
      rewrites: true,
      wire: 'openai-chat',
      observedWire: 'openai-chat',
      profile: 'anthropic',
      managed: true,
      transformWire: 'openai-chat',
    });
  });

  test('openai-chat explicit with the option off is untouched', () => {
    const cls = { wire: 'openai-chat', profile: 'anthropic' } as const;
    expect(route({ cls })).toEqual({ ...none, wire: 'openai-chat', profile: 'anthropic' });
  });

  test('openai-chat implicit with the option on is observed only', () => {
    const cls = { wire: 'openai-chat', profile: 'implicit' } as const;
    expect(route({ cls, openaiCompatible: true })).toEqual({
      ...none,
      wire: 'openai-chat',
      observedWire: 'openai-chat',
      profile: 'implicit',
      transformWire: 'openai-chat',
    });
  });

  test('openai-chat implicit with the option off is untouched', () => {
    const cls = { wire: 'openai-chat', profile: 'implicit' } as const;
    expect(route({ cls })).toEqual({ ...none, wire: 'openai-chat', profile: 'implicit' });
  });

  test('an openai profile is managed on both OpenAI wires with the option on, and only observed with it off', () => {
    for (const wire of ['openai-chat', 'openai-responses'] as const) {
      const cls = { wire, profile: 'openai' } as const;
      expect(route({ cls, openaiCompatible: true })).toEqual({
        rewrites: true,
        wire,
        observedWire: wire,
        profile: 'openai',
        managed: true,
        transformWire: wire,
      });
      expect(route({ cls })).toEqual({ ...none, wire, profile: 'openai' });
    }
  });

  test('an implicit Responses request is observed only', () => {
    const cls = { wire: 'openai-responses', profile: 'implicit' } as const;
    expect(route({ cls, openaiCompatible: true })).toEqual({
      ...none,
      wire: 'openai-responses',
      observedWire: 'openai-responses',
      profile: 'implicit',
      transformWire: 'openai-responses',
    });
  });

  test('the sentinel alone rewrites, through the OpenAI rewriter only on openai-chat', () => {
    expect(route({ hasSentinel: true })).toEqual({ ...none, rewrites: true });
    expect(route({ hasSentinel: true, cls: { wire: 'openai-chat', profile: 'implicit' } })).toEqual(
      {
        ...none,
        rewrites: true,
        wire: 'openai-chat',
        profile: 'implicit',
        transformWire: 'openai-chat',
      }
    );
    expect(
      route({ hasSentinel: true, cls: { wire: 'anthropic-messages', profile: 'anthropic' } })
    ).toEqual({
      ...none,
      rewrites: true,
      wire: 'anthropic-messages',
      observedWire: 'anthropic-messages',
      profile: 'anthropic',
      managed: true,
    });
  });

  // The former `implicit` flag is derived in the middleware now; request.test.ts covers it.
  test('matches the former inline expressions for every input', () => {
    const wires = [undefined, 'anthropic-messages', 'openai-chat'] as const;
    const profiles = ['anthropic', 'openai', 'implicit'] as const;
    const bools = [false, true];
    const cases = wires.flatMap((wire) =>
      profiles.flatMap((profile) =>
        bools.flatMap((anthropicProvider) =>
          bools.flatMap((hasSentinel) =>
            bools.map((openaiCompatible) => ({
              wire,
              profile,
              anthropicProvider,
              hasSentinel,
              openaiCompatible,
            }))
          )
        )
      )
    );
    for (const { wire, profile, anthropicProvider, hasSentinel, openaiCompatible } of cases) {
      const cls = wire ? { wire, profile } : undefined;
      const isChat = cls?.wire === 'openai-chat';
      const managedChat = isChat && openaiCompatible && cls.profile !== 'implicit';
      const explicitChat = managedChat && cls.profile === 'anthropic';
      const claudeMessages = cls?.wire === 'anthropic-messages' && cls.profile === 'anthropic';
      const observed =
        anthropicProvider || cls?.wire === 'anthropic-messages' || (isChat && openaiCompatible);
      const got = route({ cls, anthropicProvider, hasSentinel, openaiCompatible });
      expect(got.profile).toBe(cls?.profile);
      expect(got.wire).toBe(cls?.wire);
      expect(got.managed).toBe(managedChat || claudeMessages);
      for (const kind of ['primary', 'compaction', 'title', 'generate'] as const) {
        expect(shouldInject(got, kind, false)).toBe(
          explicitChat && (kind === 'primary' || kind === 'compaction')
        );
        expect(shouldInject(got, kind, true)).toBe(false);
      }
      expect(got.rewrites).toBe(anthropicProvider || hasSentinel || managedChat || claudeMessages);
      expect(got.observedWire !== undefined).toBe(observed);
      expect(got.transformWire).toBe(
        isChat && (openaiCompatible || hasSentinel) ? 'openai-chat' : undefined
      );
      let responseWire: Wire | undefined;
      if (cls?.wire === 'openai-chat' && openaiCompatible) responseWire = 'openai-chat';
      else if (anthropicProvider || cls?.wire === 'anthropic-messages') {
        responseWire = 'anthropic-messages';
      }
      expect(got.observedWire).toBe(responseWire);
      expect(observedWireFor(cls?.wire, anthropicProvider, openaiCompatible)).toBe(responseWire);
    }
  });

  test('observedWireFor needs only the wire, the provider and the option', () => {
    expect(observedWireFor('openai-chat', false, true)).toBe('openai-chat');
    expect(observedWireFor('openai-responses', false, true)).toBe('openai-responses');
    expect(observedWireFor('openai-responses', false, false)).toBeUndefined();
    expect(observedWireFor('openai-responses', true, false)).toBe('anthropic-messages');
    expect(observedWireFor('openai-chat', false, false)).toBeUndefined();
    expect(observedWireFor('openai-chat', true, false)).toBe('anthropic-messages');
    expect(observedWireFor(undefined, true, true)).toBe('anthropic-messages');
    expect(observedWireFor(undefined, false, true)).toBeUndefined();
  });
});

describe('keepsWarm', () => {
  const messages = () => chat('https://proxy.example/v1/messages');
  const alias = { providerID: 'some-proxy', id: 'auto/best' };

  test('follows the classified profile on the Messages wire', async () => {
    expect(await keepsWarm(messages(), alias, { patterns: [], learned: () => 'anthropic' })).toBe(
      true
    );
    expect(await keepsWarm(messages(), alias, { patterns: [], learned: () => 'implicit' })).toBe(
      false
    );
    expect(await keepsWarm(messages(), alias, noDeps)).toBe(false);
    expect(
      await keepsWarm(
        messages(),
        { providerID: 'some-proxy', id: 'claude-haiku-5-5' },
        { patterns: [], learned: () => 'implicit' }
      )
    ).toBe(true);
    expect(await keepsWarm(messages(), { providerID: 'anthropic', id: 'auto/best' }, noDeps)).toBe(
      true
    );
  });

  test("reads the body's model the way the request hook does", async () => {
    const request = new Request('https://proxy.example/v1/messages', {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-sonnet-5-5' }),
    });
    expect(await keepsWarm(request, alias, { patterns: [], learned: () => 'implicit' })).toBe(true);
  });

  test('is false for a profile that cannot handle the wire, or an unknown wire', async () => {
    const responses = () => chat('https://omni.example/v1/responses');
    expect(
      await keepsWarm(responses(), { providerID: 'omniroute', id: 'claude-haiku-5-5' }, noDeps)
    ).toBe(false);
    expect(
      await keepsWarm(responses(), { providerID: 'omniroute', id: 'gpt-6-luna' }, noDeps)
    ).toBe(true);
    expect(await keepsWarm(chat('https://omni.example/v1/embeddings'), alias, noDeps)).toBe(false);
  });
});

describe('shouldInject', () => {
  const explicit = routeRequest({
    cls: { wire: 'openai-chat', profile: 'anthropic' },
    anthropicProvider: false,
    hasSentinel: false,
    openaiCompatible: true,
  });
  const implicit = routeRequest({
    cls: { wire: 'openai-chat', profile: 'implicit' },
    anthropicProvider: false,
    hasSentinel: false,
    openaiCompatible: true,
  });

  test('injects on an explicit chat primary or compaction request that is not a ping', () => {
    expect(shouldInject(explicit, 'primary', false)).toBe(true);
    expect(shouldInject(explicit, 'compaction', false)).toBe(true);
    expect(shouldInject(explicit, 'title', false)).toBe(false);
    expect(shouldInject(explicit, 'generate', false)).toBe(false);
  });

  test('never injects a ping', () => {
    for (const kind of ['primary', 'compaction', 'title', 'generate'] as const) {
      expect(shouldInject(explicit, kind, true)).toBe(false);
    }
  });

  test('never injects a route that is not explicit chat', () => {
    expect(shouldInject(implicit, 'primary', false)).toBe(false);
    expect(
      shouldInject(
        routeRequest({
          cls: undefined,
          anthropicProvider: true,
          hasSentinel: false,
          openaiCompatible: true,
        }),
        'primary',
        false
      )
    ).toBe(false);
    for (const wire of ['openai-chat', 'openai-responses'] as const) {
      const openai = routeRequest({
        cls: { wire, profile: 'openai' },
        anthropicProvider: false,
        hasSentinel: false,
        openaiCompatible: true,
      });
      expect(shouldInject(openai, 'primary', false)).toBe(false);
    }
    const responses = routeRequest({
      cls: { wire: 'openai-responses', profile: 'anthropic' },
      anthropicProvider: false,
      hasSentinel: false,
      openaiCompatible: true,
    });
    expect(shouldInject(responses, 'primary', false)).toBe(false);
  });
});

describe('profileForRoute', () => {
  const base: RouteInput = {
    cls: undefined,
    anthropicProvider: false,
    hasSentinel: false,
    openaiCompatible: false,
  };
  const pick = (over: Partial<RouteInput>) => {
    const input = { ...base, ...over };
    return profileForRoute(routeRequest(input), input.openaiCompatible);
  };
  const gptChat = { wire: 'openai-chat', profile: 'openai' } as const;

  test('a request that is neither rewritten nor observed gets no profile', () => {
    expect(pick({})).toBeUndefined();
    expect(pick({ cls: gptChat })).toBeUndefined();
    expect(pick({ cls: { wire: 'openai-responses', profile: 'implicit' } })).toBeUndefined();
  });

  test('an Anthropic Messages request uses the anthropic profile', () => {
    const cls = { wire: 'anthropic-messages', profile: 'anthropic' } as const;
    for (const openaiCompatible of [false, true]) {
      expect(pick({ cls, openaiCompatible })).toBe('anthropic');
      expect(pick({ cls, anthropicProvider: true, openaiCompatible })).toBe('anthropic');
    }
  });

  test('a Messages request uses its classified profile, and openai falls back to implicit', () => {
    for (const openaiCompatible of [false, true]) {
      for (const hasSentinel of [false, true]) {
        const pickMessages = (profile: 'anthropic' | 'openai' | 'implicit') =>
          pick({ cls: { wire: 'anthropic-messages', profile }, openaiCompatible, hasSentinel });
        expect([
          pickMessages('anthropic'),
          pickMessages('openai'),
          pickMessages('implicit'),
        ]).toEqual(['anthropic', 'implicit', 'implicit']);
      }
    }
  });

  test('with the option off, an OpenAI-wire request goes through the anthropic profile only with the sentinel', () => {
    expect(pick({ cls: gptChat })).toBeUndefined();
    expect(pick({ cls: gptChat, hasSentinel: true })).toBe('anthropic');
    expect(
      pick({ cls: { wire: 'openai-responses', profile: 'implicit' }, hasSentinel: true })
    ).toBe('implicit');
  });

  test('an Anthropic provider on an OpenAI wire with the option off is an Anthropic body', () => {
    expect(pick({ cls: gptChat, anthropicProvider: true })).toBe('anthropic');
  });

  test('a sentinel or Anthropic provider on an unknown wire uses the anthropic profile', () => {
    expect(pick({ hasSentinel: true })).toBe('anthropic');
    expect(pick({ anthropicProvider: true, openaiCompatible: true })).toBe('anthropic');
  });

  test('with the option on, an OpenAI-wire request uses its classified profile', () => {
    for (const wire of ['openai-chat', 'openai-responses'] as const) {
      for (const profile of ['openai', 'implicit'] as const) {
        expect(pick({ cls: { wire, profile }, openaiCompatible: true })).toBe(profile);
        expect(pick({ cls: { wire, profile }, openaiCompatible: true, hasSentinel: true })).toBe(
          profile
        );
      }
    }
    expect(
      pick({ cls: { wire: 'openai-chat', profile: 'anthropic' }, openaiCompatible: true })
    ).toBe('anthropic');
  });

  test('a profile that cannot rewrite the wire falls back to implicit: Claude on /responses is observed only', () => {
    const cls = { wire: 'openai-responses', profile: 'anthropic' } as const;
    expect(pick({ cls, openaiCompatible: true })).toBe('implicit');
    expect(pick({ cls, openaiCompatible: true, hasSentinel: true })).toBe('implicit');
    expect(pick({ cls, openaiCompatible: true, anthropicProvider: true })).toBe('implicit');
  });
});
