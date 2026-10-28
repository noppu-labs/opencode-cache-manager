import { describe, expect, spyOn, test } from 'bun:test';

import { parseCacheProfiles } from '../../src/config/model-patterns.ts';
import type { PluginOptions } from '../../src/config/settings.ts';
import { BUILTIN_DEFAULTS } from '../../src/config/settings.ts';
import { EXTENDED_CACHE_BETA, SENTINEL_HEADER } from '../../src/constants/anthropic.ts';
import { PING_PROMPT } from '../../src/constants/keepalive.ts';
import { createRequestHook, type HttpRequestEvent } from '../../src/middleware/request.ts';
import type { CacheProfileId, ModelRef } from '../../src/models/cache.ts';
import type { CacheUsage } from '../../src/models/cache.ts';
import type { SkipReason } from '../../src/models/keepalive.ts';
import { KeepaliveEngine } from '../../src/services/keepalive-engine.ts';
import { PingTracker } from '../../src/services/ping-tracker.ts';
import { openaiProfile } from '../../src/services/profiles/openai.ts';
import { SettingsStore } from '../../src/services/settings-store.ts';
import {
  collectCacheControls,
  ephemeral,
  makeRequest,
  parsedBodyOf,
  sampleBody,
} from '../helpers/fixtures.ts';
import { memoryKv } from '../helpers/memory-kv.ts';

function harness(
  config: { options?: Partial<PluginOptions>; profiles?: Map<string, CacheProfileId> } = {}
) {
  const options: PluginOptions = { openaiCompatible: true, cacheProfiles: [], ...config.options };
  const learned = config.profiles ?? new Map<string, CacheProfileId>();
  const profiles = { get: (ref: ModelRef) => learned.get(`${ref.providerID}/${ref.id}`) };
  const { kv } = memoryKv();
  const store = new SettingsStore(kv, {});
  const pings = new PingTracker();
  const primaryMessages = new Map<string, unknown[]>();
  const sent: Array<{
    sessionID: string;
    info: { requestedTtl: string | null; isPing: boolean; kind: string };
  }> = [];
  const fake = {
    skipReason: null as SkipReason | null,
    failRequestSent: false,
    failSnapshot: false,
  };
  const engine = {
    snapshot: () => {
      if (fake.failSnapshot) throw new Error('snapshot failed');
      return { skipReason: fake.skipReason };
    },
    requestSent: (
      sessionID: string,
      info: { requestedTtl: string | null; isPing: boolean; kind: string }
    ) => {
      sent.push({ sessionID, info });
      if (fake.failRequestSent) throw new Error('engine down');
    },
  } as unknown as KeepaliveEngine;
  const hook = createRequestHook({ store, engine, pings, options, profiles, primaryMessages });

  async function dispatch(
    request: Request,
    overrides: Partial<Pick<HttpRequestEvent, 'sessionID' | 'kind'>> & {
      providerID?: string;
      modelID?: string;
    } = {}
  ) {
    const { providerID = 'anthropic', modelID = 'claude-sonnet-5-5', ...rest } = overrides;
    const evt: HttpRequestEvent = {
      sessionID: 'ses_a',
      kind: 'primary',
      model: { providerID, id: modelID },
      request,
      ...rest,
    };
    await hook(evt);
    return evt;
  }

  /** Runs `run` while a ping is pending for `sessionID`, so `generate` requests count as pings. */
  async function duringPing<T>(sessionID: string, run: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const sending = pings.send(sessionID, () => gate);
    try {
      return await run();
    } finally {
      release();
      await sending;
    }
  }

  return { store, pings, primaryMessages, sent, fake, dispatch, duringPing };
}

const body = (value: Record<string, unknown> = sampleBody()) => makeRequest(JSON.stringify(value));
const messagesOf = async (request: Request) =>
  ((await parsedBodyOf(request)) as any).messages as unknown[];
const userText = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] });

