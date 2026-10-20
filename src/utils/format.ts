/** "52m", "3m", "45s"; "1h 05m" at 60 minutes and above. */
export function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  return `${Math.floor(totalMinutes / 60)}h ${String(totalMinutes % 60).padStart(2, "0")}m`;
}

/** "50k" for whole thousands, the plain number otherwise. */
export function formatTokens(tokens: number): string {
  return tokens > 0 && tokens % 1000 === 0 ? `${tokens / 1000}k` : String(tokens);
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
