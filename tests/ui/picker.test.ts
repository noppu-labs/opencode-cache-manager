import { describe, expect, test } from 'bun:test';

import type { Settings, SettingsPatch } from '../../src/config/settings.ts';
import type { CacheTtlRpcClient } from '../../src/rpc.ts';
import { createPicker, formatValue } from '../../src/ui/picker.ts';

type Toast = { message: string; variant: string };

type Options = {
  sessionID?: string | undefined;
  global?: Partial<Settings>;
  session?: SettingsPatch | null;
  selects?: unknown[];
  prompts?: unknown[];
  setSessionImpl?: (input: unknown) => Promise<unknown>;
};

function setup(options: Options = {}) {
  const toasts: Toast[] = [];
  const selectCalls: any[] = [];
  const promptCalls: any[] = [];
  const setSessionCalls: any[] = [];
  const setGlobalCalls: any[] = [];
  const resetCalls: any[] = [];
  const getSettingsCalls: any[] = [];
  const selects = [...(options.selects ?? [])];
  const prompts = [...(options.prompts ?? [])];
  const sessionID = 'sessionID' in options ? options.sessionID : 'ses_1';
  const global: Settings = {
    mode: '5m',
    keepalive: true,
    maxPings: 5,
    minContextTokens: 50_000,
    ...options.global,
  };

  const rpc = {
    getSettings: async (input: unknown) => {
      getSettingsCalls.push(input);
      return { global, session: options.session ?? null };
    },
    setSession: async (input: unknown) => {
      setSessionCalls.push(input);
      return options.setSessionImpl ? options.setSessionImpl(input) : {};
    },
    setGlobal: async (input: unknown) => {
      setGlobalCalls.push(input);
      return {};
    },
    resetSession: async (input: unknown) => {
      resetCalls.push(input);
      return {};
    },
  } as unknown as CacheTtlRpcClient;

  const dialog = {
    select: async (call: unknown) => {
      selectCalls.push(call);
      return selects.shift();
    },
    prompt: async (call: unknown) => {
      promptCalls.push(call);
      return prompts.shift();
    },
  };

  const picker = createPicker({
    dialog: dialog as any,
    rpc,
    toast: (message, variant) => {
      toasts.push({ message, variant });
    },
    currentSessionID: () => sessionID,
  });

  return {
    picker,
    toasts,
    selectCalls,
    promptCalls,
    setSessionCalls,
    setGlobalCalls,
    resetCalls,
    getSettingsCalls,
  };
}

describe('formatValue', () => {
  test('renders keepalive as on or off', () => {
    expect(formatValue('keepalive', true)).toBe('on');
    expect(formatValue('keepalive', false)).toBe('off');
  });

  test('renders min context in k tokens', () => {
    expect(formatValue('minContextTokens', 50_000)).toBe('50k');
    expect(formatValue('minContextTokens', 0)).toBe('0');
  });

  test('renders mode and pings as plain strings', () => {
    expect(formatValue('mode', 'hybrid')).toBe('hybrid');
    expect(formatValue('maxPings', 7)).toBe('7');
  });
});

