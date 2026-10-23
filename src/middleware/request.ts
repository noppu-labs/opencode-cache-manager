import { SENTINEL_HEADER } from "../constants/anthropic.ts";
import type { PluginOptions } from "../config/settings.ts";
import type { CacheTtlMode, ModelRef } from "../models/cache.ts";
import type { RequestKind } from "../models/keepalive.ts";
import { classifyRequest, classifyRequestWithBody } from "../services/classify.ts";
import { resolveActiveMode, transformHttpRequest, ttlForMode } from "../services/cache-ttl.ts";
import type { KeepaliveEngine } from "../services/keepalive-engine.ts";
import { alignPingRequest, readMessages } from "../services/ping-alignment.ts";
import type { PingTracker } from "../services/ping-tracker.ts";
import type { SettingsStore } from "../services/settings-store.ts";
import type { StrategyStore } from "../services/strategy-store.ts";
import { isAnthropicProvider } from "../services/usage.ts";

/** The fields of OpenCode's `http.request` hook event this plugin reads or writes. */
export interface HttpRequestEvent {
  readonly sessionID: string;
  readonly model: ModelRef & { readonly variant?: string };
  readonly kind: RequestKind;
  request: Request;
}

export interface RequestHookDeps {
  store: SettingsStore;
  engine: KeepaliveEngine;
  pings: PingTracker;
  options: PluginOptions;
  strategies: Pick<StrategyStore, "get">;
  /** Latest primary request messages per session, in memory only, kept while a ping may still use them. */
  primaryMessages: Map<string, unknown[]>;
}

/** `http.request`: aligns pings with the last primary request, rewrites cache TTLs, and records the request. */
export function createRequestHook({ store, engine, pings, options, strategies, primaryMessages }: RequestHookDeps) {
  return async (evt: HttpRequestEvent): Promise<void> => {
    const ref: ModelRef = { providerID: evt.model.providerID, id: evt.model.id };
    const anthropicProvider = isAnthropicProvider(ref.providerID);
    const deps = { patterns: options.explicitCacheModels, learned: (r: ModelRef) => strategies.get(r) };
    const cls = options.openaiCompatible
      ? await classifyRequestWithBody(evt.request, ref, deps)
      : classifyRequest(evt.request, ref, deps);
    const chat = cls?.wire === "openai-chat";
    const explicitChat = chat && options.openaiCompatible && cls.strategy === "explicit";
    const implicit = chat && options.openaiCompatible && cls.strategy === "implicit";
    const hasSentinel = evt.request.headers.has(SENTINEL_HEADER);
    const rewrites = anthropicProvider || hasSentinel || explicitChat;
    const observed = anthropicProvider || cls?.wire === "anthropic-messages" || (chat && options.openaiCompatible);
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
    if (rewrites) {
      // With the option off an `openai-chat` request keeps the Anthropic-shaped behaviour, except that a
      // sentinel is still stripped and honoured.
      const opts =
        chat && (options.openaiCompatible || hasSentinel)
          ? { wire: "openai-chat" as const, inject: explicitChat && !isPing && (evt.kind === "primary" || evt.kind === "compaction") }
          : {};
      request = await transformHttpRequest(request, mode, opts);
    }
    evt.request = request;
    if (!observed) return;

    try {
      if (evt.kind === "compaction") primaryMessages.delete(sessionID);
      if (!implicit && evt.kind === "primary" && engine.snapshot(sessionID).skipReason !== "child") {
        const parsed = await readMessages(request);
        if (parsed) primaryMessages.set(sessionID, parsed.messages);
      }
      engine.requestSent(sessionID, {
        requestedTtl: implicit ? null : ttlForMode(resolveActiveMode(original, mode)),
        isPing,
        kind: evt.kind,
      });
    } catch {
      // Keepalive bookkeeping must never fail the host's request.
    }
  };
}
