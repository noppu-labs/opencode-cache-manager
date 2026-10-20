import { SENTINEL_HEADER } from "../constants/anthropic.ts";
import type { CacheTtlMode } from "../models/cache.ts";
import type { RequestKind } from "../models/keepalive.ts";
import { resolveActiveMode, transformHttpRequest, ttlForMode } from "../services/cache-ttl.ts";
import type { KeepaliveEngine } from "../services/keepalive-engine.ts";
import { alignPingRequest, readMessages } from "../services/ping-alignment.ts";
import type { PingTracker } from "../services/ping-tracker.ts";
import type { SettingsStore } from "../services/settings-store.ts";
import { isAnthropicMessagesRequest, isAnthropicProvider } from "../services/usage.ts";

/** The fields of OpenCode's `http.request` hook event this plugin reads or writes. */
export interface HttpRequestEvent {
  readonly sessionID: string;
  readonly model: { readonly providerID: string };
  readonly kind: RequestKind;
  request: Request;
}

export interface RequestHookDeps {
  store: SettingsStore;
  engine: KeepaliveEngine;
  pings: PingTracker;
  /** Latest primary request messages per session, in memory only, kept while a ping may still use them. */
  primaryMessages: Map<string, unknown[]>;
}

/** `http.request`: aligns pings with the last primary request, rewrites cache TTLs, and records the request. */
export function createRequestHook({ store, engine, pings, primaryMessages }: RequestHookDeps) {
  return async (evt: HttpRequestEvent): Promise<void> => {
    const providerID = evt.model.providerID;
    const rewrites = isAnthropicProvider(providerID) || evt.request.headers.has(SENTINEL_HEADER);
    const observed = isAnthropicProvider(providerID) || isAnthropicMessagesRequest(evt.request);
    if (!rewrites && !observed) return;

    const sessionID = evt.sessionID;
    let mode: CacheTtlMode;
    try {
      mode = (await store.effective(sessionID)).mode;
    } catch {
      mode = store.global().mode;
    }
    const original = evt.request;
    const isPing = observed && pings.isPing(evt.kind, sessionID);

    // Alignment runs before the TTL rewrite so the copied primary messages
    // take the ping's own mode and beta header, keeping 1h ahead of 5m.
    let request = original;
    if (isPing) {
      try {
        request = await alignPingRequest(original, primaryMessages.get(sessionID));
      } catch {
        request = original;
      }
    }
    if (rewrites) request = await transformHttpRequest(request, mode);
    evt.request = request;
    if (!observed) return;

    try {
      if (evt.kind === "compaction") primaryMessages.delete(sessionID);
      if (evt.kind === "primary" && engine.snapshot(sessionID).skipReason !== "child") {
        const parsed = await readMessages(request);
        if (parsed) primaryMessages.set(sessionID, parsed.messages);
      }
      engine.requestSent(sessionID, { requestedTtl: ttlForMode(resolveActiveMode(original, mode)), isPing });
    } catch {
      // Keepalive bookkeeping must never fail the host's request.
    }
  };
}
