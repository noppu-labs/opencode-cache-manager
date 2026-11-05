import { BETA_HEADER, EXTENDED_CACHE_BETA, SENTINEL_HEADER } from '../constants/anthropic.ts';
import { DEBUG_FIELD_CHARS } from '../constants/debug.ts';
import { isCacheTtlMode, type CacheTtlMode, type Ttl, type Wire } from '../models/cache.ts';
import type { RequestKind } from '../models/keepalive.ts';
import type { CacheProfile } from '../models/profile.ts';
import { dbg, dbgEnabled, dbgUrl } from '../utils/debug-log.ts';
import { isRecord } from '../utils/is-record.ts';
import { applyTtlToBlock, hasOneHourCacheControl } from './cache-control.ts';

/** Anthropic TTL for a mode: the TTL a keepalive ping should refresh; hybrid's message tail is 5m. */
function ttlForMode(mode: CacheTtlMode): Ttl {
  return mode === '1h' ? '1h' : '5m';
}

/** The mode a request runs at: a valid `x-cache-ttl` header, else `fallback`. */
function resolveActiveMode(request: Request, fallback: CacheTtlMode): CacheTtlMode {
  const normalized = (request.headers.get(SENTINEL_HEADER) ?? '').trim().toLowerCase();
  return isCacheTtlMode(normalized) ? normalized : fallback;
}

/** The non-empty, trimmed tokens of a comma-separated `anthropic-beta` header value. */
function betaTokens(value: string | null): string[] {
  return (value ?? '')
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

/**
 * Merges the extended-cache beta flag into an `anthropic-beta` header value,
 * preserving the existing order and never introducing duplicates.
 */
function mergeBetaHeader(
  existing: string | null,
  includeExtendedCacheBeta: boolean
): string | null {
  const tokens = betaTokens(existing);

  if (includeExtendedCacheBeta && !tokens.includes(EXTENDED_CACHE_BETA)) {
    tokens.push(EXTENDED_CACHE_BETA);
  }

  return tokens.length > 0 ? tokens.join(',') : null;
}

/** Applies a TTL to a tool block and any nested namespace `tools`. */
function applyTtlToTool(tool: unknown, ttl: '1h' | undefined): boolean {
  if (!isRecord(tool)) return false;
  let changed = applyTtlToBlock(tool, ttl);
  const nested = tool.tools;
  if (Array.isArray(nested)) {
    for (const child of nested) {
      changed = applyTtlToTool(child, ttl) || changed;
    }
  }
  return changed;
}

/**
 * Rewrites every ephemeral `cache_control` breakpoint in an Anthropic request
 * body to match `mode`. Returns true when anything changed or a 1h breakpoint
 * is present.
 */
function rewriteAnthropicCacheTtl(body: Record<string, unknown>, mode: CacheTtlMode): boolean {
  let changed = false;

  const prefixTtl: '1h' | undefined = mode === '1h' || mode === 'hybrid' ? '1h' : undefined;

  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      changed = applyTtlToTool(tool, prefixTtl) || changed;
    }
  }

  if (Array.isArray(body.system)) {
    for (const block of body.system) {
      changed = applyTtlToBlock(block, prefixTtl) || changed;
    }
  }

  /*
   * In hybrid mode the message tail stays at the 5m default so that the 1h
   * prefix breakpoints remain ahead of any 5m breakpoint.
   */
  const messageTtl: '1h' | undefined = mode === '1h' ? '1h' : undefined;

  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      changed = applyTtlToBlock(message, messageTtl) || changed;
      const content = isRecord(message) ? message.content : undefined;
      if (Array.isArray(content)) {
        for (const part of content) {
          changed = applyTtlToBlock(part, messageTtl) || changed;
        }
      }
    }
  }

  return changed || hasOneHourCacheControl(body);
}

/** Rebuilds the request around a rewritten body and its already merged headers. */
function finalizeRequest(
  request: Request,
  body: Record<string, unknown>,
  headers: Headers
): Request {
  return new Request(request.url, {
    body: JSON.stringify(body),
    headers,
    method: request.method,
    signal: request.signal,
  });
}

/** How `transformHttpRequest` rewrites a request: the wire it is on and the cache profile it goes through. */
interface TransformOptions {
  wire: Wire;
  profile: CacheProfile;
  kind: RequestKind;
  isPing: boolean;
  inject: boolean;
}

/** Merges a profile's extra headers; the beta header is merged with any existing beta values. */
function applyProfileHeaders(headers: Headers, extra: Record<string, string>): void {
  for (const [name, value] of Object.entries(extra)) {
    if (name.toLowerCase() !== BETA_HEADER) {
      headers.set(name, value);
      continue;
    }
    const tokens = betaTokens(headers.get(BETA_HEADER));
    for (const token of betaTokens(value)) {
      if (!tokens.includes(token)) tokens.push(token);
    }
    if (tokens.length > 0) headers.set(BETA_HEADER, tokens.join(','));
  }
}

/** A `cache_control` field for the trace. An object or a long string logs as its type: either could hold body text, and an object can be too deep to serialize. */
function describeCacheField(value: unknown): string {
  if (typeof value === 'string' && value.length > DEBUG_FIELD_CHARS) return 'string';
  return typeof value === 'object' && value !== null ? 'object' : JSON.stringify(value);
}