describe('createRequestHook TTL rewrite', () => {
  test('rewrites requests for omniroute-anthropic', async () => {
    const h = harness();
    await h.store.setSession('ses_a', { mode: '1h' });
    const evt = await h.dispatch(body(), { providerID: 'omniroute-anthropic' });
    expect(evt.request.headers.get('anthropic-beta')).toBe(EXTENDED_CACHE_BETA);
  });

  test('rewrites requests for anthropic', async () => {
    const h = harness();
    await h.store.setSession('ses_a', { mode: '1h' });
    const evt = await h.dispatch(body());
    for (const cc of collectCacheControls(await parsedBodyOf(evt.request)))
      expect(cc.ttl).toBe('1h');
  });

  test('leaves the request alone in the default 5m mode', async () => {
    const h = harness();
    const request = body();
    const evt = await h.dispatch(request);
    expect(evt.request.headers.get('anthropic-beta')).toBeNull();
    for (const cc of collectCacheControls(await parsedBodyOf(evt.request)))
      expect('ttl' in cc).toBe(false);
  });

  test('ignores unrelated providers and models without a sentinel header', async () => {
    const h = harness();
    await h.store.setSession('ses_a', { mode: '1h' });
    const request = body({ ...sampleBody(), model: 'deepseek/deepseek-v4.1-flash' });
    const evt = await h.dispatch(request, {
      providerID: 'omniroute',
      modelID: 'deepseek/deepseek-v4.1-flash',
    });
    expect(evt.request).toBe(request);
  });

  test('honors the sentinel header even on an unrelated provider', async () => {
    const h = harness();
    const request = makeRequest(JSON.stringify(sampleBody()), { [SENTINEL_HEADER]: '1h' });
    const evt = await h.dispatch(request, { providerID: 'omniroute' });
    expect(evt.request).not.toBe(request);
    expect(evt.request.headers.has(SENTINEL_HEADER)).toBe(false);
    expect(evt.request.headers.get('anthropic-beta')).toBe(EXTENDED_CACHE_BETA);
  });

  test('two sessions with different modes get different rewrites', async () => {
    const h = harness();
    await h.store.setSession('ses_a', { mode: '1h' });
    await h.store.setSession('ses_b', { mode: 'hybrid' });

    const a = await h.dispatch(body(), { sessionID: 'ses_a' });
    const b = await h.dispatch(body(), { sessionID: 'ses_b' });

    const aBody = (await parsedBodyOf(a.request)) as { messages: Record<string, unknown>[] };
    const bBody = (await parsedBodyOf(b.request)) as { messages: Record<string, unknown>[] };
    expect((aBody.messages[2].cache_control as Record<string, unknown>).ttl).toBe('1h');
    expect('ttl' in (bBody.messages[2].cache_control as Record<string, unknown>)).toBe(false);
    expect(collectCacheControls(bBody).some((cc) => cc.ttl === '1h')).toBe(true);
  });

  test('a session without an override uses the global mode', async () => {
    const h = harness();
    await h.store.setGlobal({ mode: '1h' });
    await h.store.setSession('ses_a', { mode: '5m' });

    const a = await h.dispatch(body(), { sessionID: 'ses_a' });
    const other = await h.dispatch(body(), { sessionID: 'ses_other' });

    expect(a.request.headers.get('anthropic-beta')).toBeNull();
    expect(other.request.headers.get('anthropic-beta')).toBe(EXTENDED_CACHE_BETA);
  });

  test('x-cache-ttl wins over the session mode', async () => {
    const h = harness();
    await h.store.setSession('ses_a', { mode: '1h' });
    const request = makeRequest(JSON.stringify(sampleBody()), { [SENTINEL_HEADER]: '5m' });
    const evt = await h.dispatch(request);
    expect(evt.request.headers.has(SENTINEL_HEADER)).toBe(false);
    expect(evt.request.headers.get('anthropic-beta')).toBeNull();
    for (const cc of collectCacheControls(await parsedBodyOf(evt.request)))
      expect('ttl' in cc).toBe(false);
  });

  test('picks up a session mode changed after an earlier request', async () => {
    const h = harness();
    const first = await h.dispatch(body());
    expect(first.request.headers.get('anthropic-beta')).toBeNull();

    await h.store.setSession('ses_a', { mode: '1h' });
    const second = await h.dispatch(body());
    expect(second.request.headers.get('anthropic-beta')).toBe(EXTENDED_CACHE_BETA);
  });

  test('a rejecting storage lookup still rewrites with the global mode', async () => {
    const { kv } = memoryKv();
    const store = new SettingsStore(kv, {});
    await store.setGlobal({ mode: '1h' });
    kv.get = async () => {
      throw new Error('storage down');
    };
    const hook = createRequestHook({
      store,
      engine: {
        snapshot: () => ({ skipReason: null }),
        requestSent: () => {},
      } as unknown as KeepaliveEngine,
      pings: new PingTracker(),
      options: { openaiCompatible: true, cacheProfiles: [] },
      profiles: { get: () => undefined },
      primaryMessages: new Map(),
    });
    const evt: HttpRequestEvent = {
      sessionID: 'ses_never_seen',
      kind: 'primary',
      model: { providerID: 'anthropic', id: 'claude-sonnet-5-5' },
      request: body(),
    };
    await hook(evt);

    expect(
      collectCacheControls(await parsedBodyOf(evt.request)).every((cc) => cc.ttl === '1h')
    ).toBe(true);
    expect(evt.request.headers.get('anthropic-beta')).toBe(EXTENDED_CACHE_BETA);
  });
});

describe('createRequestHook engine reporting', () => {
  test('a non-Anthropic provider and URL are neither rewritten nor reported', async () => {
    const h = harness();
    const request = new Request('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      body: JSON.stringify(sampleBody()),
    });
    const evt = await h.dispatch(request, { providerID: 'openai' });
    expect(evt.request).toBe(request);
    expect(h.sent).toHaveLength(0);
    expect(h.primaryMessages.size).toBe(0);
  });

  test('an Anthropic-shaped URL on an unknown provider is rewritten when the model is Claude', async () => {
    const h = harness();
    await h.store.setSession('ses_a', { mode: '1h' });
    const request = new Request('https://proxy.example/anthropic/v1/messages', {
      method: 'POST',
      body: JSON.stringify(sampleBody()),
    });
    const evt = await h.dispatch(request, { providerID: 'some-proxy' });
    expect(evt.request).not.toBe(request);
    for (const cc of collectCacheControls(await parsedBodyOf(evt.request)))
      expect(cc.ttl).toBe('1h');
    expect(h.sent).toEqual([
      { sessionID: 'ses_a', info: { requestedTtl: '1h', isPing: false, kind: 'primary' } },
    ]);
  });

  test('an Anthropic-shaped URL on an unknown provider is reported but not rewritten when the model is not Claude', async () => {
    const h = harness();
    await h.store.setSession('ses_a', { mode: '1h' });
    const request = new Request('https://proxy.example/anthropic/v1/messages', {
      method: 'POST',
      body: JSON.stringify({ ...sampleBody(), model: 'deepseek/deepseek-v4.1-flash' }),
    });
    const evt = await h.dispatch(request, {
      providerID: 'some-proxy',
      modelID: 'deepseek/deepseek-v4.1-flash',
    });
    expect(evt.request).toBe(request);
    expect(h.sent).toEqual([
      { sessionID: 'ses_a', info: { requestedTtl: null, isPing: false, kind: 'primary' } },
    ]);
  });

  test('a sentinel request on an unobserved URL is rewritten but not reported', async () => {
    const h = harness();
    const request = new Request('https://example.com/v1/chat', {
      method: 'POST',
      headers: { [SENTINEL_HEADER]: '1h' },
      body: JSON.stringify(sampleBody()),
    });
    const evt = await h.dispatch(request, { providerID: 'omniroute' });
    expect(evt.request.headers.has(SENTINEL_HEADER)).toBe(false);
    expect(evt.request.headers.get('anthropic-beta')).toBe(EXTENDED_CACHE_BETA);
    expect(h.sent).toHaveLength(0);
    expect(h.primaryMessages.size).toBe(0);
  });

  test.each([
    ['5m', undefined, '5m'],
    ['1h', undefined, '1h'],
    ['hybrid', undefined, '5m'],
    ['5m', '1h', '1h'],
    ['1h', '5m', '5m'],
    ['1h', 'hybrid', '5m'],
    ['5m', 'bogus', '5m'],
  ] as const)(
    'session mode %s with sentinel %s requests a %s TTL',
    async (mode, sentinel, expected) => {
      const h = harness();
      await h.store.setSession('ses_a', { mode });
      const headers: Record<string, string> = sentinel ? { [SENTINEL_HEADER]: sentinel } : {};
      await h.dispatch(makeRequest(JSON.stringify(sampleBody()), headers));
      expect(h.sent[0].info.requestedTtl).toBe(expected);
    }
  );

  test('the requested TTL is read before the sentinel is stripped', async () => {
    const h = harness();
    const request = makeRequest(JSON.stringify(sampleBody()), { [SENTINEL_HEADER]: '1h' });
    const evt = await h.dispatch(request);
    expect(evt.request.headers.has(SENTINEL_HEADER)).toBe(false);
    expect(h.sent).toEqual([
      { sessionID: 'ses_a', info: { requestedTtl: '1h', isPing: false, kind: 'primary' } },
    ]);
  });

  test('reports the session and marks a generate request as a ping only while one is pending', async () => {
    const h = harness();
    await h.dispatch(body(), { sessionID: 'ses_b', kind: 'generate' });
    await h.duringPing('ses_b', () => h.dispatch(body(), { sessionID: 'ses_b', kind: 'generate' }));

    expect(h.sent.map((s) => [s.sessionID, s.info.isPing])).toEqual([
      ['ses_b', false],
      ['ses_b', true],
    ]);
  });

  test('only a generate request counts as a ping', async () => {
    const h = harness();
    await h.duringPing('ses_a', async () => {
      await h.dispatch(body(), { kind: 'primary' });
      await h.dispatch(body(), { kind: 'title' });
      await h.dispatch(body(), { kind: 'compaction' });
    });
    expect(h.sent.map((s) => s.info.isPing)).toEqual([false, false, false]);
  });

  test('ping flag is per session', async () => {
    const h = harness();
    await h.duringPing('ses_a', async () => {
      await h.dispatch(body(), { sessionID: 'ses_b', kind: 'generate' });
      await h.dispatch(body(), { sessionID: 'ses_a', kind: 'generate' });
    });
    expect(h.sent.map((s) => [s.sessionID, s.info.isPing])).toEqual([
      ['ses_b', false],
      ['ses_a', true],
    ]);
  });

  test('a ping on an unobserved request is not reported as one', async () => {
    const h = harness();
    const request = new Request('https://example.com/v1/chat', {
      method: 'POST',
      headers: { [SENTINEL_HEADER]: '1h' },
      body: JSON.stringify(sampleBody()),
    });
    await h.duringPing('ses_a', () =>
      h.dispatch(request, { providerID: 'omniroute', kind: 'generate' })
    );
    expect(h.sent).toHaveLength(0);
  });

  test('an engine failure never fails the request', async () => {
    const h = harness();
    h.fake.failRequestSent = true;
    await h.store.setSession('ses_a', { mode: '1h' });
    const evt = await h.dispatch(body());
    expect(evt.request.headers.get('anthropic-beta')).toBe(EXTENDED_CACHE_BETA);
    expect(h.sent).toHaveLength(1);
  });

  test('a failing snapshot never fails the request', async () => {
    const h = harness();
    h.fake.failSnapshot = true;
    await h.store.setSession('ses_a', { mode: '1h' });
    const evt = await h.dispatch(body());
    expect(evt.request.headers.get('anthropic-beta')).toBe(EXTENDED_CACHE_BETA);
  });
});

