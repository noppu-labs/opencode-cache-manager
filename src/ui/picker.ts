import type { Plugin } from '@opencode/plugin/tui';

import { mergeSettings, type Settings, type SettingsPatch } from '../config/settings.ts';
import { parseCommandArg } from '../controllers/command-args.ts';
import type { CacheTtlMode } from '../models/cache.ts';
import type { CacheTtlRpcClient } from '../rpc.ts';
import { formatTokens } from '../utils/format.ts';

/**
 * Interactive metadata for each cache TTL mode, shown in the picker modal.
 */
const OPTION_INFO: Record<CacheTtlMode, { title: string; description: string }> = {
  '1h': {
    description: 'Claude: 1h on every breakpoint, 2x write cost. GPT-5.6+: a 12h breakpoint.',
    title: '1 hour (extended)',
  },
  '5m': {
    description: 'Claude: 5m on every breakpoint, 1.25x write cost. GPT-5.6+: automatic 30m cache.',
    title: '5 minutes (default)',
  },
  'hybrid': {
    description:
      'Claude: 1h on tools + system, 5m on messages. GPT-5.6+: 12h on the system prompt, 30m tail.',
    title: 'Hybrid',
  },
};

const CUSTOM = 'custom';

const onOff = (value: boolean): string => (value ? 'on' : 'off');

type Field = keyof Settings;
type Scope = 'session' | 'global';
interface Choice<Value> {
  title: string;
  value: Value;
  description?: string;
}

const isScope = (value: string | undefined): value is Scope =>
  value === 'session' || value === 'global';
const isField = (value: string | undefined): value is Field =>
  FIELDS.some((field) => field === value);

const FIELDS: Field[] = ['mode', 'keepalive', 'maxPings', 'minContextTokens'];

const FIELD_INFO: Record<Field, { row: string; label: string }> = {
  keepalive: { label: 'keepalive', row: 'Keepalive' },
  maxPings: { label: 'pings per idle', row: 'Pings per idle' },
  minContextTokens: { label: 'min context', row: 'Min context' },
  mode: { label: 'cache TTL', row: 'TTL mode' },
};

/* oxlint-disable eslint/no-magic-numbers -- the preset values offered in the picker are the data itself */
const PING_CHOICES = [0, 1, 3, 5, 10];
const MIN_CONTEXT_CHOICES = [0, 20_000, 50_000, 100_000];
/* oxlint-enable eslint/no-magic-numbers */

type Toast = (message: string, variant: 'success' | 'info' | 'warning' | 'error') => unknown;

function formatValue(field: Field, value: Settings[Field]): string {
  if (field === 'keepalive') return value === true ? 'on' : 'off';
  if (field === 'minContextTokens' && typeof value === 'number') return formatTokens(value);
  return String(value);
}

/** Dialog rows for one scope; session rows mark values inherited from global. */
function settingsOptions(
  scope: Scope,
  values: Settings,
  override: SettingsPatch | null
): { title: string; value: string; category: string }[] {
  const category = scope === 'session' ? 'Session' : 'Global';
  return FIELDS.map((field) => {
    const inherited = scope === 'session' && override?.[field] === undefined;
    return {
      category,
      title: `${FIELD_INFO[field].row}  ${formatValue(field, values[field])}${inherited ? ' · global' : ''}`,
      value: `${scope}:${field}`,
    };
  });
}

/** The sub-dialog choices for a setting; `custom` is present for numeric ones. */
function fieldChoices(field: Field): Choice<string | number>[] {
  switch (field) {
    case 'mode': {
      return (['5m', '1h', 'hybrid'] as const).map((value) => ({ value, ...OPTION_INFO[value] }));
    }
    case 'keepalive': {
      return [
        { title: 'on', value: 'on' },
        { title: 'off', value: 'off' },
      ];
    }
    case 'maxPings': {
      return [
        ...PING_CHOICES.map((value) => ({ title: String(value), value })),
        { title: 'Custom…', value: CUSTOM },
      ];
    }
    case 'minContextTokens': {
      return [
        ...MIN_CONTEXT_CHOICES.map((value) => ({ title: formatTokens(value), value })),
        { title: 'Custom…', value: CUSTOM },
      ];
    }
    default: {
      throw new Error(`unknown setting: ${String(field satisfies never)}`);
    }
  }
}

