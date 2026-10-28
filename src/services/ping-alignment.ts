import type { KeepaliveSnapshot, SkipReason } from '../models/keepalive.ts';

/** Copy of a message with `cache_control` removed from it and from its content parts. */
function withoutCacheControl(message: unknown): unknown {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return message;
  const { cache_control: _message, ...rest } = message as Record<string, unknown>;
  if (Array.isArray(rest.content)) {
    rest.content = rest.content.map((part) => {
      if (typeof part !== 'object' || part === null || Array.isArray(part)) return part;
      const { cache_control: _part, ...kept } = part as Record<string, unknown>;
      return kept;
    });
  }
  return rest;
}

/**
 * Makes a ping's history match the primary request's so the cached prefix is
 * hit: every message but the ping's last is replaced by the primary's message
 * at the same index, `cache_control` included. Messages that do not come from
 * the primary (the ping's last, and any ping entries beyond the primary's
 * length) have their `cache_control` removed so the ping adds no breakpoints
 * and does not pay to cache itself. Returns a new array; the inputs are not
 * mutated.
 */
export function alignPingMessages(pingMessages: unknown[], primaryMessages: unknown[]): unknown[] {
  const shared = Math.max(0, Math.min(pingMessages.length - 1, primaryMessages.length));
  return pingMessages.map((message, i) =>
    i < shared ? primaryMessages[i] : withoutCacheControl(message)
  );
}

/** The array a ping is aligned on: chat and Messages `messages`, or Responses `input`. */
export type MessagesKey = 'messages' | 'input';

/** Parses a request body's `messages` array, or its Responses `input` array; undefined when neither is present or the body is not JSON. */
export async function readMessages(
  request: Request
): Promise<{ body: Record<string, unknown>; key: MessagesKey; messages: unknown[] } | undefined> {
  try {
    const body: unknown = JSON.parse(await request.clone().text());
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
    const record = body as Record<string, unknown>;
    const key: MessagesKey | undefined = Array.isArray(record.messages)
      ? 'messages'
      : Array.isArray(record.input)
        ? 'input'
        : undefined;
    return key === undefined
      ? undefined
      : { body: record, key, messages: record[key] as unknown[] };
  } catch {
    return undefined;
  }
}

/** The ping request with its history replaced by the stored primary messages, or unchanged. */
export async function alignPingRequest(
  request: Request,
  primary: unknown[] | undefined
): Promise<Request> {
  const parsed = primary && (await readMessages(request));
  if (!primary || !parsed) return request;
  const body = JSON.stringify({
    ...parsed.body,
    [parsed.key]: alignPingMessages(parsed.messages, primary),
  });
  const headers = new Headers(request.headers);
  headers.delete('content-length');
  return new Request(request.url, {
    method: request.method,
    headers,
    body,
    signal: request.signal,
  });
}

const DROPS_MESSAGES = new Set<SkipReason>([
  'child',
  'implicit',
  'missed',
  'exhausted',
  'disabled',
]);

/** True once no ping can use the session's stored primary messages any more. */
export function releasesMessages(snapshot: KeepaliveSnapshot, now: number): boolean {
  const expired = snapshot.expiresAt !== null && snapshot.expiresAt <= now;
  return expired || (snapshot.skipReason !== null && DROPS_MESSAGES.has(snapshot.skipReason));
}
