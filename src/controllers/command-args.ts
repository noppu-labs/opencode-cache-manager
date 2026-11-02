import { MAX_PINGS_LIMIT, type SettingsPatch } from '../config/settings.ts';
import { THOUSAND } from '../constants/units.ts';
import { isCacheTtlMode } from '../models/cache.ts';

/** Extracts a plain string from the various shapes a slash-command argument may take. */
function extractRawText(raw: unknown): string {
  if (typeof raw === 'string') return raw;

  const own = textField(raw);
  if (own !== undefined) return own;

  if (Array.isArray(raw)) {
    return raw
      .map((item: unknown) => textField(item) ?? '')
      .filter((part) => part.length > 0)
      .join(' ');
  }

  return '';
}

function textField(value: unknown): string | undefined {
  if (
    typeof value === 'object' &&
    value !== null &&
    'text' in value &&
    typeof value.text === 'string'
  ) {
    return value.text;
  }
  return undefined;
}

/** What a `/cache-manager` argument asks for. */
type CommandAction =
  | { type: 'toggle' }
  | { type: 'status' }
  | { type: 'reset' }
  | { type: 'set'; patch: SettingsPatch }
  | { type: 'invalid' };

/** Parses `50000` or `50k` into a token count; `undefined` when malformed or too large to represent exactly. */
function parseTokenCount(text: string | undefined): number | undefined {
  const groups = /^(?<count>\d+)(?<unit>k?)$/u.exec(text ?? '')?.groups;
  if (!groups) return undefined;
  const count = Number(groups.count) * (groups.unit ? THOUSAND : 1);
  return Number.isSafeInteger(count) ? count : undefined;
}

/**
 * Parses a slash-command argument into an action. Accepts a raw string, a
 * `PromptInput.Prompt`-shaped object, or an array of `{ text }` parts.
 */
function parseCommandArg(raw: unknown): CommandAction {
  const text = extractRawText(raw).trim().toLowerCase();
  if (text === '' || text === 'toggle') return { type: 'toggle' };
  if (text === 'status') return { type: 'status' };
  if (text === 'reset') return { type: 'reset' };
  if (isCacheTtlMode(text)) return { patch: { mode: text }, type: 'set' };

  const [command, value, ...rest] = text.split(/\s+/u);
  if (rest.length > 0) return { type: 'invalid' };

  if (command === 'keepalive' && (value === 'on' || value === 'off')) {
    return { patch: { keepalive: value === 'on' }, type: 'set' };
  }
  if (command === 'savings' && (value === 'on' || value === 'off')) {
    return { patch: { savings: value === 'on' }, type: 'set' };
  }
  if (command === 'pings' && /^\d+$/u.test(value ?? '')) {
    const maxPings = Number(value);
    if (maxPings <= MAX_PINGS_LIMIT) return { patch: { maxPings }, type: 'set' };
  }
  if (command === 'min') {
    const minContextTokens = parseTokenCount(value);
    if (minContextTokens !== undefined) {
      return { patch: { minContextTokens }, type: 'set' };
    }
  }
  return { type: 'invalid' };
}

export type { CommandAction };
export { parseCommandArg };
