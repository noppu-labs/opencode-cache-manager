import { describe, expect, test } from 'bun:test';

import { OPENAI_TTL_FOR_MODE } from '../../../src/constants/openai.ts';
import type { CacheTtlMode } from '../../../src/models/cache.ts';
import type { RequestKind } from '../../../src/models/keepalive.ts';
import type { RewriteContext } from '../../../src/models/profile.ts';
import { openaiProfile } from '../../../src/services/profiles/openai.ts';

type Rec = Record<string, unknown>;
type OpenAiWire = 'openai-chat' | 'openai-responses';

const BP = { mode: 'explicit', ttl: '12h' };
const MODES: CacheTtlMode[] = ['5m', '1h', 'hybrid'];
const WIRES: OpenAiWire[] = ['openai-chat', 'openai-responses'];
const KINDS: RequestKind[] = ['primary', 'compaction', 'title', 'generate'];

const ctx = (
  wire: OpenAiWire,
  mode: CacheTtlMode,
  kind: RequestKind = 'primary',
  isPing = false
): RewriteContext => ({
  wire,
  mode,
  kind,
  isPing,
  inject: false,
});

const text = (t: string, extra: Rec = {}): Rec => ({ type: 'text', text: t, ...extra });
const inputText = (t: string, extra: Rec = {}): Rec => ({ type: 'input_text', text: t, ...extra });

function chatBody(): Rec {
  return {
    model: 'openai/gpt-6-luna',
    prompt_cache_key: 'ses_1',
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'developer', content: [text('dev one'), text('dev two')] },
      { role: 'user', content: [text('hello')] },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'question' },
    ],
  };
}

function responsesBody(): Rec {
  return {
    model: 'openai/gpt-6-luna',
    instructions: 'You are helpful.',
    prompt_cache_key: 'ses_1',
    input: [
      { type: 'message', role: 'user', content: [inputText('first'), inputText('second')] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] },
      { type: 'message', role: 'user', content: [inputText('question')] },
      { type: 'function_call_output', call_id: 'c1', output: 'result' },
    ],
  };
}

const bodyFor = (wire: OpenAiWire): Rec => (wire === 'openai-chat' ? chatBody() : responsesBody());

/** The expected body: the base body with the 12h breakpoint on one spot. */
function expectedWithBreakpoint(wire: OpenAiWire, mode: '1h' | 'hybrid'): Rec {
  const body = bodyFor(wire);
  if (wire === 'openai-chat') {
    const messages = body.messages as Rec[];
    if (mode === 'hybrid') {
      (messages[1].content as Rec[])[1].prompt_cache_breakpoint = BP;
    } else {
      messages[4].content = [text('question', { prompt_cache_breakpoint: BP })];
    }
  } else {
    const input = body.input as Rec[];
    if (mode === 'hybrid') {
      (input[0].content as Rec[]).at(-1)!.prompt_cache_breakpoint = BP;
    } else {
      input[3].output = [inputText('result', { prompt_cache_breakpoint: BP })];
    }
  }
  return body;
}

const withoutBreakpoints = (body: Rec): Rec =>
  JSON.parse(
    JSON.stringify(body, (key, value: unknown) =>
      key === 'prompt_cache_breakpoint' ? undefined : value
    )
  );

