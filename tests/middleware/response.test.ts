import { describe, expect, test } from 'bun:test';

import type { PluginOptions } from '../../src/config/settings.ts';
import { createResponseHook, type HttpResponseEvent } from '../../src/middleware/response.ts';
import type { ModelRef, ResponseIdentity } from '../../src/models/cache.ts';
import type { KeepaliveEngine } from '../../src/services/keepalive-engine.ts';
import { PingTracker } from '../../src/services/ping-tracker.ts';
import { ProfileStore } from '../../src/services/profile-store.ts';
import {
  makeRequest,
  openaiSse,
  openaiUsage,
  responsesSse,
  responsesUsage,
} from '../helpers/fixtures.ts';
import { memoryKv } from '../helpers/memory-kv.ts';

const WRITE_1H = {
  input_tokens: 10,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 60_000,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 60_000 },
};

const WRITE_1H_PARSED = {
  inputTokens: 10,
  cacheReadTokens: 0,
  cacheWriteTokens: 60_000,
  write5mTokens: 0,
  write1hTokens: 60_000,
};

async function flush() {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

function harness(config: { options?: Partial<PluginOptions> } = {}) {
  const options: PluginOptions = { openaiCompatible: true, cacheProfiles: [], ...config.options };
  const learnCalls: Array<{ ref: ModelRef; identity: unknown }> = [];
  const forgetCalls: ModelRef[] = [];
  const store = new ProfileStore(memoryKv().kv);
  const profiles = {
    learnFromResponse: async (ref: ModelRef, identity: ResponseIdentity | undefined) => {
      learnCalls.push({ ref, identity });
      await store.learnFromResponse(ref, identity);
    },
    forget: async (ref: ModelRef) => {
      forgetCalls.push(ref);
      await store.forget(ref);
    },
    get: (ref: ModelRef) => store.get(ref),
  };
  const observed: Array<{ sessionID: string; info: Record<string, unknown> }> = [];
  const fake = {
    pending: undefined as Promise<void> | undefined,
    fail: false,
  };
  const engine = {
    responseObserved: (sessionID: string, info: Record<string, unknown>) => {
      observed.push({ sessionID, info });
      if (fake.fail) throw new Error('engine down');
      return fake.pending ?? Promise.resolve();
    },
  } as unknown as KeepaliveEngine;
  const pings = new PingTracker();
  const hook = createResponseHook({ engine, pings, options, profiles });
  return { hook, pings, observed, fake, learnCalls, forgetCalls, store };
}

function jsonResponse(body: unknown = { usage: WRITE_1H }, status = 200) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function event(overrides: Partial<HttpResponseEvent> = {}): HttpResponseEvent {
  return {
    sessionID: 'ses_a',
    kind: 'primary',
    model: { providerID: 'anthropic', id: 'claude-sonnet-5-5' },
    request: makeRequest('{}'),
    response: jsonResponse(),
    ...overrides,
  };
}

describe('createResponseHook', () => {
  test('reports usage, status and kind for an Anthropic provider', async () => {
    const { hook, observed } = harness();
    await hook(event());
    await flush();

    expect(observed).toEqual([
      {
        sessionID: 'ses_a',
        info: {
          usage: WRITE_1H_PARSED,
          ok: true,
          isPing: false,
          kind: 'primary',
          stopReason: undefined,
          unmanaged: false,
        },
      },
    ]);
  });

  test('reports the stop reason of a JSON response', async () => {
    const { hook, observed } = harness();
    await hook(event({ response: jsonResponse({ stop_reason: 'tool_use', usage: WRITE_1H }) }));
    await flush();

    expect(observed[0].info).toMatchObject({ stopReason: 'tool_use', usage: WRITE_1H_PARSED });
  });

  test('reports usage and the stop reason of a streamed response', async () => {
    const { hook, observed } = harness();
    const text = [
      `data: ${JSON.stringify({ type: 'message_start', message: { usage: WRITE_1H } })}`,
      `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } })}`,
      '',
    ].join('\n');
    await hook(
      event({ response: new Response(text, { headers: { 'content-type': 'text/event-stream' } }) })
    );
    await flush();

    expect(observed[0].info).toMatchObject({ stopReason: 'end_turn', usage: WRITE_1H_PARSED });
  });

  test('passes the session and kind through', async () => {
    const { hook, observed } = harness();
    await hook(event({ sessionID: 'ses_b', kind: 'title' }));
    await flush();

    expect(observed[0].sessionID).toBe('ses_b');
    expect(observed[0].info.kind).toBe('title');
  });

  test('reports a failed response as not ok, without usage', async () => {
    const { hook, observed } = harness();
    await hook(event({ response: jsonResponse({}, 529) }));
    await flush();

    expect(observed[0].info).toMatchObject({ ok: false, usage: undefined });
  });

  test('reports no usage for a response without a usage block', async () => {
    const { hook, observed } = harness();
    await hook(event({ response: jsonResponse({}) }));
    await flush();

    expect(observed[0].info).toMatchObject({ ok: true, usage: undefined });
  });

  test('the response left on the event still has the original body and status', async () => {
    const { hook } = harness();
    const original = JSON.stringify({ usage: WRITE_1H });
    const evt = event({ response: jsonResponse(original) });
    await hook(evt);

    expect(evt.response.status).toBe(200);
    expect(await evt.response.text()).toBe(original);
  });

  test('a non-Anthropic provider and URL are not observed', async () => {
    const { hook, observed } = harness();
    const response = jsonResponse();
    const evt = event({
      model: { providerID: 'openai', id: 'gpt-6' },
      request: new Request('https://api.openai.com/v1/embeddings', { method: 'POST', body: '{}' }),
      response,
    });
    await hook(evt);
    await flush();

    expect(observed).toHaveLength(0);
    expect(evt.response).toBe(response);
  });

  test('an Anthropic-shaped URL on an unknown provider is observed', async () => {
    const { hook, observed } = harness();
    await hook(
      event({
        model: { providerID: 'some-proxy', id: 'm' },
        request: new Request('https://proxy.example/anthropic/v1/messages', {
          method: 'POST',
          body: '{}',
        }),
      })
    );
    await flush();

    expect(observed).toHaveLength(1);
    expect(observed[0].info.usage).toEqual(WRITE_1H_PARSED);
  });

  test('a non-POST request to a messages path on an unknown provider is not observed', async () => {
    const { hook, observed } = harness();
    await hook(
      event({
        model: { providerID: 'some-proxy', id: 'm' },
        request: new Request('https://proxy.example/v1/messages', { method: 'GET' }),
      })
    );
    await flush();

    expect(observed).toHaveLength(0);
  });

  test('a response whose body is already locked passes through unchanged', async () => {
    const { hook, observed } = harness();
    const response = jsonResponse();
    response.body!.getReader();
    const evt = event({ response });
    await hook(evt);
    await flush();

    expect(evt.response).toBe(response);
    expect(observed).toHaveLength(0);
  });

  test('a response without a body is still reported', async () => {
    const { hook, observed } = harness();
    await hook(event({ response: new Response(null, { status: 204 }) }));
    await flush();

    expect(observed[0].info).toMatchObject({ ok: true, usage: undefined, stopReason: undefined });
  });
});

describe('createResponseHook ping handling', () => {
  test('a generate response during a pending ping is reported as a ping', async () => {
    const { hook, pings, observed } = harness();
    await pings.send('ses_a', () => hook(event({ kind: 'generate' })));

    expect(observed).toHaveLength(1);
    expect(observed[0].info).toMatchObject({ isPing: true, kind: 'generate' });
  });

  test('a generate response without a pending ping is not a ping', async () => {
    const { hook, observed } = harness();
    await hook(event({ kind: 'generate' }));
    await flush();

    expect(observed[0].info.isPing).toBe(false);
  });

  test('a primary response during a pending ping is not a ping', async () => {
    const { hook, pings, observed } = harness();
    const g = gate();
    const sending = pings.send('ses_a', () => g.promise);

    await hook(event({ kind: 'primary' }));
    await flush();
    expect(observed[0].info.isPing).toBe(false);

    g.open();
    await sending;
  });

  test('the ping flag is per session', async () => {
    const { hook, pings, observed } = harness();
    const g = gate();
    const sending = pings.send('ses_a', () => g.promise);

    await hook(event({ sessionID: 'ses_b', kind: 'generate' }));
    await flush();
    expect(observed[0]).toMatchObject({ sessionID: 'ses_b', info: { isPing: false } });

    g.open();
    await sending;
  });

  test('send settles only after the engine has been told about the ping response', async () => {
    const { hook, pings, observed, fake } = harness();
    const engineDone = gate();
    fake.pending = engineDone.promise;
    let settled = false;

    const sending = pings
      .send('ses_a', () => hook(event({ kind: 'generate' })))
      .then(() => {
        settled = true;
      });
    await flush();

    expect(observed).toHaveLength(1);
    expect(settled).toBe(false);

    engineDone.open();
    await sending;
    expect(settled).toBe(true);
  });

  test('an engine failure does not leave a ping hanging', async () => {
    const { hook, pings, fake } = harness();
    fake.fail = true;

    await pings.send('ses_a', () => hook(event({ kind: 'generate' })));

    expect(pings.isPing('generate', 'ses_a')).toBe(false);
  });

  test('an engine failure does not fail the hook', async () => {
    const { hook, observed, fake } = harness();
    fake.fail = true;

    await expect(hook(event())).resolves.toBeUndefined();
    await flush();
    expect(observed).toHaveLength(1);
  });

  test('an ignored response during a ping does not make send wait', async () => {
    const { hook, pings, observed } = harness();
    await pings.send('ses_a', () =>
      hook(
        event({
          kind: 'generate',
          model: { providerID: 'openai', id: 'gpt-6' },
          request: new Request('https://api.openai.com/v1/embeddings', {
            method: 'POST',
            body: '{}',
          }),
        })
      )
    );

    expect(observed).toHaveLength(0);
  });
});

describe('createResponseHook on openai-chat', () => {
  const CHAT = () =>
    new Request('https://omni.example/v1/chat/completions', { method: 'POST', body: '{}' });
  const sse = (text: string) =>
    new Response(text, { headers: { 'content-type': 'text/event-stream' } });
  const chatEvent = (overrides: Partial<HttpResponseEvent> = {}) =>
    event({
      model: { providerID: 'omniroute', id: 'auto/opus-5' },
      request: CHAT(),
      response: sse(
        openaiSse(openaiUsage.lunaRead, { model: 'claude-opus-5-5', provider: 'Anthropic' })
      ),
      ...overrides,
    });

  test('reports usage and the finish reason, and learns the identity', async () => {
    const { hook, observed, learnCalls } = harness();
    const evt = chatEvent();
    await hook(evt);
    await flush();

    expect(observed[0]?.info).toMatchObject({
      ok: true,
      stopReason: 'stop',
      usage: { inputTokens: 3, cacheReadTokens: 8884 },
    });
    expect(learnCalls).toEqual([
      {
        ref: { providerID: 'omniroute', id: 'auto/opus-5' },
        identity: { model: 'claude-opus-5-5', provider: 'Anthropic' },
      },
    ]);
  });

  test('the caller still receives the untouched stream', async () => {
    const { hook } = harness();
    const original = openaiSse(openaiUsage.lunaRead);
    const evt = chatEvent({ response: sse(original) });
    await hook(evt);
    expect(await evt.response.text()).toBe(original);
  });

  test('a learning failure never reaches the host', async () => {
    const { hook, observed } = harness();
    const reported: unknown[] = [];
    const throwing = createResponseHook({
      engine: {
        responseObserved: async (_: string, info: unknown) => void reported.push(info),
      } as unknown as KeepaliveEngine,
      pings: new PingTracker(),
      options: { openaiCompatible: true, cacheProfiles: [] },
      profiles: {
        learnFromResponse: async () => {
          throw new Error('storage down');
        },
        forget: async () => {
          throw new Error('storage down');
        },
        get: () => {
          throw new Error('storage down');
        },
      },
    });
    await throwing(chatEvent());
    await flush();
    expect(reported).toHaveLength(1);
    await hook(chatEvent());
    await flush();
    expect(observed).toHaveLength(1);
  });

  test('a ping response is tracked as on the Anthropic wire', async () => {
    const { hook, pings, observed } = harness();
    let release!: () => void;
    const sending = pings.send('ses_a', () => new Promise<void>((resolve) => (release = resolve)));
    await hook(chatEvent({ kind: 'generate' }));
    release();
    await sending;
    expect(observed[0]?.info).toMatchObject({ isPing: true, kind: 'generate' });
  });

  test('with the option off the response is left alone and nothing is learned', async () => {
    const { hook, observed, learnCalls } = harness({ options: { openaiCompatible: false } });
    const evt = chatEvent();
    const original = evt.response;
    await hook(evt);
    await flush();
    expect(evt.response).toBe(original);
    expect(observed).toHaveLength(0);
    expect(learnCalls).toHaveLength(0);
  });

  test("an Anthropic provider's Messages responses never trigger learning", async () => {
    const { hook, learnCalls } = harness();
    await hook(event({ response: jsonResponse({ model: 'claude-sonnet-5-5', usage: WRITE_1H }) }));
    await flush();
    expect(learnCalls).toHaveLength(0);
  });

  describe('on a Messages-wire proxy', () => {
    const proxyEvent = (response: Response) =>
      event({
        model: { providerID: 'some-proxy', id: 'auto/claude-haiku-5-5' },
        request: new Request('https://proxy.example/v1/messages', { method: 'POST', body: '{}' }),
        response,
      });

    test('learns the model a JSON response reports', async () => {
      const { hook, learnCalls } = harness();
      await hook(proxyEvent(jsonResponse({ model: 'claude-haiku-5-5', usage: WRITE_1H })));
      await flush();
      expect(learnCalls).toEqual([
        {
          ref: { providerID: 'some-proxy', id: 'auto/claude-haiku-5-5' },
          identity: { model: 'claude-haiku-5-5' },
        },
      ]);
    });

    test('learns the model a streamed response reports', async () => {
      const { hook, learnCalls } = harness();
      const text = `data: ${JSON.stringify({ type: 'message_start', message: { model: 'deepseek/deepseek-v4.1-flash', usage: WRITE_1H } })}\n\n`;
      await hook(
        proxyEvent(new Response(text, { headers: { 'content-type': 'text/event-stream' } }))
      );
      await flush();
      expect(learnCalls.map((call) => call.identity)).toEqual([
        { model: 'deepseek/deepseek-v4.1-flash' },
      ]);
    });
  });
});

describe('createResponseHook on openai-responses', () => {
  const RESPONSES = () =>
    new Request('https://omni.example/v1/responses', { method: 'POST', body: '{}' });
  const sse = (text: string) =>
    new Response(text, { headers: { 'content-type': 'text/event-stream' } });
  const responsesEvent = (overrides: Partial<HttpResponseEvent> = {}) =>
    event({
      model: { providerID: 'omniroute', id: 'auto/fast' },
      request: RESPONSES(),
      response: sse(responsesSse(responsesUsage.read)),
      ...overrides,
    });

  test('reports usage and the status, and learns the model', async () => {
    const { hook, observed, learnCalls } = harness();
    await hook(responsesEvent());
    await flush();

    expect(observed[0]?.info).toMatchObject({
      ok: true,
      stopReason: 'stop',
      usage: { inputTokens: 3, cacheReadTokens: 8885, cacheWriteTokens: 19 },
    });
    expect(learnCalls).toEqual([
      {
        ref: { providerID: 'omniroute', id: 'auto/fast' },
        identity: { model: 'openai/gpt-6-luna' },
      },
    ]);
  });

  test('a tool call ends as tool_use, and the caller still receives the untouched stream', async () => {
    const { hook, observed } = harness();
    const original = responsesSse(responsesUsage.write, { toolCall: true });
    const evt = responsesEvent({ response: sse(original) });
    await hook(evt);
    await flush();
    expect(observed[0]?.info).toMatchObject({ stopReason: 'tool_use' });
    expect(await evt.response.text()).toBe(original);
  });

  test('a non-streaming JSON body is parsed too', async () => {
    const { hook, observed } = harness();
    const body = {
      model: 'openai/gpt-6-luna',
      status: 'completed',
      output: [],
      usage: responsesUsage.write,
    };
    await hook(responsesEvent({ response: jsonResponse(body) }));
    await flush();
    expect(observed[0]?.info).toMatchObject({
      stopReason: 'stop',
      usage: { cacheWriteTokens: 8885 },
    });
  });

  test('with the option off the response is left alone', async () => {
    const { hook, observed, learnCalls } = harness({ options: { openaiCompatible: false } });
    const evt = responsesEvent();
    const original = evt.response;
    await hook(evt);
    await flush();
    expect(evt.response).toBe(original);
    expect(observed).toHaveLength(0);
    expect(learnCalls).toHaveLength(0);
  });
});

describe('createResponseHook on the Messages wire for a non-Anthropic provider', () => {
  const alias = { providerID: 'omniroute', id: 'auto/best' };
  const messagesEvent = (overrides: Partial<HttpResponseEvent> = {}) =>
    event({
      model: alias,
      request: new Request('https://omni.example/v1/messages', { method: 'POST', body: '{}' }),
      ...overrides,
    });
  const withModel = (model: string) => jsonResponse({ model, usage: WRITE_1H });
  const errorResponse = () =>
    jsonResponse({ type: 'error', error: { type: 'invalid_request_error' } }, 400);

  test('an error response forgets the learned entry', async () => {
    const { hook, forgetCalls, store } = harness();
    await store.learnFromResponse(alias, { model: 'claude-opus-5-5' });
    await hook(messagesEvent({ response: errorResponse() }));
    await flush();
    expect(forgetCalls).toEqual([alias]);
    expect(store.get(alias)).toBeUndefined();
  });

  test('a 422 response forgets the learned entry too', async () => {
    const { hook, forgetCalls } = harness();
    await hook(messagesEvent({ response: jsonResponse({ type: 'error' }, 422) }));
    await flush();
    expect(forgetCalls).toEqual([alias]);
  });

  test('rate-limit, overload and server errors keep the learned entry', async () => {
    const { hook, forgetCalls, store } = harness();
    await store.learnFromResponse(alias, { model: 'claude-opus-5-5' });
    for (const status of [401, 429, 500, 503, 529]) {
      await hook(messagesEvent({ response: jsonResponse({ type: 'error' }, status) }));
    }
    await flush();
    expect(forgetCalls).toEqual([]);
    expect(store.get(alias)).toBe('anthropic');
  });

  test('an ok response does not forget', async () => {
    const { hook, forgetCalls } = harness();
    await hook(messagesEvent({ response: withModel('claude-opus-5-5') }));
    await flush();
    expect(forgetCalls).toEqual([]);
  });

  test('an error response for an Anthropic provider or on an OpenAI wire does not forget', async () => {
    const { hook, forgetCalls } = harness();
    await hook(event({ response: errorResponse() }));
    const chat = new Request('https://omni.example/v1/chat/completions', {
      method: 'POST',
      body: '{}',
    });
    await hook(
      event({
        model: alias,
        request: chat,
        response: jsonResponse({ error: { message: 'bad' } }, 400),
      })
    );
    await flush();
    expect(forgetCalls).toEqual([]);
  });

  test('a primary response naming a non-Claude model marks the session unmanaged', async () => {
    const { hook, observed, store } = harness();
    await store.learnFromResponse(alias, { model: 'claude-opus-5-5' });
    await hook(messagesEvent({ response: withModel('deepseek/deepseek-v4.1-flash') }));
    await flush();
    expect(store.get(alias)).toBe('implicit');
    expect(observed[0]?.info).toMatchObject({ ok: true, kind: 'primary', unmanaged: true });
  });

  test('a Claude model, a title response, or a response without a model leaves the session managed', async () => {
    const { hook, observed } = harness();
    await hook(messagesEvent({ response: withModel('claude-opus-5-5') }));
    await flush();
    await hook(
      messagesEvent({ kind: 'title', response: withModel('deepseek/deepseek-v4.1-flash') })
    );
    await flush();
    await hook(messagesEvent({ response: jsonResponse({ usage: WRITE_1H }) }));
    await flush();
    expect(observed).toHaveLength(3);
    for (const { info } of observed) expect(info.unmanaged).toBe(false);
  });

  test('an OpenAI-wire response never marks the session unmanaged', async () => {
    const { hook, observed } = harness();
    const chat = new Request('https://omni.example/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'openai/gpt-5.6' }),
    });
    await hook(
      event({
        model: { providerID: 'openrouter', id: 'fast' },
        request: chat,
        response: jsonResponse({ model: 'deepseek/deepseek-v4.1-flash', usage: {} }),
      })
    );
    await flush();
    expect(observed).toHaveLength(1);
    expect(observed[0]?.info.unmanaged).toBe(false);
  });

  test('a model whose name is Claude stays managed whatever the response names', async () => {
    const { hook, observed } = harness();
    await hook(
      messagesEvent({
        model: { providerID: 'omniroute', id: 'claude-opus-5-5' },
        response: withModel('deepseek/deepseek-v4.1-flash'),
      })
    );
    await flush();
    expect(observed[0]?.info.unmanaged).toBe(false);
  });

  test('a request whose body names a Claude model stays managed whatever the response names', async () => {
    const { hook, observed } = harness();
    const request = new Request('https://omni.example/v1/messages', {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-sonnet-5-5' }),
    });
    await hook(messagesEvent({ request, response: withModel('best-route') }));
    await flush();
    expect(observed[0]?.info.unmanaged).toBe(false);
  });
});
