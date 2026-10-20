import { EXTENDED_CACHE_BETA, SENTINEL_HEADER } from "../constants/anthropic.ts";
import { isCacheTtlMode, type CacheTtlMode, type Ttl } from "../models/cache.ts";

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

/** Applies a TTL (or removes it, when `undefined`) to a single cache_control block. */
function applyTtlToBlock(block: unknown, ttl: "1h" | undefined): boolean {
  if (!block || typeof block !== "object") return false;
  const rec = block as Record<string, unknown>;
  const cacheControl = rec.cache_control;

  if (
    cacheControl &&
    typeof cacheControl === "object" &&
    (cacheControl as Record<string, unknown>).type === "ephemeral"
  ) {
    const cc = cacheControl as Record<string, unknown>;
    if (ttl === "1h") {
      if (cc.ttl !== "1h") {
        cc.ttl = "1h";
        return true;
      }
      return false;
    }
    if ("ttl" in cc) {
      delete cc.ttl;
      return true;
    }
  }

  return false;
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

/** Returns true when any ephemeral breakpoint in the payload carries a 1h TTL. */
export function hasOneHourCacheControl(body: Record<string, unknown>): boolean {
  const isOneHour = (block: unknown): boolean => {
    if (!block || typeof block !== "object") return false;
    const cacheControl = (block as Record<string, unknown>).cache_control;
    return (
      !!cacheControl &&
      typeof cacheControl === "object" &&
      (cacheControl as Record<string, unknown>).ttl === "1h"
    );
  };

  const tools = body.tools;
  if (Array.isArray(tools)) {
    for (const tool of tools) {
      if (isOneHour(tool)) return true;
      const nested = (tool as Record<string, unknown> | null)?.tools;
      if (Array.isArray(nested) && nested.some(isOneHour)) return true;
    }
  }

  if (Array.isArray(body.system) && body.system.some(isOneHour)) return true;

  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (isOneHour(message)) return true;
      const content = (message as Record<string, unknown> | null)?.content;
      if (Array.isArray(content) && content.some(isOneHour)) return true;
    }
  }

  return false;
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

/**
 * Transforms an outbound Anthropic HTTP request: rewrites cache_control TTLs,
 * strips the internal `x-cache-ttl` sentinel, and adds the extended-cache beta
 * flag when 1h breakpoints are emitted.
 */
export async function transformHttpRequest(
  request: Request,
  fallbackMode: CacheTtlMode,
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

  rewriteAnthropicCacheTtl(parsed as Record<string, unknown>, activeMode);

  if (activeMode === "1h" || activeMode === "hybrid") {
    const merged = mergeBetaHeader(headers.get("anthropic-beta"), true);
    if (merged !== null) headers.set("anthropic-beta", merged);
  }

  return new Request(request.url, {
    method: request.method,
    headers,
    body: JSON.stringify(parsed),
    signal: request.signal,
  });
}
