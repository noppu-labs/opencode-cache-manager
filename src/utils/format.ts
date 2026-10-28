import {
  MILLION,
  MINUTES_PER_HOUR,
  MS_PER_SECOND,
  SECONDS_PER_MINUTE,
  THOUSAND,
} from '../constants/units.ts';

/** Below this many tokens `formatCompactTokens` keeps one decimal of thousands. */
const COMPACT_DECIMAL_LIMIT = 100_000;

/** "52m", "3m", "45s"; "1h 05m" at 60 minutes and above. */
function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / MS_PER_SECOND));
  if (totalSeconds < SECONDS_PER_MINUTE) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE);
  if (totalMinutes < MINUTES_PER_HOUR) return `${totalMinutes}m`;
  return `${Math.floor(totalMinutes / MINUTES_PER_HOUR)}h ${String(totalMinutes % MINUTES_PER_HOUR).padStart(2, '0')}m`;
}

/** "50k" for whole thousands, the plain number otherwise. */
function formatTokens(tokens: number): string {
  return tokens > 0 && tokens % THOUSAND === 0 ? `${tokens / THOUSAND}k` : String(tokens);
}

const trim = (value: number): string => value.toFixed(1).replace(/\.0$/u, '');

/** "732", "14.8k", "16k", "123k", "1.2M": a short token count for narrow displays. */
function formatCompactTokens(tokens: number): string {
  if (tokens < THOUSAND) return String(tokens);
  if (tokens < COMPACT_DECIMAL_LIMIT) {
    const k = trim(tokens / THOUSAND);
    if (k !== '100') return `${k}k`;
  }
  const rounded = Math.round(tokens / THOUSAND);
  if (tokens < MILLION && rounded < THOUSAND) return `${rounded}k`;
  return `${trim(tokens / MILLION)}M`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export { formatRemaining, formatTokens, formatCompactTokens, errorMessage };
