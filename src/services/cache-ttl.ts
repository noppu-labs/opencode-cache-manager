import { BETA_HEADER, EXTENDED_CACHE_BETA, SENTINEL_HEADER } from "../constants/anthropic.ts";
import { isCacheTtlMode, type CacheTtlMode, type Ttl, type Wire } from "../models/cache.ts";
import { applyTtlToBlock, hasOneHourCacheControl } from "./cache-control.ts";
import { injectOpenAiBreakpoints, rewriteOpenAiCacheTtl } from "./openai-cache-ttl.ts";

/** The TTL a keepalive ping should refresh; hybrid's message tail is 5m. */
export function ttlForMode(mode: CacheTtlMode): Ttl {
  return mode === "1h" ? "1h" : "5m";
}

/** The mode a request runs at: a valid `x-cache-ttl` header, else `fallback`. */
export function resolveActiveMode(request: Request, fallback: CacheTtlMode): CacheTtlMode {
  const normalized = (request.headers.get(SENTINEL_HEADER) ?? "").trim().toLowerCase();
  return isCacheTtlMode(normalized) ? normalized : fallback;
}

/**
 * Merges the extended-cache beta flag into an `anthropic-beta` header value,
 * preserving the existing order and never introducing duplicates.
 */
export function mergeBetaHeader(
  existing: string | null,
  includeExtendedCacheBeta: boolean,
): string | null {
  const tokens = (existing ?? "")
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  if (includeExtendedCacheBeta && !tokens.includes(EXTENDED_CACHE_BETA)) {
    tokens.push(EXTENDED_CACHE_BETA);
  }

  return tokens.length > 0 ? tokens.join(",") : null;
}

/** Applies a TTL to a tool block and any nested namespace `tools`. */
function applyTtlToTool(tool: unknown, ttl: "1h" | undefined): boolean {
  if (!tool || typeof tool !== "object") return false;
  let changed = applyTtlToBlock(tool, ttl);
  const nested = (tool as Record<string, unknown>).tools;
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
export function rewriteAnthropicCacheTtl(
  body: Record<string, unknown>,
  mode: CacheTtlMode,
): boolean {
  let changed = false;

  const prefixTtl: "1h" | undefined =
    mode === "1h" || mode === "hybrid" ? "1h" : undefined;

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

  // In hybrid mode the message tail stays at the 5m default so that the 1h
  // prefix breakpoints remain ahead of any 5m breakpoint.
  const messageTtl: "1h" | undefined = mode === "1h" ? "1h" : undefined;

  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      changed = applyTtlToBlock(message, messageTtl) || changed;
      const content = (message as Record<string, unknown> | null)?.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          changed = applyTtlToBlock(part, messageTtl) || changed;
        }
      }
    }
  }

  return changed || hasOneHourCacheControl(body);
}

/** Rebuilds the request around a rewritten body, merging the extended-cache beta flag when asked. */
function finalizeRequest(
  request: Request,
  body: Record<string, unknown>,
  headers: Headers,
  includeExtendedCacheBeta: boolean,
): Request {
  if (includeExtendedCacheBeta) {
    const merged = mergeBetaHeader(headers.get(BETA_HEADER), true);
    if (merged !== null) headers.set(BETA_HEADER, merged);
  }
  return new Request(request.url, {
    method: request.method,
    headers,
    body: JSON.stringify(body),
    signal: request.signal,
  });
}

/**
 * Transforms an outbound Anthropic HTTP request: rewrites cache_control TTLs,
 * strips the internal `x-cache-ttl` sentinel, and adds the extended-cache beta
 * flag when 1h breakpoints are emitted. On the `openai-chat` wire it can also
 * inject breakpoints first (`opts.inject`) and only re-serializes the body when
 * something changed.
 */
export async function transformHttpRequest(
  request: Request,
  fallbackMode: CacheTtlMode,
  opts: { wire?: Wire; inject?: boolean } = {},
): Promise<Request> {
  const hadSentinel = request.headers.has(SENTINEL_HEADER);
  const activeMode = resolveActiveMode(request, fallbackMode);

  const headers = new Headers(request.headers);
  headers.delete(SENTINEL_HEADER);

  if (activeMode === "5m" && !hadSentinel && !request.body) return request;

  if (!request.body) {
    return hadSentinel
      ? new Request(request.url, { method: request.method, headers, signal: request.signal })
      : request;
  }

  let parsed: unknown;
  try {
    const text = await request.clone().text();
    parsed = text.trim() === "" ? undefined : JSON.parse(text);
  } catch {
    parsed = undefined;
  }

  if (
    parsed === undefined ||
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    if (!hadSentinel) return request;
    const buffer = await request.clone().arrayBuffer();
    return new Request(request.url, { method: request.method, headers, body: buffer, signal: request.signal });
  }

  if (opts.wire === "openai-chat") {
    const chat = parsed as Record<string, unknown>;
    const injected = opts.inject === true && injectOpenAiBreakpoints(chat);
    const rewritten = rewriteOpenAiCacheTtl(chat, activeMode);
    if (!hadSentinel && !injected && !rewritten) return request;
    return finalizeRequest(request, chat, headers, hasOneHourCacheControl(chat));
  }

  const messages = parsed as Record<string, unknown>;
  rewriteAnthropicCacheTtl(messages, activeMode);
  return finalizeRequest(request, messages, headers, activeMode === "1h" || activeMode === "hybrid");
}
