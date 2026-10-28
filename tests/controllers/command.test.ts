import { describe, expect, mock, test } from 'bun:test';

import { createCacheManagerCommand } from '../../src/controllers/command.ts';
import { SettingsStore } from '../../src/services/settings-store.ts';
import { memoryKv } from '../helpers/memory-kv.ts';

const SESSION = 'ses_test';

async function setup(options: Record<string, unknown> = {}, seed: Record<string, unknown> = {}) {
  const { kv, data } = memoryKv();
  for (const [key, value] of Object.entries(seed)) data.set(key, value);
  const store = new SettingsStore(kv, options);
  await store.load();
  const settingsChanged = mock(async (_sessionID: string | null) => ({}));
  const said: { sessionID: string; text: string }[] = [];
  const say = mock(async (sessionID: string, text: string) => {
    said.push({ sessionID, text });
  });
  const command = createCacheManagerCommand({ store, settingsChanged, say });
  const run = (text: string) => command.execute({ sessionID: SESSION, prompt: { text } });
  return { data, run, command, settingsChanged, said };
}

describe('createCacheManagerCommand', () => {
  test('is named cache-manager', async () => {
    const { command } = await setup();
    expect(command.name).toBe('cache-manager');
  });

  test('accepts a raw string prompt', async () => {
    const { command, data, said } = await setup();
    await command.execute({ sessionID: SESSION, prompt: '1h' });
    expect(data.get(`session/${SESSION}`)).toEqual({ mode: '1h' });
    expect(said).toHaveLength(1);
  });

  test('1h writes the session layer only', async () => {
    const { run, data, said } = await setup();
    await run('1h');
    expect(data.get(`session/${SESSION}`)).toEqual({ mode: '1h' });
    expect(data.has('global')).toBe(false);
    expect(data.has('mode')).toBe(false);
    expect(said).toHaveLength(1);
    expect(said[0]!.sessionID).toBe(SESSION);
    expect(said[0]!.text).toContain('Session');
    expect(said[0]!.text).toContain('1h');
  });

  test('an explicit mode does not touch an existing global setting', async () => {
    const { run, data } = await setup({}, { global: { mode: 'hybrid' } });
    await run('5m');
    expect(data.get('global')).toEqual({ mode: 'hybrid' });
    expect(data.get(`session/${SESSION}`)).toEqual({ mode: '5m' });
  });

  test('hybrid is settable per session', async () => {
    const { run, data, said } = await setup();
    await run('hybrid');
    expect(data.get(`session/${SESSION}`)).toEqual({ mode: 'hybrid' });
    expect(said[0]!.text).toContain('hybrid');
  });

  test('no argument toggles the session mode 5m -> 1h -> 5m', async () => {
    const { run, data, said } = await setup();

    await run('');
    expect(data.get(`session/${SESSION}`)).toEqual({ mode: '1h' });
    expect(said).toHaveLength(1);
    expect(said[0]!.sessionID).toBe(SESSION);
    expect(said[0]!.text).toContain('1h');

    await run('');
    expect(data.get(`session/${SESSION}`)).toEqual({ mode: '5m' });

    await run('');
    expect(data.get(`session/${SESSION}`)).toEqual({ mode: '1h' });
    expect(data.has('global')).toBe(false);
  });

  test('toggle is also reachable with the toggle keyword', async () => {
    const { run, data } = await setup();
    await run('toggle');
    expect(data.get(`session/${SESSION}`)).toEqual({ mode: '1h' });
  });

  test('toggle from hybrid switches to 5m', async () => {
    const { run, data } = await setup({ mode: 'hybrid' });
    await run('');
    expect(data.get(`session/${SESSION}`)).toEqual({ mode: '5m' });
  });

  test('keepalive off, pings 3 and min 20k accumulate in the session patch', async () => {
    const { run, data, said } = await setup();

    await run('keepalive off');
    expect(data.get(`session/${SESSION}`)).toEqual({ keepalive: false });
    expect(said[0]!.text).toContain('Session');

    await run('pings 3');
    await run('min 20k');
    expect(data.get(`session/${SESSION}`)).toEqual({
      keepalive: false,
      maxPings: 3,
      minContextTokens: 20000,
    });
    expect(said[1]!.text).toContain('3');
    expect(said[2]!.text).toContain('20000');
    expect(data.has('global')).toBe(false);
  });

  test('reset removes the session patch', async () => {
    const { run, data, said } = await setup();
    await run('1h');
    await run('reset');
    expect(data.has(`session/${SESSION}`)).toBe(false);
    expect(said).toHaveLength(2);
    expect(said[1]!.sessionID).toBe(SESSION);
    expect(said[1]!.text).toContain('Session');
  });

  test('reset reports the settings the session falls back to', async () => {
    const { run, said } = await setup({}, { global: { mode: 'hybrid' } });
    await run('1h');
    await run('reset');
    expect(said[1]!.text).toContain('hybrid');
  });

  test('status reports the effective session settings without writing', async () => {
    const { run, data, said, settingsChanged } = await setup(
      {},
      { global: { mode: 'hybrid', maxPings: 7 }, [`session/${SESSION}`]: { keepalive: false } }
    );
    const before = new Map(data);

    await run('status');

    expect(new Map(data)).toEqual(before);
    expect(said).toHaveLength(1);
    const text = said[0]!.text;
    expect(text).toContain('hybrid');
    expect(text).toContain('off');
    expect(text).toContain('7');
    expect(settingsChanged).not.toHaveBeenCalled();
  });

  test('status on an unconfigured session reports the defaults', async () => {
    const { run, said } = await setup();
    await run('status');
    expect(said).toHaveLength(1);
    expect(said[0]!.text).toContain('Session');
    expect(said[0]!.text).toContain('5m');
  });

  test('an invalid argument lists the valid ones without writing', async () => {
    const { run, data, said, settingsChanged } = await setup();
    await run('not-a-mode');
    expect(data.size).toBe(0);
    expect(said).toHaveLength(1);
    for (const word of ['5m', '1h', 'hybrid', 'status', 'reset', 'keepalive', 'pings', 'min']) {
      expect(said[0]!.text).toContain(word);
    }
    expect(settingsChanged).not.toHaveBeenCalled();
  });

  describe('settingsChanged', () => {
    test.each([['1h'], [''], ['keepalive off'], ['reset']])(
      'is called once with the session ID after %p',
      async (text) => {
        const { run, settingsChanged } = await setup();
        await run(text);
        expect(settingsChanged).toHaveBeenCalledTimes(1);
        expect(settingsChanged).toHaveBeenCalledWith(SESSION);
      }
    );

    test('runs after the change is persisted and before the reply', async () => {
      const { kv, data } = memoryKv();
      const store = new SettingsStore(kv, {});
      await store.load();
      const seen: unknown[] = [];
      const settingsChanged = mock(async () => {
        seen.push(data.get(`session/${SESSION}`), 'changed');
        return {};
      });
      const say = mock(async () => {
        seen.push('said');
      });
      const command = createCacheManagerCommand({ store, settingsChanged, say });
      await command.execute({ sessionID: SESSION, prompt: { text: '1h' } });
      expect(seen).toEqual([{ mode: '1h' }, 'changed', 'said']);
    });

    test.each([['status'], ['not-a-mode']])('is not called for %p', async (text) => {
      const { run, settingsChanged } = await setup();
      await run(text);
      expect(settingsChanged).not.toHaveBeenCalled();
    });
  });
});