describe('createPicker', () => {
  test('inside a session shows Session and Global with global markers', async () => {
    const t = setup({
      global: { mode: 'hybrid' },
      session: { mode: '1h', minContextTokens: 100_000 },
    });

    await t.picker();

    expect(t.getSettingsCalls).toEqual([{ sessionID: 'ses_1' }]);
    expect(t.selectCalls).toHaveLength(1);
    const call = t.selectCalls[0];
    expect(call.title).toBe('Cache Manager');
    const rows = call.options.map((o: any) => [o.category, o.value, o.title]);
    expect(rows).toEqual([
      ['Session', 'session:mode', 'TTL mode  1h'],
      ['Session', 'session:keepalive', 'Keepalive  on · global'],
      ['Session', 'session:maxPings', 'Pings per idle  5 · global'],
      ['Session', 'session:minContextTokens', 'Min context  100k'],
      ['Session', 'session:reset', 'Reset session to global'],
      ['Global', 'global:mode', 'TTL mode  hybrid'],
      ['Global', 'global:keepalive', 'Keepalive  on'],
      ['Global', 'global:maxPings', 'Pings per idle  5'],
      ['Global', 'global:minContextTokens', 'Min context  50k'],
    ]);
    expect(t.setSessionCalls).toHaveLength(0);
    expect(t.setGlobalCalls).toHaveLength(0);
    expect(t.toasts).toHaveLength(0);
  });

  test('without a session shows only Global', async () => {
    const t = setup({ sessionID: undefined });

    await t.picker();

    expect(t.getSettingsCalls).toEqual([{}]);
    const options = t.selectCalls[0].options;
    expect(options.map((o: any) => o.value)).toEqual([
      'global:mode',
      'global:keepalive',
      'global:maxPings',
      'global:minContextTokens',
    ]);
    expect(options.every((o: any) => o.category === 'Global')).toBe(true);
  });

  test('the mode sub-dialog offers the three modes with the effective one current', async () => {
    const t = setup({ session: { mode: 'hybrid' }, selects: ['session:mode'] });

    await t.picker();

    expect(t.selectCalls).toHaveLength(2);
    const sub = t.selectCalls[1];
    expect(sub.current).toBe('hybrid');
    expect(sub.options.map((o: any) => o.value)).toEqual(['5m', '1h', 'hybrid']);
    for (const option of sub.options) {
      expect(option.title.length).toBeGreaterThan(0);
      expect(option.description.length).toBeGreaterThan(0);
    }
  });

  test('selecting session:mode then 1h writes the session and toasts', async () => {
    const t = setup({ selects: ['session:mode', '1h'] });

    await t.picker();

    expect(t.setSessionCalls).toEqual([{ sessionID: 'ses_1', patch: { mode: '1h' } }]);
    expect(t.setGlobalCalls).toHaveLength(0);
    expect(t.toasts).toEqual([{ message: 'Session cache TTL set to 1h.', variant: 'success' }]);
  });

  test('selecting global:keepalive then off writes the global settings', async () => {
    const t = setup({ selects: ['global:keepalive', 'off'] });

    await t.picker();

    expect(t.selectCalls[1].current).toBe('on');
    expect(t.setGlobalCalls).toEqual([{ patch: { keepalive: false } }]);
    expect(t.setSessionCalls).toHaveLength(0);
    expect(t.toasts).toEqual([{ message: 'Global keepalive set to off.', variant: 'success' }]);
  });

  test('the pings and min context sub-dialogs list their presets', async () => {
    const pings = setup({ selects: ['global:maxPings'] });
    await pings.picker();
    expect(pings.selectCalls[1].options.map((o: any) => o.value)).toEqual([
      0,
      1,
      3,
      5,
      10,
      'custom',
    ]);
    expect(pings.selectCalls[1].options.at(-1).title).toBe('Custom…');

    const min = setup({ selects: ['global:minContextTokens'] });
    await min.picker();
    expect(min.selectCalls[1].options.map((o: any) => o.title)).toEqual([
      '0',
      '20k',
      '50k',
      '100k',
      'Custom…',
    ]);
  });

  test('a preset min context value is written in tokens and shown in k', async () => {
    const t = setup({ selects: ['session:minContextTokens', 100_000] });

    await t.picker();

    expect(t.setSessionCalls).toEqual([
      { sessionID: 'ses_1', patch: { minContextTokens: 100_000 } },
    ]);
    expect(t.toasts[0]!.message).toBe('Session min context set to 100k.');
  });

  test('global:maxPings then Custom with 7 writes the global setting', async () => {
    const t = setup({ selects: ['global:maxPings', 'custom'], prompts: ['7'] });

    await t.picker();

    expect(t.promptCalls).toHaveLength(1);
    expect(t.setGlobalCalls).toEqual([{ patch: { maxPings: 7 } }]);
    expect(t.toasts).toEqual([{ message: 'Global pings per idle set to 7.', variant: 'success' }]);
  });

  test('a Custom min context accepts the k suffix', async () => {
    const t = setup({ selects: ['global:minContextTokens', 'custom'], prompts: ['30k'] });

    await t.picker();

    expect(t.setGlobalCalls).toEqual([{ patch: { minContextTokens: 30_000 } }]);
  });

  test('an invalid Custom value warns and writes nothing', async () => {
    const t = setup({ selects: ['global:maxPings', 'custom'], prompts: ['abc'] });

    await t.picker();

    expect(t.setGlobalCalls).toHaveLength(0);
    expect(t.setSessionCalls).toHaveLength(0);
    expect(t.toasts).toEqual([
      { message: '"abc" is not a valid value for pings per idle.', variant: 'warning' },
    ]);
  });

  test('cancelling the Custom prompt writes nothing and shows no toast', async () => {
    const t = setup({ selects: ['global:maxPings', 'custom'], prompts: [undefined] });

    await t.picker();

    expect(t.setGlobalCalls).toHaveLength(0);
    expect(t.toasts).toHaveLength(0);
  });

  test('selecting the value already in effect writes nothing and shows no toast', async () => {
    const t = setup({ global: { mode: 'hybrid' }, selects: ['session:mode', 'hybrid'] });

    await t.picker();

    expect(t.setSessionCalls).toHaveLength(0);
    expect(t.toasts).toHaveLength(0);
  });

  test('dismissing the picker writes nothing and shows no toast', async () => {
    const t = setup({ selects: [undefined] });

    await t.picker();

    expect(t.selectCalls).toHaveLength(1);
    expect(t.setSessionCalls).toHaveLength(0);
    expect(t.setGlobalCalls).toHaveLength(0);
    expect(t.toasts).toHaveLength(0);
  });

  test('dismissing a sub-dialog writes nothing and shows no toast', async () => {
    const t = setup({ selects: ['session:mode', undefined] });

    await t.picker();

    expect(t.selectCalls).toHaveLength(2);
    expect(t.setSessionCalls).toHaveLength(0);
    expect(t.toasts).toHaveLength(0);
  });

  test('the reset row resets the session', async () => {
    const t = setup({ selects: ['session:reset'] });

    await t.picker();

    expect(t.resetCalls).toEqual([{ sessionID: 'ses_1' }]);
    expect(t.toasts).toEqual([
      { message: 'Session cache settings reset to global.', variant: 'success' },
    ]);
  });

  test('an RPC failure propagates to the caller', async () => {
    const t = setup({
      selects: ['session:mode', '1h'],
      setSessionImpl: async () => {
        throw new Error('rpc down');
      },
    });

    await expect(t.picker()).rejects.toThrow('rpc down');
    expect(t.toasts).toHaveLength(0);
  });
});
