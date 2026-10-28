import { mergeSettings } from '../config/settings.ts';
import { parseCommandArg } from '../controllers/command-args.ts';
import type { CacheTtlRpcClient } from '../rpc.ts';
import { errorMessage, formatTokens } from '../utils/format.ts';
import { FIELD_INFO, FIELDS, formatValue, type Toast } from './picker.ts';

const USAGE =
  'Usage: /cache-manager [5m | 1h | hybrid | keepalive on|off | pings <n> | min <n|nk> | reset | status]';
const NO_SESSION = 'Open a session to change session cache settings.';

export interface CommandRunnerDeps {
  rpc: CacheTtlRpcClient;
  toast: Toast;
  currentSessionID(): string | undefined;
  openPicker(): Promise<void>;
}

/**
 * Runs the TUI `/cache-manager` command. With no argument it opens the picker;
 * a typed argument is applied to the current session directly. Errors become
 * an error toast.
 */
export function createCommandRunner({
  rpc,
  toast,
  currentSessionID,
  openPicker,
}: CommandRunnerDeps) {
  const runTyped = async (input: string): Promise<void> => {
    const action = parseCommandArg(input);
    if (action.type === 'toggle') return openPicker();
    if (action.type === 'invalid') {
      toast(USAGE, 'warning');
      return;
    }
    const sessionID = currentSessionID();
    if (sessionID === undefined) {
      toast(NO_SESSION, 'warning');
      return;
    }

    if (action.type === 'status') {
      const { global, session } = await rpc.getSettings({ sessionID });
      const s = mergeSettings(global, session ?? {});
      toast(
        `Session cache: TTL ${s.mode}, keepalive ${formatValue('keepalive', s.keepalive)}, pings ${s.maxPings}, min context ${formatTokens(s.minContextTokens)}.`,
        'info'
      );
      return;
    }
    if (action.type === 'reset') {
      await rpc.resetSession({ sessionID });
      toast('Session cache settings reset to global.', 'success');
      return;
    }

    await rpc.setSession({ sessionID, patch: action.patch });
    for (const field of FIELDS) {
      const value = action.patch[field];
      if (value === undefined) continue;
      toast(
        `Session ${FIELD_INFO[field].label} set to ${formatValue(field, value as never)}.`,
        'success'
      );
    }
  };

  return async (input?: string): Promise<void> => {
    try {
      await runTyped(input ?? '');
    } catch (error) {
      toast(`Cache Manager error: ${errorMessage(error)}`, 'error');
    }
  };
}
