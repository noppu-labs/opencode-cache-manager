import type { Settings } from '../config/settings.ts';
import type { SettingsStore } from '../services/settings-store.ts';
import { parseCommandArg } from './command-args.ts';

const INVALID_ARGUMENT_TEXT =
  'Unknown cache argument. Use `5m`, `1h`, `hybrid`, `keepalive on|off`, ' +
  '`pings <0-100>`, `min <tokens|50k>`, `status`, or `reset`, ' +
  'or run `/cache-manager` with no argument to toggle this session between 5m and 1h.';

function describeSettings(settings: Settings): string {
  return (
    `mode ${settings.mode}, keepalive ${settings.keepalive ? 'on' : 'off'}, ` +
    `max pings ${settings.maxPings}, min context ${settings.minContextTokens} tokens`
  );
}

interface CommandDeps {
  store: SettingsStore;
  /** Applies a settings change to the keepalive schedule and tells the TUI. */
  settingsChanged: (sessionID: string | null) => Promise<unknown>;
  /** Shows `text` in the session without resuming it. */
  say: (sessionID: string, text: string) => Promise<unknown>;
}

interface CacheManagerCommand {
  description: string;
  execute: (input: { sessionID: string; prompt: unknown }) => Promise<void>;
  name: string;
}

/** The `/cache-manager` command: typed arguments edit the current session's settings. */
function createCacheManagerCommand({
  store,
  settingsChanged,
  say,
}: CommandDeps): CacheManagerCommand {
  return {
    description:
      "Manage this session's prompt cache (5m | 1h | hybrid | keepalive on|off | pings N | min N | status | reset)",
    async execute(input: { sessionID: string; prompt: unknown }): Promise<void> {
      const { sessionID } = input;
      const action = parseCommandArg(input.prompt);

      switch (action.type) {
        case 'status': {
          await say(
            sessionID,
            `Session cache settings: ${describeSettings(await store.effective(sessionID))}.`
          );
          return;
        }
        case 'invalid': {
          await say(sessionID, INVALID_ARGUMENT_TEXT);
          return;
        }
        case 'reset': {
          await store.resetSession(sessionID);
          await settingsChanged(sessionID);
          await say(
            sessionID,
            `Session cache settings reset: ${describeSettings(await store.effective(sessionID))}.`
          );
          return;
        }
        case 'toggle': {
          const { mode } = await store.effective(sessionID);
          await store.setSession(sessionID, { mode: mode === '5m' ? '1h' : '5m' });
          break;
        }
        case 'set': {
          await store.setSession(sessionID, action.patch);
          break;
        }
      }
      await settingsChanged(sessionID);
      await say(
        sessionID,
        `Session cache settings updated: ${describeSettings(await store.effective(sessionID))}.`
      );
    },
    name: 'cache-manager',
  };
}

export type { CacheManagerCommand, CommandDeps };
export { createCacheManagerCommand };
