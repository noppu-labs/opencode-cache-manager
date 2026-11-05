import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  configureDebugLog,
  dbg,
  dbgEnabled,
  dbgError,
  dbgExcerpt,
  dbgLabel,
  dbgUrl,
} from '../../src/utils/debug-log.ts';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cache-manager-debug-'));
  path = join(dir, 'trace.jsonl');
});

afterEach(() => {
  configureDebugLog(undefined);
  rmSync(dir, { force: true, recursive: true });
});

function lines(): Record<string, unknown>[] {
  return readFileSync(path, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('dbg', () => {
  test('off writes nothing and creates no file', () => {
    configureDebugLog(undefined);
    dbg('x', { a: 1 });
    expect(existsSync(path)).toBe(false);
  });

  test('on writes one parseable line per event', () => {
    configureDebugLog({ bodies: false, path });
    dbg('first', { a: 1 });
    dbg('second');

    const [first, second] = lines();
    expect(lines()).toHaveLength(2);
    expect(first).toMatchObject({ a: 1, ev: 'first', pid: process.pid });
    expect(typeof first?.t).toBe('string');
    expect(second).toMatchObject({ ev: 'second', pid: process.pid });
    expect(typeof second?.t).toBe('string');
  });

  test('a line starts with ev, pid and t, then the fields', () => {
    configureDebugLog({ bodies: false, path });
    dbg('x', { a: 1 });
    expect(Object.keys(lines()[0] ?? {})).toEqual(['ev', 'pid', 't', 'a']);
  });

  test('a field cannot overwrite ev, pid or t, and they stay first', () => {
    configureDebugLog({ bodies: false, path });
    dbg('x', { a: 1, ev: 'forged', pid: -1, t: 'forged' });

    const line = lines()[0] ?? {};
    expect(line).toMatchObject({ a: 1, ev: 'x', pid: process.pid });
    expect(line.t).not.toBe('forged');
    expect(Object.keys(line)).toEqual(['ev', 'pid', 't', 'a']);
  });

  test('the file is created with mode 0600', () => {
    configureDebugLog({ bodies: false, path });
    dbg('x');
    expect(statSync(path).mode.toString(8).slice(-3)).toBe('600');
  });

  test('a failed write does not throw', () => {
    const unwritable = join(dir, 'missing', 'trace.jsonl');
    configureDebugLog({ bodies: false, path: unwritable });
    expect(() => {
      dbg('x');
    }).not.toThrow();
    expect(existsSync(unwritable)).toBe(false);
  });

  test('fields that cannot be serialised do not throw', () => {
    configureDebugLog({ bodies: false, path });
    expect(() => {
      dbg('x', { big: 1n });
    }).not.toThrow();
  });
});

describe('dbgEnabled', () => {
  test('dbgEnabled follows the configuration', () => {
    expect(dbgEnabled()).toBe(false);
    configureDebugLog({ bodies: false, path });
    expect(dbgEnabled()).toBe(true);
    configureDebugLog(undefined);
    expect(dbgEnabled()).toBe(false);
  });
});

describe('dbgExcerpt', () => {
  test('dbgExcerpt is undefined unless bodies is on', () => {
    configureDebugLog({ bodies: false, path });
    expect(dbgExcerpt('text', 'head')).toBeUndefined();
    expect(dbgExcerpt('text', 'tail')).toBeUndefined();
  });

  test('dbgExcerpt caps each end at 600 characters', () => {
    configureDebugLog({ bodies: true, path });
    const text = 'a'.repeat(700) + 'b'.repeat(700);
    expect(dbgExcerpt(text, 'head')).toBe('a'.repeat(600));
    expect(dbgExcerpt(text, 'tail')).toBe('b'.repeat(600));
  });
});

describe('dbgError', () => {
  test('dbgError gives only the name unless bodies is on', () => {
    configureDebugLog({ bodies: false, path });
    expect(dbgError(new SyntaxError('secret'))).toBe('SyntaxError');
    expect(dbgError('secret')).toBe('unknown');

    configureDebugLog({ bodies: true, path });
    expect(dbgError(new SyntaxError('secret'))).toContain('secret');
  });

  test('dbgError caps the message at 600 characters', () => {
    configureDebugLog({ bodies: true, path });
    expect(dbgError(new Error('x'.repeat(700)))).toHaveLength(600);
  });

  test('a value with no string form does not throw', () => {
    configureDebugLog({ bodies: true, path });
    expect(dbgError(Object.create(null))).toBe('unknown');
  });

  test('dbgError caps the name at 128 characters with bodies off', () => {
    configureDebugLog({ bodies: false, path });
    const error = new Error('secret');
    error.name = `CANARY${'x'.repeat(700)}`;
    expect(dbgError(error)).toBe(error.name.slice(0, 128));
  });

  test('an error whose name is not a string does not throw', () => {
    configureDebugLog({ bodies: false, path });
    const error = new Error('secret');
    Object.assign(error, { name: 5 });
    expect(dbgError(error)).toBe('unknown');
  });
});

describe('dbgLabel', () => {
  test('dbgLabel caps a long string at 128 characters', () => {
    expect(dbgLabel('x'.repeat(700))).toBe('x'.repeat(128));
  });

  test('dbgLabel leaves a short string alone', () => {
    expect(dbgLabel('end_turn')).toBe('end_turn');
  });

  test('a value that is not a string at runtime does not throw', () => {
    expect(dbgLabel(Object as unknown as string)).toBe('unknown');
  });
});

describe('dbgUrl', () => {
  test('dbgUrl drops the query, fragment and credentials', () => {
    expect(dbgUrl('https://u:KEY@host.test/v1/messages?key=SECRET#f')).toBe(
      'https://host.test/v1/messages'
    );
  });

  test('an unparseable URL does not throw', () => {
    expect(dbgUrl('not a url?key=SECRET')).toBe('<invalid url>');
  });
});
