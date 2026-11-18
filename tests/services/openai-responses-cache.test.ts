import { describe, expect, test } from 'bun:test';

import {
  lastInputText,
  lastInputTextPart,
  responsesPrefixText,
  toolOutputTextPart,
} from '../../src/services/openai-responses-cache.ts';

type Rec = Record<string, unknown>;

const message = (role: string, content: unknown): Rec => ({ type: 'message', role, content });
const inputText = (text: string, extra: Rec = {}): Rec => ({ type: 'input_text', text, ...extra });

describe('lastInputTextPart', () => {
  test('returns the last input_text part of an array', () => {
    const first = inputText('a');
    const last = inputText('b');
    const item = message('user', [first, { type: 'input_image', image_url: 'x' }, last]);
    expect(lastInputTextPart(item)).toBe(last);
  });

  test('turns string content into an input_text part', () => {
    const item = message('user', 'hello');
    const part = lastInputTextPart(item);
    expect(part).toEqual({ type: 'input_text', text: 'hello' });
    expect(item.content).toEqual([{ type: 'input_text', text: 'hello' }]);
    expect(item.content).toEqual([part]);
  });

  test('leaves empty string content alone', () => {
    const item = message('user', '');
    expect(lastInputTextPart(item)).toBeUndefined();
    expect(item.content).toBe('');
  });

  test('ignores output_text and empty input_text parts', () => {
    expect(
      lastInputTextPart(message('assistant', [{ type: 'output_text', text: 'x' }]))
    ).toBeUndefined();
    expect(lastInputTextPart(message('user', [inputText('')]))).toBeUndefined();
  });

  test('does not turn assistant string content into input_text', () => {
    const item = message('assistant', 'hi');
    expect(lastInputTextPart(item)).toBeUndefined();
    expect(item.content).toBe('hi');
  });

  test('skips items that are not messages', () => {
    expect(
      lastInputTextPart({ type: 'function_call_output', call_id: 'c', output: 'x' })
    ).toBeUndefined();
    expect(lastInputTextPart({ type: 'reasoning', content: [inputText('x')] })).toBeUndefined();
  });

  test('accepts a role-only item without a type', () => {
    expect(lastInputTextPart({ role: 'user', content: 'hi' })).toEqual({
      type: 'input_text',
      text: 'hi',
    });
  });
});

describe('lastInputText', () => {
  test('walks back past items without input text', () => {
    const target = inputText('question');
    const body: Rec = {
      input: [
        message('user', [target]),
        message('assistant', [{ type: 'output_text', text: 'a' }]),
        { type: 'function_call', call_id: 'c', name: 'read', arguments: '{}' },
        { type: 'function_call_output', call_id: 'c', output: '' },
      ],
    };
    expect(lastInputText(body)).toBe(target);
  });

  test('lands on a trailing tool output, turning string output into an input_text part', () => {
    const body: Rec = {
      input: [
        message('user', [inputText('question')]),
        { type: 'function_call', call_id: 'c', name: 'read', arguments: '{}' },
        { type: 'function_call_output', call_id: 'c', output: 'file contents' },
        message('assistant', [{ type: 'output_text', text: 'a' }]),
      ],
    };
    const part = lastInputText(body);
    expect(part).toEqual({ type: 'input_text', text: 'file contents' });
    expect(body.input).toEqual([
      message('user', [inputText('question')]),
      { type: 'function_call', call_id: 'c', name: 'read', arguments: '{}' },
      {
        type: 'function_call_output',
        call_id: 'c',
        output: [{ type: 'input_text', text: 'file contents' }],
      },
      message('assistant', [{ type: 'output_text', text: 'a' }]),
    ]);
  });

  test('is undefined without an input array or usable items', () => {
    expect(lastInputText({})).toBeUndefined();
    expect(lastInputText({ input: 'plain' })).toBeUndefined();
    expect(lastInputText({ input: [] })).toBeUndefined();
  });
});

