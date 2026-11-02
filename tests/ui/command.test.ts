import { describe, expect, test } from 'bun:test';

import type { Settings, SettingsPatch } from '../../src/config/settings.ts';
import type { CacheTtlRpcClient } from '../../src/rpc.ts';
import { createCommandRunner } from '../../src/ui/command.ts';

interface Toast {
  message: string;
  variant: string;
}

interface Options {
  sessionID?: string | undefined;
  global?: Partial<Settings>;
  session?: SettingsPatch | null;
  setSessionImpl?: (input: unknown) => Promise<unknown>;
}

function setup(options: Options = {}) {
  const toasts: Toast[] = [];
  const setSessionCalls: any[] = [];
  const resetCalls: any[] = [];
  const getSettingsCalls: any[] = [];
  const setGlobalCalls: any[] = [];
  let openPickerCalls = 0;
  const sessionID = 'sessionID' in options ? options.sessionID : 'ses_1';
  const global: Settings = {
    mode: '5m',
    keepalive: true,
    maxPings: 5,
    minContextTokens: 50_000,
    savings: true,
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

  const run = createCommandRunner({
    rpc,
    toast: (message, variant) => {
      toasts.push({ message, variant });
    },
    currentSessionID: () => sessionID,
    openPicker: async () => {
      openPickerCalls++;
    },
  });

  return {
    run,
    toasts,
    setSessionCalls,
    setGlobalCalls,
    resetCalls,
    getSettingsCalls,
    openPickerCalls: () => openPickerCalls,
  };
}

describe('createCommandRunner', () => {
  test('no argument opens the picker', async () => {
    const t = setup();

    await t.run();
    await t.run('');

    expect(t.openPickerCalls()).toBe(2);
    expect(t.setSessionCalls).toHaveLength(0);
    expect(t.toasts).toHaveLength(0);
  });

  test('toggle opens the picker, even without a session', async () => {
    const t = setup({ sessionID: undefined });

    await t.run('toggle');

    expect(t.openPickerCalls()).toBe(1);
    expect(t.toasts).toHaveLength(0);
  });

  test('typed pings 3 sets the session', async () => {
    const t = setup();

    await t.run('pings 3');

    expect(t.openPickerCalls()).toBe(0);
    expect(t.setSessionCalls).toEqual([{ sessionID: 'ses_1', patch: { maxPings: 3 } }]);
    expect(t.toasts).toEqual([{ message: 'Session pings per idle set to 3.', variant: 'success' }]);
  });

  test('typed mode, keepalive and min arguments set the session', async () => {
    const t = setup();

    await t.run('hybrid');
    await t.run('keepalive off');
    await t.run('min 20k');

    expect(t.setSessionCalls.map((c) => c.patch)).toEqual([
      { mode: 'hybrid' },
      { keepalive: false },
      { minContextTokens: 20_000 },
    ]);
    expect(t.toasts.map((x) => x.message)).toEqual([
      'Session cache TTL set to hybrid.',
      'Session keepalive set to off.',
      'Session min context set to 20k.',
    ]);
  });

  test('typed reset resets the session', async () => {
    const t = setup();

    await t.run('reset');

    expect(t.resetCalls).toEqual([{ sessionID: 'ses_1' }]);
    expect(t.setSessionCalls).toHaveLength(0);
    expect(t.toasts).toEqual([
      { message: 'Session cache settings reset to global.', variant: 'success' },
    ]);
  });

  test('typed savings off sets the session and toasts', async () => {
    const t = setup();

    await t.run('savings off');

    expect(t.setSessionCalls).toEqual([{ patch: { savings: false }, sessionID: 'ses_1' }]);
    expect(t.toasts.map((toast) => toast.message)).toEqual(['Session savings set to off.']);
  });

  test('typed status shows the effective session values', async () => {
    const t = setup({ global: { mode: 'hybrid' }, session: { maxPings: 2, keepalive: false } });

    await t.run('status');

    expect(t.getSettingsCalls).toEqual([{ sessionID: 'ses_1' }]);
    expect(t.openPickerCalls()).toBe(0);
    expect(t.toasts).toEqual([
      {
        message: 'Session cache: TTL hybrid, keepalive off, pings 2, min context 50k, savings on.',
        variant: 'info',
      },
    ]);
  });

  test('a typed argument without a session warns and writes nothing', async () => {
    const t = setup({ sessionID: undefined });

    await t.run('1h');
    await t.run('status');
    await t.run('reset');

    expect(t.setSessionCalls).toHaveLength(0);
    expect(t.setGlobalCalls).toHaveLength(0);
    expect(t.resetCalls).toHaveLength(0);
    expect(t.getSettingsCalls).toHaveLength(0);
    expect(t.toasts).toEqual(
      Array.from({ length: 3 }, () => ({
        message: 'Open a session to change session cache settings.',
        variant: 'warning',
      }))
    );
  });

  test('garbage input warns with the usage text', async () => {
    const t = setup();

    await t.run('garbage');

    expect(t.openPickerCalls()).toBe(0);
    expect(t.setSessionCalls).toHaveLength(0);
    expect(t.toasts).toEqual([
      {
        message:
          'Usage: /cache-manager [5m | 1h | hybrid | keepalive on|off | pings <n> | min <n|nk> | savings on|off | reset | status]',
        variant: 'warning',
      },
    ]);
  });

  test('an RPC failure surfaces as an error toast without throwing', async () => {
    const t = setup({
      setSessionImpl: async () => {
        throw new Error('rpc down');
      },
    });

    await expect(t.run('1h')).resolves.toBeUndefined();

    expect(t.setSessionCalls).toHaveLength(1);
    expect(t.toasts).toHaveLength(1);
    expect(t.toasts[0].variant).toBe('error');
    expect(t.toasts[0].message).toContain('rpc down');
  });
});
