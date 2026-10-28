/** "52m", "3m", "45s"; "1h 05m" at 60 minutes and above. */
export function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  return `${Math.floor(totalMinutes / 60)}h ${String(totalMinutes % 60).padStart(2, '0')}m`;
}

/** "50k" for whole thousands, the plain number otherwise. */
export function formatTokens(tokens: number): string {
  return tokens > 0 && tokens % 1000 === 0 ? `${tokens / 1000}k` : String(tokens);
}

const trim = (value: number): string => value.toFixed(1).replace(/\.0$/u, '');

/** "732", "14.8k", "16k", "123k", "1.2M": a short token count for narrow displays. */
export function formatCompactTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 100_000) {
    const k = trim(tokens / 1_000);
    if (k !== '100') return `${k}k`;
  }
  const rounded = Math.round(tokens / 1_000);
  if (tokens < 1_000_000 && rounded < 1_000) return `${rounded}k`;
  return `${trim(tokens / 1_000_000)}M`;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