describe('createRequestHook ping alignment', () => {
  test("stores the primary request's messages", async () => {
    const h = harness();
    const evt = await h.dispatch(body());
    expect(h.primaryMessages.get('ses_a')).toEqual(await messagesOf(evt.request));
  });

  test("keeps the latest primary's messages", async () => {
    const h = harness();
    await h.dispatch(body());
    const later = sampleBody();
    later.messages = [userText('later')];
    await h.dispatch(body(later));
    expect(h.primaryMessages.get('ses_a')).toEqual([userText('later')]);
  });

  test('does not store messages from other kinds', async () => {
    const h = harness();
    await h.dispatch(body(), { kind: 'title' });
    await h.dispatch(body(), { kind: 'generate' });
    expect(h.primaryMessages.size).toBe(0);
  });

  test('does not store the messages of a child session', async () => {
    const h = harness();
    h.fake.skipReason = 'child';
    await h.dispatch(body());
    expect(h.primaryMessages.has('ses_a')).toBe(false);
  });

  test('stores messages when the session is skipped for another reason', async () => {
    const h = harness();
    h.fake.skipReason = 'busy';
    await h.dispatch(body());
    expect(h.primaryMessages.has('ses_a')).toBe(true);
  });

  test('a primary request body is never altered by alignment', async () => {
    const h = harness();
    await h.dispatch(body());
    const original = sampleBody();
    const evt = await h.dispatch(body(original));
    expect(await messagesOf(evt.request)).toEqual(original.messages as unknown[]);
  });

  test("the ping's history is replaced by the stored primary messages", async () => {
    const h = harness();
    await h.store.setSession('ses_a', { mode: '1h' });
    const primary = await h.dispatch(body());
    const primaryMessages = await messagesOf(primary.request);

    const diverging = sampleBody();
    diverging.messages = [
      userText('rewritten 0'),
      { role: 'assistant', content: [{ type: 'text', text: 'rewritten 1' }] },
      userText('rewritten 2'),
      userText(PING_PROMPT),
    ];
    const ping = await h.duringPing('ses_a', () =>
      h.dispatch(body(diverging), { kind: 'generate' })
    );
    const sent = await messagesOf(ping.request);

    expect(sent).toHaveLength(4);
    expect(sent.slice(0, 3)).toEqual(primaryMessages);
    expect(sent[3]).toEqual((diverging.messages as unknown[])[3]);
  });

  test("the ping body has exactly the primary's cache_control occurrences in messages", async () => {
    const h = harness();
    await h.store.setSession('ses_a', { mode: '1h' });
    const primary = await h.dispatch(body());
    const primaryMessages = await messagesOf(primary.request);
    expect(collectCacheControls(primaryMessages).length).toBeGreaterThan(0);

    const marked = (text: string) => ({
      role: 'user',
      cache_control: ephemeral(),
      content: [{ type: 'text', text, cache_control: ephemeral() }],
    });
    const diverging = sampleBody();
    diverging.messages = [
      marked('d0'),
      marked('d1'),
      marked('d2'),
      marked('d3'),
      marked(PING_PROMPT),
    ];
    const ping = await h.duringPing('ses_a', () =>
      h.dispatch(body(diverging), { kind: 'generate' })
    );
    const sent = await messagesOf(ping.request);

    expect(sent).toHaveLength(5);
    expect(collectCacheControls(sent)).toHaveLength(collectCacheControls(primaryMessages).length);
    expect(JSON.stringify(sent.slice(0, 3))).toBe(JSON.stringify(primaryMessages));
    expect(collectCacheControls(sent.slice(3))).toHaveLength(0);
  });

  test('a ping with no stored primary is sent as-is, keeping its own cache_control', async () => {
    const h = harness();
    const own = sampleBody();
    const ping = await h.duringPing('ses_a', () => h.dispatch(body(own), { kind: 'generate' }));
    const sent = await messagesOf(ping.request);

    expect(sent).toEqual(own.messages as unknown[]);
    expect(collectCacheControls(sent)).toHaveLength(2);
  });

  test('a generate request outside a ping is not aligned', async () => {
    const h = harness();
    await h.dispatch(body());
    const own = sampleBody();
    own.messages = [userText('own 0'), userText('own 1')];
    const evt = await h.dispatch(body(own), { kind: 'generate' });
    expect(await messagesOf(evt.request)).toEqual(own.messages as unknown[]);
  });

  test("a ping of another session is not aligned to this session's messages", async () => {
    const h = harness();
    await h.dispatch(body(), { sessionID: 'ses_a' });
    const own = sampleBody();
    own.messages = [userText('own 0'), userText('own 1')];
    const ping = await h.duringPing('ses_b', () =>
      h.dispatch(body(own), { sessionID: 'ses_b', kind: 'generate' })
    );
    expect(await messagesOf(ping.request)).toEqual(own.messages as unknown[]);
  });

  test('stored messages are kept across pings', async () => {
    const h = harness();
    await h.dispatch(body());
    const stored = structuredClone(h.primaryMessages.get('ses_a'));

    const diverging = () => {
      const value = sampleBody();
      value.messages = [userText('rewritten 0'), userText(PING_PROMPT)];
      return value;
    };
    for (let i = 0; i < 2; i++) {
      const ping = await h.duringPing('ses_a', () =>
        h.dispatch(body(diverging()), { kind: 'generate' })
      );
      expect((await messagesOf(ping.request))[0]).toEqual(stored![0]);
    }
    expect(h.primaryMessages.get('ses_a')).toEqual(stored);
  });

  test('a compaction request drops the stored primary messages', async () => {
    const h = harness();
    await h.dispatch(body());
    await h.dispatch(body(), { kind: 'compaction' });
    expect(h.primaryMessages.has('ses_a')).toBe(false);

    const own = sampleBody();
    own.messages = [userText('own 0'), userText(PING_PROMPT)];
    const ping = await h.duringPing('ses_a', () => h.dispatch(body(own), { kind: 'generate' }));
    expect(await messagesOf(ping.request)).toEqual(own.messages as unknown[]);
  });

  test("a compaction request drops only its own session's messages", async () => {
    const h = harness();
    await h.dispatch(body(), { sessionID: 'ses_a' });
    await h.dispatch(body(), { sessionID: 'ses_b' });
    await h.dispatch(body(), { sessionID: 'ses_a', kind: 'compaction' });
    expect(h.primaryMessages.has('ses_b')).toBe(true);
  });

  test('a compaction request is reported to the engine', async () => {
    const h = harness();
    await h.dispatch(body(), { kind: 'compaction' });
    expect(h.sent).toHaveLength(1);
  });

  describe('after the session mode changes', () => {
    const breakpointTtls = (value: any): string[] =>
      collectCacheControls([value.tools, value.system, value.messages]).map(
        (cc) => (cc.ttl ?? '5m') as string
      );

    /** Stores a primary in `from`, switches the session to `to` and returns the ping request. */
    async function pingAfterModeChange(from: '5m' | '1h' | 'hybrid', to: '5m' | '1h' | 'hybrid') {
      const h = harness();
      await h.store.setSession('ses_a', { mode: from });
      await h.dispatch(body());
      await h.store.setSession('ses_a', { mode: to });
      const diverging = sampleBody();
      (diverging.messages as unknown[]).push(userText(PING_PROMPT));
      const ping = await h.duringPing('ses_a', () =>
        h.dispatch(body(diverging), { kind: 'generate' })
      );
      return ping.request;
    }

    test('a ping after switching 1h -> 5m carries no 1h breakpoint and no extended beta', async () => {
      const sent = await pingAfterModeChange('1h', '5m');
      const ttls = breakpointTtls(await parsedBodyOf(sent));
      expect(ttls.length).toBeGreaterThan(0);
      expect(ttls.every((ttl) => ttl === '5m')).toBe(true);
      expect(sent.headers.get('anthropic-beta') ?? '').not.toContain(EXTENDED_CACHE_BETA);
    });

    test('a ping after switching 5m -> 1h is all 1h and carries the extended beta', async () => {
      const sent = await pingAfterModeChange('5m', '1h');
      const parsed = await parsedBodyOf(sent);
      const ttls = breakpointTtls(parsed);
      expect(ttls.length).toBeGreaterThan(0);
      expect(ttls.every((ttl) => ttl === '1h')).toBe(true);
      expect(sent.headers.get('anthropic-beta')).toBe(EXTENDED_CACHE_BETA);
      expect(collectCacheControls((parsed.messages as unknown[]).slice(3))).toHaveLength(0);
    });

    test('a hybrid ping after a 1h primary keeps 1h breakpoints ahead of 5m ones', async () => {
      const sent = await pingAfterModeChange('1h', 'hybrid');
      const ttls = breakpointTtls(await parsedBodyOf(sent));
      const firstShort = ttls.indexOf('5m');
      expect(firstShort).toBeGreaterThan(0);
      expect(ttls.slice(firstShort).every((ttl) => ttl === '5m')).toBe(true);
      expect(sent.headers.get('anthropic-beta')).toBe(EXTENDED_CACHE_BETA);
    });
  });

  test('the aligned ping request keeps the original abort signal', async () => {
    const h = harness();
    await h.dispatch(body());
    const controller = new AbortController();
    const request = new Request('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify(sampleBody()),
      signal: controller.signal,
    });
    const ping = await h.duringPing('ses_a', () => h.dispatch(request, { kind: 'generate' }));

    expect(ping.request).not.toBe(request);
    expect(ping.request.signal.aborted).toBe(false);
    controller.abort();
    expect(ping.request.signal.aborted).toBe(true);
  });

  test('an unparseable ping request still passes through', async () => {
    const h = harness();
    await h.dispatch(body());
    const ping = await h.duringPing('ses_a', () =>
      h.dispatch(makeRequest('not json'), { kind: 'generate' })
    );
    expect(await ping.request.text()).toBe('not json');
  });

  test('an unparseable ping request is still reported as a ping', async () => {
    const h = harness();
    await h.duringPing('ses_a', () => h.dispatch(makeRequest('not json'), { kind: 'generate' }));
    expect(h.sent).toEqual([
      { sessionID: 'ses_a', info: { requestedTtl: '5m', isPing: true, kind: 'generate' } },
    ]);
  });

  test('an unparseable primary request is not stored', async () => {
    const h = harness();
    await h.dispatch(makeRequest('not json'));
    expect(h.primaryMessages.has('ses_a')).toBe(false);
    expect(h.sent).toHaveLength(1);
  });
});

