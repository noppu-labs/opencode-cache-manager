import type { PluginOptions } from '../config/settings.ts';
import { SENTINEL_HEADER } from '../constants/anthropic.ts';
import type { CacheTtlMode, ModelRef } from '../models/cache.ts';
import type { RequestKind } from '../models/keepalive.ts';
import { resolveActiveMode, transformHttpRequest } from '../services/cache-ttl.ts';
import {
  classifyRequestWithBody,
  isAnthropicProvider,
  profileForRoute,
  routeRequest,
  shouldInject,
} from '../services/classify.ts';
import type { KeepaliveEngine } from '../services/keepalive-engine.ts';
import { alignPingRequest, readMessages } from '../services/ping-alignment.ts';
import type { PingTracker } from '../services/ping-tracker.ts';
import type { ProfileStore } from '../services/profile-store.ts';
import { profileFor } from '../services/profiles/index.ts';
import type { SettingsStore } from '../services/settings-store.ts';

/** The fields of OpenCode's `http.request` hook event this plugin reads or writes. */
interface HttpRequestEvent {
  readonly sessionID: string;
  readonly model: ModelRef;
  readonly kind: RequestKind;
  request: Request;
}

interface RequestHookDeps {
  store: SettingsStore;
  engine: KeepaliveEngine;
  pings: PingTracker;
  options: PluginOptions;
  profiles: Pick<ProfileStore, 'get'>;
  /** Latest primary request messages per session, in memory only, kept while a ping may still use them. */
  primaryMessages: Map<string, unknown[]>;
}

/** `http.request`: aligns pings with the last primary request, rewrites cache TTLs, and records the request. */
function createRequestHook({
  store,
  engine,
  pings,
  options,
  profiles,
  primaryMessages,
}: RequestHookDeps) {
  return async (evt: HttpRequestEvent): Promise<void> => {
    const ref: ModelRef = { id: evt.model.id, providerID: evt.model.providerID };
    const anthropicProvider = isAnthropicProvider(ref.providerID);
    const deps = {
      learned: (model: ModelRef) => profiles.get(model),
      patterns: options.cacheProfiles,
    };
    const cls = await classifyRequestWithBody(evt.request, ref, deps, {
      openaiWires: options.openaiCompatible,
    });
    const hasSentinel = evt.request.headers.has(SENTINEL_HEADER);
    const route = routeRequest({
      anthropicProvider,
      cls,
      hasSentinel,
      openaiCompatible: options.openaiCompatible,
    });
    const profileId = profileForRoute(route, options.openaiCompatible);
    if (profileId === undefined) return;
    const profile = profileFor(profileId);
    const { rewrites } = route;
    const observed = route.observedWire !== undefined;

    const { sessionID } = evt;
    let mode: CacheTtlMode;
    try {
      ({ mode } = await store.effective(sessionID));
    } catch {
      ({ mode } = store.global());
    }
    const original = evt.request;
    const isPing = observed && pings.isPing(evt.kind, sessionID);
    const keptWarm = observed && profile.pings;

    /*
     * Alignment runs before the TTL rewrite so the copied primary messages
     * take the ping's own mode and beta header, keeping 1h ahead of 5m.
     */
    let request = original;
    if (isPing && keptWarm) {
      try {
        request = await alignPingRequest(original, primaryMessages.get(sessionID));
      } catch {
        request = original;
      }
    }
    if (rewrites) {
      try {
        request = await transformHttpRequest(request, mode, {
          inject: shouldInject(route, evt.kind, isPing),
          isPing,
          kind: evt.kind,
          profile,
          wire: route.transformWire ?? 'anthropic-messages',
        });
      } catch {
        // A rewrite failure sends the request as it was rather than failing it.
      }
    }
    evt.request = request;
    if (!observed) return;

    try {
      if (evt.kind === 'compaction') primaryMessages.delete(sessionID);
      if (keptWarm && evt.kind === 'primary' && engine.snapshot(sessionID).skipReason !== 'child') {
        const parsed = await readMessages(request);
        if (parsed) primaryMessages.set(sessionID, parsed.messages);
      }
      const activeMode = resolveActiveMode(original, mode);
      const requestedTtl = profile.ttlForMode(activeMode);
      engine.requestSent(sessionID, {
        isPing,
        kind: evt.kind,
        model: ref,
        requestedTtl,
        split: activeMode === 'hybrid' && requestedTtl !== null,
      });
    } catch {
      // Keepalive bookkeeping must never fail the host's request.
    }
  };
}

export type { HttpRequestEvent, RequestHookDeps };
export { createRequestHook };