describe('toolOutputTextPart', () => {
  test('returns the last input_text part of an output array', () => {
    const last = inputText('b');
    const item: Rec = {
      type: 'function_call_output',
      call_id: 'c',
      output: [inputText('a'), { type: 'input_image', image_url: 'x' }, last],
    };
    expect(toolOutputTextPart(item)).toBe(last);
  });

  test('turns string output into an input_text part', () => {
    const item: Rec = { type: 'function_call_output', call_id: 'c', output: 'done' };
    const part = toolOutputTextPart(item);
    expect(item).toEqual({
      type: 'function_call_output',
      call_id: 'c',
      output: [{ type: 'input_text', text: 'done' }],
    });
    expect(item.output).toEqual([part]);
  });

  test('ignores other items, empty output and arrays without input text', () => {
    expect(toolOutputTextPart(message('user', 'hi'))).toBeUndefined();
    const empty: Rec = { type: 'function_call_output', call_id: 'c', output: '' };
    expect(toolOutputTextPart(empty)).toBeUndefined();
    expect(empty.output).toBe('');
    expect(
      toolOutputTextPart({ type: 'function_call_output', output: [inputText('')] })
    ).toBeUndefined();
  });
});

describe('responsesPrefixText', () => {
  const tools = {
    type: 'additional_tools',
    role: 'developer',
    tools: [{ type: 'function', name: 'f' }],
  };

  test('marks the leading developer message', () => {
    const input = [message('developer', 'sys'), message('user', 'hi')];
    const result = responsesPrefixText({ input });
    expect(result).toEqual({ type: 'input_text', text: 'sys' });
    const [developer] = input;
    expect(developer?.content).toEqual([result]);
    expect(Array.isArray(developer?.content) && developer.content[0]).toBe(result);
    expect(input[1]).toEqual(message('user', 'hi'));
  });

  test('skips leading additional_tools items', () => {
    expect(
      responsesPrefixText({ input: [tools, message('developer', 'sys'), message('user', 'hi')] })
    ).toEqual(inputText('sys'));
    expect(responsesPrefixText({ input: [tools, message('user', 'hi')] })).toEqual(inputText('hi'));
  });

  test('walks back within the leading developer/system run', () => {
    const a = inputText('a');
    const input = [message('system', [a]), message('developer', ''), message('user', 'u')];
    expect(responsesPrefixText({ input })).toBe(a);
    expect(input[1]?.content).toBe('');
  });

  test('uses the last part of the last prefix message', () => {
    const input = [
      message('developer', [inputText('d1'), inputText('d2')]),
      message('system', 's'),
      message('user', 'u'),
    ];
    expect(responsesPrefixText({ input })).toEqual(inputText('s'));
  });

  test('returns undefined when the leading run has no text', () => {
    const input = [message('developer', ''), message('user', 'u')];
    expect(responsesPrefixText({ input })).toBeUndefined();
    expect(input[1]?.content).toBe('u');
  });

  test('ignores developer messages after the first non-prefix item', () => {
    expect(
      responsesPrefixText({ input: [message('user', 'u'), message('developer', 'later')] })
    ).toEqual(inputText('u'));
  });

  test('keeps the first item when input does not lead with developer/system messages', () => {
    const b = inputText('b');
    expect(
      responsesPrefixText({
        instructions: 'x',
        input: [message('user', [inputText('a'), b]), message('user', 'c')],
      })
    ).toBe(b);
    expect(
      responsesPrefixText({ input: [{ type: 'function_call', call_id: 'c', name: 'f' }] })
    ).toBeUndefined();
  });

  test('is undefined without an input array, when empty, only additional_tools, or a non-record first entry', () => {
    expect(responsesPrefixText({})).toBeUndefined();
    expect(responsesPrefixText({ input: 'plain' })).toBeUndefined();
    expect(responsesPrefixText({ input: [] })).toBeUndefined();
    expect(
      responsesPrefixText({ input: [{ type: 'additional_tools', tools: [] }] })
    ).toBeUndefined();
    expect(responsesPrefixText({ input: ['x'] })).toBeUndefined();
  });
});