describe('createRequestHook on openai-chat', () => {
  const CHAT_URL = 'https://omni.example/v1/chat/completions';
  const chatBody = (model: string, extra: Record<string, unknown> = {}) => ({
    model,
    tools: [{ type: 'function', function: { name: 'tool_a' } }],
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'again' },
    ],
    ...extra,
  });
  const chatRequest = (value: Record<string, unknown>, headers: Record<string, string> = {}) =>
    new Request(CHAT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(value),
    });
  const claude = { providerID: 'omniroute', modelID: 'auto/claude-opus-5-5' };
  const deepseek = { providerID: 'omniroute', modelID: 'deepseek/deepseek-v4.1-flash' };

  test('a Claude model without breakpoints is injected, with 1h on the tools in hybrid', async () => {
    const h = harness();
    await h.store.setSession('ses_a', { mode: 'hybrid' });
    const evt = await h.dispatch(chatRequest(chatBody('claude-opus-5-5')), claude);
    const out = (await parsedBodyOf(evt.request)) as { tools: any[] };
    const controls = collectCacheControls(out);
    expect(controls).toHaveLength(3);
    expect(out.tools[0].cache_control.ttl).toBe('1h');
    expect(evt.request.headers.get('anthropic-beta')).toBe(EXTENDED_CACHE_BETA);
    expect(h.sent).toEqual([
      { sessionID: 'ses_a', info: { requestedTtl: '5m', isPing: false, kind: 'primary' } },
    ]);
  });

  test('the kind of each request is reported to the engine', async () => {
    const h = harness();
    await h.dispatch(chatRequest(chatBody('deepseek/deepseek-v4.1-flash')), deepseek);
    await h.dispatch(chatRequest(chatBody('claude-opus-5-5')), { ...claude, kind: 'title' });
    expect(h.sent.map((s) => s.info.kind)).toEqual(['primary', 'title']);
  });

  test('a non-Claude model keeps its body byte for byte and reports a null TTL', async () => {
    const h = harness();
    await h.store.setSession('ses_a', { mode: '1h' });
    const raw = JSON.stringify(chatBody('deepseek/deepseek-v4.1-flash'));
    const request = new Request(CHAT_URL, { method: 'POST', body: raw });
    const evt = await h.dispatch(request, deepseek);
    expect(evt.request).toBe(request);
    expect(await evt.request.text()).toBe(raw);
    expect(h.sent).toEqual([
      { sessionID: 'ses_a', info: { requestedTtl: null, isPing: false, kind: 'primary' } },
    ]);
    expect(h.primaryMessages.size).toBe(0);
  });

  test('an implicit request carrying the sentinel is stripped but not injected', async () => {
    const h = harness();
    const evt = await h.dispatch(
      chatRequest(chatBody('deepseek/v4'), { [SENTINEL_HEADER]: '1h' }),
      deepseek
    );
    expect(evt.request.headers.has(SENTINEL_HEADER)).toBe(false);
    expect(collectCacheControls(await parsedBodyOf(evt.request))).toHaveLength(0);
    expect(h.sent[0]?.info.requestedTtl).toBeNull();
  });

  test('the built-in check also reads body.model for an alias', async () => {
    const h = harness();
    const evt = await h.dispatch(chatRequest(chatBody('anthropic/claude-opus-5')), {
      providerID: 'omniroute',
      modelID: 'auto/opus-5',
    });
    expect(collectCacheControls(await parsedBodyOf(evt.request)).length).toBeGreaterThan(0);
  });

  test('a learned profile makes an alias explicit, and a user pattern can force it back', async () => {
    const alias = { providerID: 'omniroute', modelID: 'auto/opus-5' };
    const learned = new Map<string, CacheProfileId>([['omniroute/auto/opus-5', 'anthropic']]);

    const h = harness({ profiles: learned });
    const evt = await h.dispatch(chatRequest(chatBody('auto/opus-5')), alias);
    expect(collectCacheControls(await parsedBodyOf(evt.request)).length).toBeGreaterThan(0);

    const forced = harness({
      profiles: learned,
      options: { cacheProfiles: parseCacheProfiles({ opus: 'implicit' }) },
    });
    const untouched = await forced.dispatch(chatRequest(chatBody('auto/opus-5')), alias);
    expect(collectCacheControls(await parsedBodyOf(untouched.request))).toHaveLength(0);
  });

  test('a user pattern makes an unknown model explicit', async () => {
    const h = harness({
      options: { cacheProfiles: parseCacheProfiles({ 'omniroute/mystery': 'anthropic' }) },
    });
    const evt = await h.dispatch(chatRequest(chatBody('mystery-1')), {
      providerID: 'omniroute',
      modelID: 'mystery-1',
    });
    expect(collectCacheControls(await parsedBodyOf(evt.request)).length).toBeGreaterThan(0);
  });

  test('a ping is aligned with the primary request and gets no injected tail', async () => {
    const h = harness();
    const primary = await h.dispatch(chatRequest(chatBody('claude-opus-5-5')), claude);
    const primaryMessages = ((await parsedBodyOf(primary.request)) as any).messages as any[];
    expect(h.primaryMessages.get('ses_a')).toEqual(primaryMessages);

    const ping = chatRequest({
      ...chatBody('claude-opus-5-5'),
      messages: [
        ...chatBody('claude-opus-5-5').messages.slice(0, 3),
        { role: 'user', content: PING_PROMPT },
      ],
    });
    const evt = await h.duringPing('ses_a', () =>
      h.dispatch(ping, { ...claude, kind: 'generate' })
    );
    const messages = ((await parsedBodyOf(evt.request)) as any).messages as any[];
    expect(messages.slice(0, 3)).toEqual(primaryMessages.slice(0, 3));
    expect(messages[3]).toEqual({ role: 'user', content: PING_PROMPT });
    expect(h.sent.at(-1)?.info.isPing).toBe(true);
  });

  test('one-off title and generate requests are not injected', async () => {
    const h = harness();
    for (const kind of ['title', 'generate'] as const) {
      const evt = await h.dispatch(chatRequest(chatBody('claude-opus-5-5')), { ...claude, kind });
      expect(collectCacheControls(await parsedBodyOf(evt.request))).toHaveLength(0);
    }
  });

  test('a compaction request is injected', async () => {
    const h = harness();
    const evt = await h.dispatch(chatRequest(chatBody('claude-opus-5-5')), {
      ...claude,
      kind: 'compaction',
    });
    expect(collectCacheControls(await parsedBodyOf(evt.request)).length).toBeGreaterThan(0);
  });

  test('a Claude /responses request is observed only: no rewrite, no TTL, no ping alignment', async () => {
    const h = harness();
    await h.store.setSession('ses_a', { mode: '1h' });
    const body = JSON.stringify({
      model: 'claude-opus-5-5',
      instructions: 'You are helpful.',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    });
    const request = new Request('https://omni.example/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    const evt = await h.dispatch(request, claude);
    expect(await evt.request.text()).toBe(body);
    expect(evt.request.headers.has('anthropic-beta')).toBe(false);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.info.requestedTtl).toBeNull();
    expect(h.primaryMessages.has('ses_a')).toBe(false);
  });

  test('with the option off the body is never parsed for classification', async () => {
    const h = harness({ options: { openaiCompatible: false } });
    const request = chatRequest(chatBody('anthropic/claude-opus-5'));
    const spy = spyOn(request, 'clone');
    await h.dispatch(request, { providerID: 'omniroute', modelID: 'auto/opus-5' });
    expect(spy).not.toHaveBeenCalled();
  });

  test('with the option off the request is skipped, or only sentinel-stripped', async () => {
    const h = harness({ options: { openaiCompatible: false } });
    const request = chatRequest(chatBody('claude-opus-5-5'));
    const evt = await h.dispatch(request, claude);
    expect(evt.request).toBe(request);
    expect(h.sent).toHaveLength(0);

    const sentinel = await h.dispatch(
      chatRequest(chatBody('claude-opus-5-5'), { [SENTINEL_HEADER]: '1h' }),
      claude
    );
    expect(sentinel.request.headers.has(SENTINEL_HEADER)).toBe(false);
    expect(collectCacheControls(await parsedBodyOf(sentinel.request))).toHaveLength(0);
    expect(h.sent).toHaveLength(0);
  });
});

