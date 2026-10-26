import type { CacheProfileId, CacheTtlMode, Ttl, Wire } from "./cache.ts";
import type { RequestKind } from "./keepalive.ts";

/** What a profile needs to know about a request to rewrite it. */
export interface RewriteContext {
  wire: Wire;
  mode: CacheTtlMode;
  kind: RequestKind;
  isPing: boolean;
  inject: boolean;
}

/** One provider's way of controlling its prompt cache: mode to TTL, request rewriting, keepalive. */
export interface CacheProfile {
  id: CacheProfileId;
  /** Wires this profile can rewrite on; on any other wire the request is only observed (`implicit`). */
  wires: readonly Wire[];
  /** The TTL keepalive should track for a mode; `null` when there is nothing to keep warm. */
  ttlForMode(mode: CacheTtlMode): Ttl | null;
  /** Rewrites a parsed body in place for this mode and kind. Returns true if anything changed. */
  rewrite(body: Record<string, unknown>, ctx: RewriteContext): boolean;
  /** Extra headers to merge after `rewrite` (Anthropic: the beta flag when a 1h breakpoint is present). */
  headers?(body: Record<string, unknown>, ctx: { wire: Wire; mode: CacheTtlMode }): Record<string, string>;
  /** Whether keepalive pings are allowed. */
  pings: boolean;
}
