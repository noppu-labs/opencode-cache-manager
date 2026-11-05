import { describe, expect, test } from 'bun:test';
import { dirname, join } from 'node:path';

import { observeResponseUsage } from '../../src/services/response-observer.ts';
import { OPENAI_PARSERS } from '../../src/services/usage-openai.ts';
import { ANTHROPIC_PARSERS } from '../../src/services/usage.ts';
import { configureDebugLog } from '../../src/utils/debug-log.ts';
import { useDebugTrace } from '../helpers/debug-log.ts';
import { fullParsed, fullUsage, openaiSse, openaiUsage, sse } from '../helpers/fixtures.ts';

describe('observeResponseUsage', () => {
  test('passes SSE through unchanged and resolves usage', async () => {
    const text = sse(fullUsage);
    const original = new Response(text, {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'text/event-stream', 'x-test': '1' },
    });
    const { response, usage } = observeResponseUsage(original, ANTHROPIC_PARSERS);
    expect(response.status).toBe(200);
    expect(response.statusText).toBe('OK');
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('x-test')).toBe('1');
    expect(await response.text()).toBe(text);
    expect((await usage)?.cacheReadTokens).toBe(61_000);
  });

  test('passes JSON through unchanged and resolves usage', async () => {
    const text = JSON.stringify({ usage: fullUsage });
    const { response, usage } = observeResponseUsage(
      new Response(text, { headers: { 'content-type': 'application/json' } }),
      ANTHROPIC_PARSERS
    );
    expect(await response.text()).toBe(text);
    expect(await usage).toEqual(fullParsed);
  });

  test('error responses pass through and resolve undefined', async () => {
    const text = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error' } });
    const { response, usage } = observeResponseUsage(
      new Response(text, { status: 400, headers: { 'content-type': 'application/json' } }),
      ANTHROPIC_PARSERS
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toBe(text);
    expect(await usage).toBeUndefined();
  });

  test('bodyless responses resolve undefined', async () => {
    const { response, usage } = observeResponseUsage(
      new Response(null, { status: 204 }),
      ANTHROPIC_PARSERS
    );
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
    expect(await usage).toBeUndefined();
  });

  test('unparseable JSON resolves undefined without rejecting', async () => {
    const { response, usage } = observeResponseUsage(
      new Response('not json', { headers: { 'content-type': 'application/json' } }),
      ANTHROPIC_PARSERS
    );
    expect(await response.text()).toBe('not json');
    expect(await usage).toBeUndefined();
  });

  test('resolves the stop reason of SSE and JSON responses', async () => {
    const streamed = `${sse(
      fullUsage
    )}data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{}}\n\n`;
    const fromSse = observeResponseUsage(
      new Response(streamed, { headers: { 'content-type': 'text/event-stream' } }),
      ANTHROPIC_PARSERS
    );
    await fromSse.response.text();
    expect(await fromSse.stopReason).toBe('tool_use');

    const fromJson = observeResponseUsage(
      Response.json(
        { stop_reason: 'end_turn', usage: fullUsage },
        {
          headers: { 'content-type': 'application/json' },
        }
      ),
      ANTHROPIC_PARSERS
    );
    await fromJson.response.text();
    expect(await fromJson.stopReason).toBe('end_turn');

    const failed = observeResponseUsage(
      new Response('not json', { headers: { 'content-type': 'application/json' } }),
      ANTHROPIC_PARSERS
    );
    await failed.response.text();
    expect(await failed.stopReason).toBeUndefined();
  });

  test('openai-chat wire resolves usage, finish reason and identity from SSE', async () => {
    const text = openaiSse(openaiUsage.lunaRead, { finishReason: 'tool_calls' });
    const observed = observeResponseUsage(
      new Response(text, { headers: { 'content-type': 'text/event-stream' } }),
      OPENAI_PARSERS
    );
    expect(await observed.response.text()).toBe(text);
    expect(await observed.usage).toMatchObject({
      inputTokens: 3,
      cacheReadTokens: 8884,
      cacheWriteTokens: 19,
    });
    expect(await observed.stopReason).toBe('tool_use');
    expect(await observed.identity).toEqual({ model: 'openai/gpt-6-luna', provider: 'OpenAI' });
  });

  test('openai-chat wire parses a JSON body', async () => {
    const observed = observeResponseUsage(
      Response.json(
        {
          model: 'claude-haiku-5-5',
          choices: [{ finish_reason: 'stop' }],
          usage: openaiUsage.deepseekRead,
        },
        { headers: { 'content-type': 'application/json' } }
      ),
      OPENAI_PARSERS
    );
    expect(await observed.usage).toMatchObject({ inputTokens: 83, cacheReadTokens: 10_112 });
    expect(await observed.stopReason).toBe('stop');
    expect(await observed.identity).toEqual({ model: 'claude-haiku-5-5' });
  });

  test('identity is undefined on the Anthropic wire', async () => {
    const observed = observeResponseUsage(
      new Response(sse(fullUsage), { headers: { 'content-type': 'text/event-stream' } }),
      ANTHROPIC_PARSERS
    );
    expect(await observed.identity).toBeUndefined();
    expect(await observed.usage).toMatchObject({ inputTokens: 10 });
  });

  test('a cancelled stream still reports the usage it already delivered', async () => {
    const encoder = new TextEncoder();
    let sent = 0;
    const source = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          /*
           * The usage arrives first, as it does when a provider finishes its
           * reply and the consumer stops reading before the stream closes.
           */
          if (sent === 0) {
            sent++;
            controller.enqueue(encoder.encode(sse(fullUsage)));
            return;
          }
          // The stream then stays open, waiting to be cancelled.
          await new Promise(() => {});
        },
      },
      { highWaterMark: 0 }
    );
    const { response, usage } = observeResponseUsage(
      new Response(source, { headers: { 'content-type': 'text/event-stream' } }),
      ANTHROPIC_PARSERS
    );
    const reader = response.body!.getReader();
    await reader.read();
    // Let the observer branch drain what the source already produced.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await reader.cancel('consumer done');

    expect((await usage)?.cacheReadTokens).toBe(61_000);
  });

  test('cancelling the returned body cancels the source stream', async () => {
    let pulled = 0;
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled++;
          if (pulled > 1000) controller.close();
          else controller.enqueue(new TextEncoder().encode('data: {}\n\n'));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 }
    );
    const { response, usage } = observeResponseUsage(
      new Response(source, { headers: { 'content-type': 'text/event-stream' } }),
      ANTHROPIC_PARSERS
    );
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel('user abort');
    expect(cancelled).toBe(true);
    expect(await usage).toBeUndefined();
    const pulledAfterCancel = pulled;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(pulled).toBe(pulledAfterCancel);
  });
});