describe('createRequestHook on the Messages wire by model', () => {
  const MESSAGES_URL = 'https://omni.example/v1/messages';
  const messages = (model: string, headers: Record<string, string> = {}) =>
    new Request(MESSAGES_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ ...sampleBody(), model }),
    });
  const deepseek = { providerID: 'some-proxy', modelID: 'deepseek/deepseek-v4.1-flash' };

  test('a non-Claude model under another provider is observed only, at any mode', async () => {
    const results: Record<string, unknown> = {};
    for (const mode of ['5m', '1h', 'hybrid'] as const) {
      const h = harness();
      await h.store.setSession('ses_a', { mode });
      const request = messages(deepseek.modelID);
      const evt = await h.dispatch(request, deepseek);
      results[mode] = {
        passedThrough: evt.request === request,
        sent: h.sent,
        primaryMessages: h.primaryMessages.size,
      };
    }
    const unmanaged = {
      passedThrough: true,
      sent: [{ sessionID: 'ses_a', info: { requestedTtl: null, isPing: false, kind: 'primary' } }],
      primaryMessages: 0,
    };
    expect(results).toEqual({ '5m': unmanaged, '1h': unmanaged, 'hybrid': unmanaged });
  });

  test('a non-Claude ping candidate is never aligned with the last primary request', async () => {
    const h = harness();
    await h.store.setSession('ses_a', { mode: '1h' });
    await h.dispatch(messages(deepseek.modelID), deepseek);
    const ping = messages(deepseek.modelID);
    const evt = await h.duringPing('ses_a', () =>
      h.dispatch(ping, { ...deepseek, kind: 'generate' })
    );
    expect(evt.request).toBe(ping);
    expect(h.sent.map((s) => s.info.requestedTtl)).toEqual([null, null]);
    expect(h.primaryMessages.size).toBe(0);
  });

  test('a non-Claude model with the sentinel only loses the sentinel', async () => {
    const h = harness();
    const evt = await h.dispatch(messages(deepseek.modelID, { [SENTINEL_HEADER]: '1h' }), deepseek);
    expect(evt.request.headers.has(SENTINEL_HEADER)).toBe(false);
    expect(evt.request.headers.get('anthropic-beta') ?? '').not.toContain(EXTENDED_CACHE_BETA);
    expect(await parsedBodyOf(evt.request)).toEqual({ ...sampleBody(), model: deepseek.modelID });
    expect(h.sent[0]?.info.requestedTtl).toBeNull();
  });

  test("Claude under another provider gets the session's TTL and the beta header, with the option on or off", async () => {
    const results: Record<string, unknown> = {};
    for (const openaiCompatible of [false, true]) {
      const h = harness({ options: { openaiCompatible } });
      await h.store.setSession('ses_a', { mode: '1h' });
      const evt = await h.dispatch(messages('claude-haiku-5-5'), {
        providerID: 'some-proxy',
        modelID: 'claude-haiku-5-5',
      });
      const controls = collectCacheControls(await parsedBodyOf(evt.request));
      results[`openaiCompatible=${openaiCompatible}`] = {
        hasControls: controls.length > 0,
        ttls: [...new Set(controls.map((cc) => cc.ttl))],
        beta: evt.request.headers.get('anthropic-beta')?.includes(EXTENDED_CACHE_BETA),
        requestedTtl: h.sent[0]?.info.requestedTtl,
        primaryMessages: h.primaryMessages.size,
      };
    }
    const rewritten = {
      hasControls: true,
      ttls: ['1h'],
      beta: true,
      requestedTtl: '1h',
      primaryMessages: 1,
    };
    expect(results).toEqual({
      'openaiCompatible=false': rewritten,
      'openaiCompatible=true': rewritten,
    });
  });

  test('an alias is classified from body.model, a pattern, or a learned profile', async () => {
    const alias = { providerID: 'some-proxy', modelID: 'auto/fast' };
    const viaBody = harness({ options: { openaiCompatible: false } });
    await viaBody.store.setSession('ses_a', { mode: '1h' });
    await viaBody.dispatch(messages('anthropic/claude-x'), alias);
    const viaPattern = harness({
      options: { cacheProfiles: parseCacheProfiles({ 'auto/fast': 'anthropic' }) },
    });
    await viaPattern.store.setSession('ses_a', { mode: '1h' });
    await viaPattern.dispatch(messages('auto/fast'), alias);
    const learned = harness({
      profiles: new Map([['some-proxy/auto/fast', 'anthropic' as const]]),
    });
    await learned.store.setSession('ses_a', { mode: '1h' });
    await learned.dispatch(messages('auto/fast'), alias);
    const unknown = harness();
    await unknown.store.setSession('ses_a', { mode: '1h' });
    await unknown.dispatch(messages('auto/fast'), alias);
    expect(
      [viaBody, viaPattern, learned, unknown].map((h) => h.sent[0]?.info.requestedTtl)
    ).toEqual(['1h', '1h', '1h', null]);
  });

  test('a learned openai profile on the Messages wire is observed only', async () => {
    const gpt = { providerID: 'some-proxy', modelID: 'gpt-6-luna' };
    const h = harness({ profiles: new Map([['some-proxy/gpt-6-luna', 'openai' as const]]) });
    await h.store.setSession('ses_a', { mode: '1h' });
    const request = messages(gpt.modelID);
    const evt = await h.dispatch(request, gpt);
    expect(evt.request).toBe(request);
    expect(h.sent[0]?.info.requestedTtl).toBeNull();
  });

  test('the anthropic provider keeps its rewrite for any model name', async () => {
    const h = harness();
    await h.store.setSession('ses_a', { mode: '1h' });
    const evt = await h.dispatch(messages('m'), { providerID: 'anthropic', modelID: 'm' });
    const controls = collectCacheControls(await parsedBodyOf(evt.request));
    expect(controls.length).toBeGreaterThan(0);
    for (const cc of controls) expect(cc.ttl).toBe('1h');
    expect(evt.request.headers.get('anthropic-beta')).toContain(EXTENDED_CACHE_BETA);
    expect(h.sent[0]?.info.requestedTtl).toBe('1h');
    expect(h.primaryMessages.size).toBe(1);
  });
});