interface PickerDeps {
  dialog: Plugin.Context['ui']['dialog'];
  rpc: CacheTtlRpcClient;
  toast: Toast;
  currentSessionID: () => string | undefined;
}

/** The Cache Manager picker: Session and Global sections, one sub-dialog per setting. */
function createPicker({ dialog, rpc, toast, currentSessionID }: PickerDeps): () => Promise<void> {
  const write = async (
    scope: Scope,
    sessionID: string | undefined,
    patch: SettingsPatch
  ): Promise<void> => {
    await (scope === 'session' && sessionID !== undefined
      ? rpc.setSession({ patch, sessionID })
      : rpc.setGlobal({ patch }));
  };

  /** Asks for a number via the prompt dialog; `undefined` on cancel or invalid input. */
  const promptNumber = async (
    field: 'maxPings' | 'minContextTokens'
  ): Promise<number | undefined> => {
    const input = await dialog.prompt({
      description: field === 'maxPings' ? 'Number of pings, 0-100.' : 'Tokens, e.g. 50000 or 50k.',
      placeholder: field === 'maxPings' ? '5' : '50k',
      title: FIELD_INFO[field].row,
    });
    if (input === undefined) return undefined;
    const action = parseCommandArg(`${field === 'maxPings' ? 'pings' : 'min'} ${input}`);
    const value = action.type === 'set' ? action.patch[field] : undefined;
    if (value === undefined) {
      toast(`"${input.trim()}" is not a valid value for ${FIELD_INFO[field].label}.`, 'warning');
    }
    return value;
  };

  /** Picks a new value for one setting and writes it; cancelling writes nothing. */
  const editField = async (
    scope: Scope,
    field: Field,
    sessionID: string | undefined,
    effective: Settings
  ): Promise<void> => {
    const current = effective[field];
    const currentChoice = typeof current === 'boolean' ? onOff(current) : current;
    const selected = await dialog.select<string | number>({
      current: currentChoice,
      options: fieldChoices(field),
      title: `${scope === 'session' ? 'Session' : 'Global'} ${FIELD_INFO[field].label}`,
    });
    if (selected === undefined) return;

    let patch: SettingsPatch;
    if (selected === CUSTOM) {
      if (field !== 'maxPings' && field !== 'minContextTokens') return;
      const value = await promptNumber(field);
      if (value === undefined) return;
      patch = { [field]: value };
    } else if (field === 'keepalive') {
      patch = { keepalive: selected === 'on' };
    } else {
      patch = { [field]: selected };
    }

    const next = patch[field];
    if (next === undefined || next === current) return;
    await write(scope, sessionID, patch);
    toast(
      `${scope === 'session' ? 'Session' : 'Global'} ${FIELD_INFO[field].label} set to ${formatValue(field, next)}.`,
      'success'
    );
  };

  return async (): Promise<void> => {
    const sessionID = currentSessionID();
    const { global, session } = await rpc.getSettings(sessionID === undefined ? {} : { sessionID });
    const effective = mergeSettings(global, session ?? {});

    const options = [
      ...(sessionID === undefined
        ? []
        : [
            ...settingsOptions('session', effective, session),
            { category: 'Session', title: 'Reset session to global', value: 'session:reset' },
          ]),
      ...settingsOptions('global', global, null),
    ];
    const choice = await dialog.select<string>({
      options,
      placeholder: 'Select a setting',
      title: 'Cache Manager',
    });
    if (choice === undefined) return;

    if (choice === 'session:reset') {
      if (sessionID === undefined) return;
      await rpc.resetSession({ sessionID });
      toast('Session cache settings reset to global.', 'success');
      return;
    }
    const [scope, field] = choice.split(':');
    if (!isScope(scope) || !isField(field)) return;
    await editField(scope, field, sessionID, scope === 'session' ? effective : global);
  };
}

export type { Toast, PickerDeps };
export { FIELDS, FIELD_INFO, formatValue, createPicker };