describe('debug log', () => {
  const trace = useDebugTrace();
  const SSE_HEADERS = { 'content-type': 'text/event-stream' };
  const noUsageSse = 'data: {"type":"ping","note":"CANARY"}\n\n';

  /** Runs a response through the observer and waits for the observer's own log line. */
  async function observe(text: string, init: ResponseInit) {
    const observed = observeResponseUsage(new Response(text, init), ANTHROPIC_PARSERS);
    const delivered = await observed.response.text();
    await observed.usage;
    return delivered;
  }

  test('observer.parsed has no excerpt with bodies off', async () => {
    await observe(noUsageSse, { headers: SSE_HEADERS });

    const [event] = trace.events();
    expect(event).toMatchObject({
      chars: noUsageSse.length,
      cancelled: false,
      contentType: 'text/event-stream',
      ev: 'observer.parsed',
      hasUsage: false,
    });
    expect(event).not.toContainAnyKeys(['head', 'tail']);
    expect(trace.text()).not.toContain('CANARY');
  });

  test('observer.parsed has capped excerpts with bodies on', async () => {
    configureDebugLog({ bodies: true, path: trace.path });
    const body = `data: {"type":"ping","note":"${'CANARY '.repeat(300)}"}\n\n`;
    expect(body.length).toBeGreaterThan(1200);

    await observe(body, { headers: SSE_HEADERS });

    const [event] = trace.events();
    expect(event).toMatchObject({
      chars: body.length,
      ev: 'observer.parsed',
      hasUsage: false,
      head: body.slice(0, 600),
      tail: body.slice(-600),
    });
    expect(event?.head).toHaveLength(600);
    expect(event?.tail).toHaveLength(600);
  });

  test('observer.parsed has no excerpt when usage was read', async () => {
    configureDebugLog({ bodies: true, path: trace.path });

    await observe(`${sse(fullUsage)}${noUsageSse}`, { headers: SSE_HEADERS });

    const [event] = trace.events();
    expect(event).toMatchObject({ ev: 'observer.parsed', hasUsage: true });
    expect(event).not.toContainAnyKeys(['head', 'tail']);
    expect(trace.text()).not.toContain('CANARY');
  });

  test('observer.parsed says when the caller cancelled the stream', async () => {
    const observed = observeResponseUsage(
      new Response(noUsageSse, { headers: SSE_HEADERS }),
      ANTHROPIC_PARSERS
    );

    await observed.response.body?.cancel('consumer done');
    await observed.usage;

    expect(trace.events()[0]).toMatchObject({ cancelled: true, ev: 'observer.parsed' });
  });

  test('observer.discarded has no excerpt with bodies off', async () => {
    const body = 'CANARY upstream failure';

    await observe(body, { status: 500 });

    const [event] = trace.events();
    expect(event).toMatchObject({
      chars: body.length,
      cancelled: false,
      ev: 'observer.discarded',
      ok: false,
    });
    expect(event).not.toContainKey('head');
    expect(trace.text()).not.toContain('CANARY');
  });

  test('observer.discarded has an excerpt with bodies on', async () => {
    configureDebugLog({ bodies: true, path: trace.path });

    await observe('CANARY upstream failure', { status: 500 });

    const [event] = trace.events();
    expect(event).toMatchObject({ ev: 'observer.discarded', ok: false });
    expect(event?.head).toContain('CANARY');
  });

  test('observer.threw does not quote the body with bodies off', async () => {
    await observe('CANARY not json', { headers: { 'content-type': 'application/json' } });

    expect(trace.events()).toHaveLength(1);
    expect(trace.events()[0]).toMatchObject({ err: 'SyntaxError', ev: 'observer.threw' });
    expect(trace.text()).not.toContain('CANARY');
  });

  test('the caller gets the same bytes with logging on', async () => {
    const body = sse(fullUsage);
    const init = { headers: SSE_HEADERS };

    expect(await observe(body, init)).toBe(body);
    expect(trace.events()[0]?.ev).toBe('observer.parsed');

    configureDebugLog({ bodies: true, path: join(dirname(trace.path), 'missing', 'trace.jsonl') });
    const unwritable = observeResponseUsage(new Response(body, init), ANTHROPIC_PARSERS);
    expect(await unwritable.response.text()).toBe(body);
    expect((await unwritable.usage)?.cacheReadTokens).toBe(61_000);
  });
});