describe('createRequestHook with the real keepalive engine', () => {
  const url = 'https://omni.example/v1/chat/completions';
  const chat = (model: string) =>
    new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'hello' },
        ],
      }),
    });
  const usage: CacheUsage = {
    inputTokens: 100,
    cacheReadTokens: 70_000,
    cacheWriteTokens: 0,
    write5mTokens: undefined,
    write1hTokens: undefined,
  };

  function real() {
    const { kv } = memoryKv();
    const store = new SettingsStore(kv, {});
    const engine = new KeepaliveEngine({
      now: () => 0,
      setTimer: () => 0,
      clearTimer: () => {},
      ping: async () => {},
      settings: async () => ({ ...BUILTIN_DEFAULTS, keepalive: true }),
      isChild: async () => false,
      onChange: () => {},
    });
    const options: PluginOptions = { openaiCompatible: true, cacheProfiles: [] };
    const hook = createRequestHook({
      store,
      engine,
      pings: new PingTracker(),
      options,
      profiles: { get: () => undefined },
      primaryMessages: new Map(),
    });
    const send = (kind: HttpRequestEvent['kind'], id: string) =>
      hook({ sessionID: 'ses_a', kind, model: { providerID: 'omniroute', id }, request: chat(id) });
    const sendMessages = (providerID: string, id: string) =>
      hook({
        sessionID: 'ses_a',
        kind: 'primary',
        model: { providerID, id },
        request: new Request('https://omni.example/v1/messages', {
          method: 'POST',
          body: JSON.stringify({ ...sampleBody(), model: id }),
        }),
      });
    const respond = async () => {
      await engine.responseObserved('ses_a', { usage, ok: true, isPing: false, kind: 'primary' });
      await new Promise((resolve) => setTimeout(resolve, 0));
      return engine.snapshot('ses_a');
    };
    return { send, sendMessages, respond };
  }

  test('a non-Claude model on the Messages wire under another provider never schedules a ping', async () => {
    const h = real();
    await h.sendMessages('some-proxy', 'deepseek/deepseek-v4.1-flash');
    expect(await h.respond()).toMatchObject({ skipReason: 'implicit', nextPingAt: null });
  });

  test('Claude on the Messages wire under another provider schedules a ping', async () => {
    const h = real();
    await h.sendMessages('some-proxy', 'claude-haiku-5-5');
    const snapshot = await h.respond();
    expect(snapshot.skipReason).toBeNull();
    expect(snapshot.nextPingAt).not.toBeNull();
  });

  test('a Claude title request after a GPT primary request never schedules a ping', async () => {
    const h = real();
    await h.send('primary', 'openai/gpt-5.5');
    await h.send('title', 'anthropic/claude-haiku-5.5');
    expect(await h.respond()).toMatchObject({ skipReason: 'implicit', nextPingAt: null });
  });

  test('a GPT title request after a Claude primary request still schedules a ping', async () => {
    const h = real();
    await h.send('primary', 'anthropic/claude-sonnet-5.5');
    await h.send('title', 'openai/gpt-5-mini');
    const snapshot = await h.respond();
    expect(snapshot.skipReason).toBeNull();
    expect(snapshot.nextPingAt).not.toBeNull();
  });
});

