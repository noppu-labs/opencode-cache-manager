/** GETs `url` and parses the body as JSON; rejects on a non-2xx status or after `timeoutMs`. */
export async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    throw new Error(`GET ${url} answered ${String(response.status)}`);
  }
  return response.json();
}
