import type { SettingsPatch } from '../config/settings.ts';
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
export type CommandAction =
  | { type: 'toggle' }
  | { type: 'status' }
  | { type: 'reset' }
  | { type: 'set'; patch: SettingsPatch }
  | { type: 'invalid' };

/** Parses `50000` or `50k` into a token count; `undefined` when malformed. */
function parseTokenCount(text: string | undefined): number | undefined {
  const match = /^(\d+)(k?)$/.exec(text ?? '');
  if (!match) return undefined;
  return Number(match[1]) * (match[2] ? 1000 : 1);
}

/**
 * Parses a slash-command argument into an action. Accepts a raw string, a
 * `PromptInput.Prompt`-shaped object, or an array of `{ text }` parts.
 */
export function parseCommandArg(raw: unknown): CommandAction {
  const text = extractRawText(raw).trim().toLowerCase();
  if (text === '' || text === 'toggle') return { type: 'toggle' };
  if (text === 'status') return { type: 'status' };
  if (text === 'reset') return { type: 'reset' };
  if (isCacheTtlMode(text)) return { type: 'set', patch: { mode: text } };

  const [command, value, ...rest] = text.split(/\s+/);
  if (rest.length > 0) return { type: 'invalid' };

  if (command === 'keepalive' && (value === 'on' || value === 'off')) {
    return { type: 'set', patch: { keepalive: value === 'on' } };
  }
  if (command === 'pings' && /^\d+$/.test(value ?? '')) {
    const maxPings = Number(value);
    if (maxPings <= 100) return { type: 'set', patch: { maxPings } };
  }
  if (command === 'min') {
    const minContextTokens = parseTokenCount(value);
    if (minContextTokens !== undefined) {
      return { type: 'set', patch: { minContextTokens } };
    }
  }
  return { type: 'invalid' };
}