describe('createRequestHook with the openai profile', () => {
  const CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
  const RESPONSES_URL = 'https://openrouter.ai/api/v1/responses';
  const LONG = { mode: 'explicit', ttl: '12h' };
  const gpt = { providerID: 'openrouter', modelID: 'openai/gpt-6-luna' };
  const chatMessages = () => [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
    { role: 'user', content: 'again' },
  ];
  const chatBody = () => ({ model: 'openai/gpt-6-luna', messages: chatMessages() });
  const post = (
    url: string,
    value: Record<string, unknown>,
    headers: Record<string, string> = {}
  ) =>
    new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(value),
    });
  const marked = (text: string) => [{ type: 'text', text, prompt_cache_breakpoint: LONG }];

  test('5m sends the body as is and keeps the automatic 30m warm', async () => {
    const h = harness();
    const request = post(CHAT_URL, chatBody());
    const evt = await h.dispatch(request, gpt);
    expect(evt.request).toBe(request);
    expect(h.sent).toEqual([
      { sessionID: 'ses_a', info: { requestedTtl: '30m', isPing: false, kind: 'primary' } },
    ]);
    expect(h.primaryMessages.get('ses_a')).toEqual(chatMessages());
  });

  test('1h puts a 12h breakpoint on the last user text and no cache options or beta header', async () => {
    const h = harness();
    await h.store.setSession('ses_a', { mode: '1h' });
    const evt = await h.dispatch(post(CHAT_URL, chatBody()), gpt);
    const messages = chatMessages();
    messages[3].content = marked('again') as never;
    expect(await parsedBodyOf(evt.request)).toEqual({ model: 'openai/gpt-6-luna', messages });
    expect(evt.request.headers.get('anthropic-beta')).toBeNull();
    expect(h.sent[0]?.info.requestedTtl).toBe('12h');
    expect(h.primaryMessages.get('ses_a')).toEqual(messages);
  });

  test('hybrid puts the 12h breakpoint on the system prefix', async () => {
    const h = harness();
    await h.store.setSession('ses_a', { mode: 'hybrid' });
    const evt = await h.dispatch(post(CHAT_URL, chatBody()), gpt);
    const messages = chatMessages();
    messages[0].content = marked('You are helpful.') as never;
    expect(await parsedBodyOf(evt.request)).toEqual({ model: 'openai/gpt-6-luna', messages });
    expect(evt.request.headers.get('anthropic-beta')).toBeNull();
    expect(h.sent[0]?.info.requestedTtl).toBe('30m');
  });

  test('a title request caches nothing: explicit mode, no breakpoint', async () => {
    const h = harness();
    await h.store.setSession('ses_a', { mode: '1h' });
    const evt = await h.dispatch(post(CHAT_URL, chatBody()), { ...gpt, kind: 'title' });
    expect(await parsedBodyOf(evt.request)).toEqual({
      ...chatBody(),
      prompt_cache_options: { mode: 'explicit' },
    });
  });

  test('a ping is aligned with the primary and otherwise untouched', async () => {
    const h = harness();
    await h.store.setSession('ses_a', { mode: '1h' });
    const primary = await h.dispatch(post(CHAT_URL, chatBody()), gpt);
    const stored = ((await parsedBodyOf(primary.request)) as { messages: unknown[] }).messages;

    const pingMessages = [
      ...chatMessages(),
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: PING_PROMPT },
    ];
    const ping = await h.duringPing('ses_a', () =>
      h.dispatch(post(CHAT_URL, { model: 'openai/gpt-6-luna', messages: pingMessages }), {
        ...gpt,
        kind: 'generate',
      })
    );
    expect(await parsedBodyOf(ping.request)).toEqual({
      model: 'openai/gpt-6-luna',
      messages: [...stored, pingMessages[4], pingMessages[5]],
    });
    expect(h.sent[1]?.info).toEqual({ requestedTtl: '12h', isPing: true, kind: 'generate' });
  });

  test('on the Responses wire 1h marks the last input_text', async () => {
    const h = harness();
    await h.store.setSession('ses_a', { mode: '1h' });
    const input = () => [
      { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'again' }] },
    ];
    const evt = await h.dispatch(
      post(RESPONSES_URL, {
        model: 'openai/gpt-6-luna',
        instructions: 'Be brief.',
        input: input(),
      }),
      gpt
    );
    const expected = input();
    expected[2].content = [
      { type: 'input_text', text: 'again', prompt_cache_breakpoint: LONG },
    ] as never;
    expect(await parsedBodyOf(evt.request)).toEqual({
      model: 'openai/gpt-6-luna',
      instructions: 'Be brief.',
      input: expected,
    });
    expect(h.sent[0]?.info.requestedTtl).toBe('12h');
    expect(h.primaryMessages.get('ses_a')).toEqual(expected);
  });

  test("a -1h variant's sentinel gives the 12h breakpoint and is stripped", async () => {
    const h = harness();
    const evt = await h.dispatch(post(CHAT_URL, chatBody(), { [SENTINEL_HEADER]: '1h' }), gpt);
    expect(evt.request.headers.has(SENTINEL_HEADER)).toBe(false);
    const messages = chatMessages();
    messages[3].content = marked('again') as never;
    expect(await parsedBodyOf(evt.request)).toEqual({ model: 'openai/gpt-6-luna', messages });
    expect(h.sent[0]?.info.requestedTtl).toBe('12h');
  });

  test('with the option off a GPT request is left alone', async () => {
    const h = harness({ options: { openaiCompatible: false } });
    await h.store.setSession('ses_a', { mode: '1h' });
    const request = post(CHAT_URL, chatBody());
    const evt = await h.dispatch(request, gpt);
    expect(evt.request).toBe(request);
    expect(h.sent).toEqual([]);
  });

  test('with the option off a sentinel GPT request is stripped and never gets OpenAI cache fields', async () => {
    const h = harness({ options: { openaiCompatible: false } });
    const evt = await h.dispatch(post(CHAT_URL, chatBody(), { [SENTINEL_HEADER]: '1h' }), gpt);
    expect(evt.request.headers.has(SENTINEL_HEADER)).toBe(false);
    expect(await parsedBodyOf(evt.request)).toEqual(chatBody());
  });
});

describe('createRequestHook rewrite failures', () => {
  test('a throwing profile rewrite sends the request unchanged', async () => {
    const spy = spyOn(openaiProfile, 'rewrite').mockImplementation(() => {
      throw new Error('boom');
    });
    try {
      const h = harness();
      await h.store.setSession('ses_a', { mode: '1h' });
      const request = new Request('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          model: 'openai/gpt-6-luna',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      const evt = await h.dispatch(request, {
        providerID: 'openrouter',
        modelID: 'openai/gpt-6-luna',
      });
      expect(evt.request).toBe(request);
      expect(h.sent[0]?.info.requestedTtl).toBe('12h');
    } finally {
      spy.mockRestore();
    }
  });
});