describe('openai profile', () => {
  test('describes the OpenAI wires with pings and the 30m / 12h TTLs', () => {
    expect(openaiProfile.id).toBe('openai');
    expect(openaiProfile.pings).toBe(true);
    expect(openaiProfile.wires).toEqual(['openai-chat', 'openai-responses']);
    expect('headers' in openaiProfile).toBe(false);
    for (const mode of MODES)
      expect(openaiProfile.ttlForMode(mode)).toBe(OPENAI_TTL_FOR_MODE[mode]);
    expect(openaiProfile.ttlForMode('5m')).toBe('30m');
    expect(openaiProfile.ttlForMode('hybrid')).toBe('30m');
  });

  for (const wire of WIRES) {
    describe(wire, () => {
      for (const kind of ['primary', 'compaction'] as const) {
        test(`${kind} 5m leaves the body untouched`, () => {
          const body = bodyFor(wire);
          expect(openaiProfile.rewrite(body, ctx(wire, '5m', kind))).toBe(false);
          expect(body).toEqual(bodyFor(wire));
        });

        test(`${kind} 5m strips breakpoints from a previous send`, () => {
          const body = expectedWithBreakpoint(wire, '1h');
          expect(openaiProfile.rewrite(body, ctx(wire, '5m', kind))).toBe(true);
          expect(JSON.stringify(body)).not.toContain('prompt_cache_breakpoint');
          expect(openaiProfile.rewrite(body, ctx(wire, '5m', kind))).toBe(false);
        });

        for (const mode of ['1h', 'hybrid'] as const) {
          test(`${kind} ${mode} puts the 12h breakpoint on one part and no prompt_cache_options`, () => {
            const body = bodyFor(wire);
            expect(openaiProfile.rewrite(body, ctx(wire, mode, kind))).toBe(true);
            expect(body).toEqual(expectedWithBreakpoint(wire, mode));
            expect(body).not.toHaveProperty('prompt_cache_options');
            expect(JSON.stringify(body).match(/prompt_cache_breakpoint/g)).toHaveLength(1);
          });

          test(`${kind} ${mode} is idempotent`, () => {
            const body = bodyFor(wire);
            openaiProfile.rewrite(body, ctx(wire, mode, kind));
            const once = structuredClone(body);
            expect(openaiProfile.rewrite(body, ctx(wire, mode, kind))).toBe(false);
            expect(body).toEqual(once);
          });
        }

        test(`${kind} moves the breakpoint when the mode changes between sends`, () => {
          const body = bodyFor(wire);
          openaiProfile.rewrite(body, ctx(wire, '1h', kind));
          expect(openaiProfile.rewrite(body, ctx(wire, 'hybrid', kind))).toBe(true);
          const expected = expectedWithBreakpoint(wire, 'hybrid');
          // The earlier 1h send already turned the final string message or tool output into parts.
          if (wire === 'openai-chat') (expected.messages as Rec[])[4].content = [text('question')];
          else (expected.input as Rec[])[3].output = [inputText('result')];
          expect(body).toEqual(expected);
        });

        test(`${kind} leaves an existing prompt_cache_options alone`, () => {
          for (const mode of MODES) {
            const body = { ...bodyFor(wire), prompt_cache_options: { mode: 'explicit' } };
            openaiProfile.rewrite(body, ctx(wire, mode, kind));
            expect(body.prompt_cache_options).toEqual({ mode: 'explicit' });
          }
        });
      }

      for (const kind of ['title', 'generate'] as const) {
        for (const mode of MODES) {
          test(`${kind} ${mode} sets explicit mode and strips breakpoints`, () => {
            const body = expectedWithBreakpoint(wire, '1h');
            expect(openaiProfile.rewrite(body, ctx(wire, mode, kind))).toBe(true);
            expect(body).toEqual({
              ...withoutBreakpoints(expectedWithBreakpoint(wire, '1h')),
              prompt_cache_options: { mode: 'explicit' },
            });
          });

          test(`${kind} ${mode} is idempotent and adds nothing to a bare body`, () => {
            const body = bodyFor(wire);
            expect(openaiProfile.rewrite(body, ctx(wire, mode, kind))).toBe(true);
            expect(body).toEqual({ ...bodyFor(wire), prompt_cache_options: { mode: 'explicit' } });
            expect(openaiProfile.rewrite(body, ctx(wire, mode, kind))).toBe(false);
          });
        }
      }

      test('pings are never changed', () => {
        for (const kind of KINDS) {
          for (const mode of MODES) {
            const body = expectedWithBreakpoint(wire, '1h');
            const before = structuredClone(body);
            expect(openaiProfile.rewrite(body, ctx(wire, mode, kind, true))).toBe(false);
            expect(body).toEqual(before);
          }
        }
      });
    });
  }

  test('anthropic-messages bodies are not touched', () => {
    const body: Rec = {
      system: [{ type: 'text', text: 's' }],
      messages: [{ role: 'user', content: 'x' }],
    };
    const before = structuredClone(body);
    expect(
      openaiProfile.rewrite(body, {
        wire: 'anthropic-messages',
        mode: '1h',
        kind: 'title',
        isPing: false,
        inject: false,
      })
    ).toBe(false);
    expect(body).toEqual(before);
  });

  describe('chat edge cases', () => {
    test('1h walks back past a final message without text', () => {
      const body: Rec = {
        messages: [
          { role: 'user', content: 'ask' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: '{}' } }],
          },
          { role: 'tool', tool_call_id: 'c', content: '' },
        ],
      };
      expect(openaiProfile.rewrite(body, ctx('openai-chat', '1h'))).toBe(true);
      expect((body.messages as Rec[])[0].content).toEqual([
        text('ask', { prompt_cache_breakpoint: BP }),
      ]);
      expect((body.messages as Rec[])[2].content).toBe('');
    });

    const assistant = (content: unknown): Rec => ({ role: 'assistant', content });
    const toolCalls = [{ id: 'c', type: 'function', function: { name: 'f', arguments: '{}' } }];

    test('1h lands on a non-empty final tool message', () => {
      const body: Rec = {
        messages: [
          { role: 'user', content: 'ask' },
          { ...assistant(null), tool_calls: toolCalls },
          { role: 'tool', tool_call_id: 'c', content: 'result' },
        ],
      };
      expect(openaiProfile.rewrite(body, ctx('openai-chat', '1h'))).toBe(true);
      expect((body.messages as Rec[])[2].content).toEqual([
        text('result', { prompt_cache_breakpoint: BP }),
      ]);
      expect((body.messages as Rec[])[0].content).toBe('ask');
    });

    test('1h skips a final assistant message with text and lands on the previous user message', () => {
      const body: Rec = {
        messages: [{ role: 'user', content: 'ask' }, assistant('answer')],
      };
      expect(openaiProfile.rewrite(body, ctx('openai-chat', '1h'))).toBe(true);
      expect(body.messages).toEqual([
        { role: 'user', content: [text('ask', { prompt_cache_breakpoint: BP })] },
        assistant('answer'),
      ]);
    });

    test('1h skips assistant parts given as an array', () => {
      const body: Rec = {
        messages: [{ role: 'user', content: [text('ask')] }, assistant([text('answer')])],
      };
      openaiProfile.rewrite(body, ctx('openai-chat', '1h'));
      expect(body.messages).toEqual([
        { role: 'user', content: [text('ask', { prompt_cache_breakpoint: BP })] },
        assistant([text('answer')]),
      ]);
    });

    test('1h on assistant -> tool -> assistant lands on the tool message', () => {
      const body: Rec = {
        messages: [
          { role: 'user', content: 'ask' },
          { ...assistant('calling'), tool_calls: toolCalls },
          { role: 'tool', tool_call_id: 'c', content: 'result' },
          assistant('done'),
        ],
      };
      expect(openaiProfile.rewrite(body, ctx('openai-chat', '1h'))).toBe(true);
      expect(body.messages).toEqual([
        { role: 'user', content: 'ask' },
        { ...assistant('calling'), tool_calls: toolCalls },
        {
          role: 'tool',
          tool_call_id: 'c',
          content: [text('result', { prompt_cache_breakpoint: BP })],
        },
        assistant('done'),
      ]);
    });

    test('1h with only assistant text adds no breakpoint', () => {
      const body: Rec = { messages: [assistant('alone')] };
      expect(openaiProfile.rewrite(body, ctx('openai-chat', '1h'))).toBe(false);
      expect(body).toEqual({ messages: [assistant('alone')] });
    });

    test('hybrid turns string system content into a text part', () => {
      const body: Rec = {
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'hi' },
        ],
      };
      openaiProfile.rewrite(body, ctx('openai-chat', 'hybrid'));
      expect(body.messages).toEqual([
        { role: 'system', content: [text('sys', { prompt_cache_breakpoint: BP })] },
        { role: 'user', content: 'hi' },
      ]);
    });

    test('hybrid without a system prefix adds no breakpoint', () => {
      const body: Rec = { messages: [{ role: 'user', content: 'hi' }] };
      expect(openaiProfile.rewrite(body, ctx('openai-chat', 'hybrid'))).toBe(false);
      expect(body).toEqual({ messages: [{ role: 'user', content: 'hi' }] });
    });

    test('bodies without messages are left alone', () => {
      for (const mode of MODES) {
        const body: Rec = { model: 'x' };
        expect(openaiProfile.rewrite(body, ctx('openai-chat', mode))).toBe(false);
        expect(body).toEqual({ model: 'x' });
      }
    });
  });

  describe('existing explicit prompt_cache_options', () => {
    for (const wire of WIRES) {
      for (const kind of ['primary', 'compaction'] as const) {
        test(`${wire} ${kind} 5m keeps the breakpoints the user's explicit mode relies on`, () => {
          const body = {
            ...expectedWithBreakpoint(wire, '1h'),
            prompt_cache_options: { mode: 'explicit' },
          };
          const before = structuredClone(body);
          expect(openaiProfile.rewrite(body, ctx(wire, '5m', kind))).toBe(false);
          expect(body).toEqual(before);
        });

        test(`${wire} ${kind} 5m still strips when the options are not explicit`, () => {
          const body = {
            ...expectedWithBreakpoint(wire, '1h'),
            prompt_cache_options: { ttl: '12h' },
          };
          expect(openaiProfile.rewrite(body, ctx(wire, '5m', kind))).toBe(true);
          expect(JSON.stringify(body)).not.toContain('prompt_cache_breakpoint');
          expect(body.prompt_cache_options).toEqual({ ttl: '12h' });
        });
      }
    }
  });

  describe('responses edge cases', () => {
    test('string user content becomes an input_text part', () => {
      const body: Rec = { input: [{ type: 'message', role: 'user', content: 'hello' }] };
      openaiProfile.rewrite(body, ctx('openai-responses', '1h'));
      expect(body.input).toEqual([
        {
          type: 'message',
          role: 'user',
          content: [inputText('hello', { prompt_cache_breakpoint: BP })],
        },
      ]);
    });

    test('1h lands on a trailing tool output past assistant items', () => {
      const body: Rec = {
        input: [
          { type: 'message', role: 'user', content: [inputText('ask')] },
          { type: 'function_call', call_id: 'c', name: 'f', arguments: '{}' },
          { type: 'function_call_output', call_id: 'c', output: 'r' },
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
        ],
      };
      expect(openaiProfile.rewrite(body, ctx('openai-responses', '1h'))).toBe(true);
      expect(body).toEqual({
        input: [
          { type: 'message', role: 'user', content: [inputText('ask')] },
          { type: 'function_call', call_id: 'c', name: 'f', arguments: '{}' },
          {
            type: 'function_call_output',
            call_id: 'c',
            output: [inputText('r', { prompt_cache_breakpoint: BP })],
          },
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
        ],
      });
    });

    test('1h on a tool output moves an earlier breakpoint off the user message', () => {
      const body: Rec = {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [inputText('ask', { prompt_cache_breakpoint: BP })],
          },
          { type: 'function_call', call_id: 'c', name: 'f', arguments: '{}' },
          { type: 'function_call_output', call_id: 'c', output: [inputText('r')] },
        ],
      };
      expect(openaiProfile.rewrite(body, ctx('openai-responses', '1h'))).toBe(true);
      expect(body).toEqual({
        input: [
          { type: 'message', role: 'user', content: [inputText('ask')] },
          { type: 'function_call', call_id: 'c', name: 'f', arguments: '{}' },
          {
            type: 'function_call_output',
            call_id: 'c',
            output: [inputText('r', { prompt_cache_breakpoint: BP })],
          },
        ],
      });
    });

    test('1h walks back to the user message when the tool output has no text', () => {
      const body: Rec = {
        input: [
          { type: 'message', role: 'user', content: [inputText('ask')] },
          { type: 'function_call', call_id: 'c', name: 'f', arguments: '{}' },
          { type: 'function_call_output', call_id: 'c', output: '' },
        ],
      };
      expect(openaiProfile.rewrite(body, ctx('openai-responses', '1h'))).toBe(true);
      expect(body).toEqual({
        input: [
          {
            type: 'message',
            role: 'user',
            content: [inputText('ask', { prompt_cache_breakpoint: BP })],
          },
          { type: 'function_call', call_id: 'c', name: 'f', arguments: '{}' },
          { type: 'function_call_output', call_id: 'c', output: '' },
        ],
      });
    });

    test('hybrid uses the first input item only', () => {
      const body = responsesBody();
      (body.input as Rec[])[0] = {
        type: 'function_call',
        call_id: 'c',
        name: 'f',
        arguments: '{}',
      };
      expect(openaiProfile.rewrite(body, ctx('openai-responses', 'hybrid'))).toBe(false);
      expect(JSON.stringify(body)).not.toContain('prompt_cache_breakpoint');
    });

    test('bodies without input are left alone', () => {
      for (const mode of MODES) {
        const body: Rec = { instructions: 'x' };
        expect(openaiProfile.rewrite(body, ctx('openai-responses', mode))).toBe(false);
        expect(body).toEqual({ instructions: 'x' });
      }
    });
  });
});