/** A message's `role` for the trace. Only a string: a parsed object may have no string form, and this runs outside `dbg`'s try. */
function describeRole(message: unknown): string {
  if (!isRecord(message) || typeof message.role !== 'string') return '?';
  return message.role.length > DEBUG_FIELD_CHARS ? 'string' : message.role;
}

/** A node's `cache_control` as `type` or `type/ttl`; undefined when it has none. */
function describeCacheControl(node: unknown): string | undefined {
  const cc = isRecord(node) && isRecord(node.cache_control) ? node.cache_control : undefined;
  if (cc === undefined) return undefined;
  const ttl = cc.ttl === undefined ? '' : `/${describeCacheField(cc.ttl)}`;
  return `${describeCacheField(cc.type)}${ttl}`;
}

/**
 * Debug only: where `cache_control` sits in a body, so a request logged as
 * `inject=true, rewritten=false` can be told apart from one that was simply
 * already marked. Covers `tools`, `system`, `messages` and the top level. Empty
 * `marks` does not mean no breakpoints: it stays empty on the Responses wire,
 * whose `input` is not read, and `prompt_cache_breakpoint` is not read on any wire.
 */
function breakpointSurvey(body: Record<string, unknown>): Record<string, unknown> {
  const marks: string[] = [];
  const tools = Array.isArray(body.tools) ? body.tools : [];
  for (const [index, tool] of tools.entries()) {
    const mark = describeCacheControl(tool);
    if (mark !== undefined) marks.push(`tool[${index}]=${mark}`);
  }
  const system: unknown[] = Array.isArray(body.system) ? body.system : [];
  for (const [index, block] of system.entries()) {
    const mark = describeCacheControl(block);
    if (mark !== undefined) marks.push(`system[${index}]=${mark}`);
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const [index, message] of messages.entries()) {
    const role = describeRole(message);
    const mark = describeCacheControl(message);
    if (mark !== undefined) marks.push(`msg[${index}:${role}]=${mark}`);
    const content = isRecord(message) ? message.content : undefined;
    if (!Array.isArray(content)) continue;
    for (const [part, node] of content.entries()) {
      const partMark = describeCacheControl(node);
      if (partMark !== undefined) {
        marks.push(`msg[${index}:${role}].content[${part}]=${partMark}`);
      }
    }
  }

  return {
    marks,
    messages: messages.length,
    tools: tools.length,
    topLevel: describeCacheControl(body) ?? null,
  };
}

/**
 * Transforms an outbound request through its cache profile: strips the internal
 * `x-cache-ttl` sentinel, lets the profile rewrite the body for the active mode,
 * and merges the profile's headers. The `anthropic` profile on `anthropic-messages`
 * always re-serializes a JSON body; otherwise a body the profile did not change keeps
 * its original bytes, and on the OpenAI wires the original request is returned when
 * there was no sentinel.
 */
async function transformHttpRequest(
  request: Request,
  fallbackMode: CacheTtlMode,
  opts: TransformOptions
): Promise<Request> {
  const hadSentinel = request.headers.has(SENTINEL_HEADER);
  const activeMode = resolveActiveMode(request, fallbackMode);

  const headers = new Headers(request.headers);
  headers.delete(SENTINEL_HEADER);

  if (activeMode === '5m' && !hadSentinel && !request.body) {
    dbg('transform.skipped5mNoBody', { url: dbgUrl(request.url) });
    return request;
  }

  if (!request.body) {
    return hadSentinel
      ? new Request(request.url, { headers, method: request.method, signal: request.signal })
      : request;
  }

  let parsed: unknown;
  try {
    const text = await request.clone().text();
    parsed = text.trim() === '' ? undefined : JSON.parse(text);
  } catch {
    parsed = undefined;
  }

  if (!isRecord(parsed)) {
    dbg('transform.bodyNotRecord', { hadSentinel, mode: activeMode, url: dbgUrl(request.url) });
    if (!hadSentinel) return request;
    const buffer = await request.clone().arrayBuffer();
    return new Request(request.url, {
      body: buffer,
      headers,
      method: request.method,
      signal: request.signal,
    });
  }

  const { wire, profile, kind, isPing, inject } = opts;
  const before = dbgEnabled() ? breakpointSurvey(parsed) : undefined;
  const changed = profile.rewrite(parsed, { inject, isPing, kind, mode: activeMode, wire });
  if (dbgEnabled()) {
    dbg('transform.breakpoints', {
      after: breakpointSurvey(parsed),
      before,
      changed,
      inject,
      isPing,
      kind,
      mode: activeMode,
      profile: profile.id,
      wire,
    });
  }
  applyProfileHeaders(headers, profile.headers?.(parsed, { mode: activeMode, wire }) ?? {});
  if (changed || (wire === 'anthropic-messages' && profile.id === 'anthropic')) {
    return finalizeRequest(request, parsed, headers);
  }
  if (wire !== 'anthropic-messages' && !hadSentinel) return request;
  const original = await request.clone().arrayBuffer();
  return new Request(request.url, {
    body: original,
    headers,
    method: request.method,
    signal: request.signal,
  });
}

export type { TransformOptions };
export {
  ttlForMode,
  resolveActiveMode,
  betaTokens,
  mergeBetaHeader,
  rewriteAnthropicCacheTtl,
  transformHttpRequest,
};
