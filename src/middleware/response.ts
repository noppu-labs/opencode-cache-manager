import type { PluginOptions } from '../config/settings.ts';
import { REJECTED_REQUEST_STATUSES } from '../constants/anthropic.ts';
import type { ModelRef, ResponseParsers, Wire } from '../models/cache.ts';
import type { RequestKind } from '../models/keepalive.ts';
import {
  isAnthropicProvider,
  keepsWarm,
  observedWireFor,
  requestWire,
} from '../services/classify.ts';
import type { KeepaliveEngine } from '../services/keepalive-engine.ts';
import type { PingTracker } from '../services/ping-tracker.ts';
import type { ProfileStore } from '../services/profile-store.ts';
import { observeResponseUsage } from '../services/response-observer.ts';
import { OPENAI_PARSERS } from '../services/usage-openai.ts';
import { RESPONSES_PARSERS } from '../services/usage-responses.ts';
import { ANTHROPIC_PARSERS } from '../services/usage.ts';

/** The fields of OpenCode's `http.response` hook event this plugin reads or writes. */
export interface HttpResponseEvent {
  readonly sessionID: string;
  readonly model: ModelRef;
  readonly kind: RequestKind;
  readonly request: Request;
  response: Response;
}

export interface ResponseHookDeps {
  engine: KeepaliveEngine;
  pings: PingTracker;
  options: PluginOptions;
  profiles: Pick<ProfileStore, 'learnFromResponse' | 'forget' | 'get'>;
}

const PARSERS_BY_WIRE: Record<Wire, ResponseParsers> = {
  'anthropic-messages': ANTHROPIC_PARSERS,
  'openai-chat': OPENAI_PARSERS,
  'openai-responses': RESPONSES_PARSERS,
};

/**
 * `http.response`: reads usage and the stop reason in the background, reports them to the engine and learns the
 * profile from the model a response reports. A Messages request a non-Anthropic provider rejects (400 or 422) drops
 * the learned entry, so a stale `anthropic` cannot keep sending a rewrite the upstream rejects.
 */
export function createResponseHook({ engine, pings, options, profiles }: ResponseHookDeps) {
  return async (evt: HttpResponseEvent): Promise<void> => {
    try {
      const ref: ModelRef = { providerID: evt.model.providerID, id: evt.model.id };
      const wire = observedWireFor(
        requestWire(evt.request),
        isAnthropicProvider(ref.providerID),
        options.openaiCompatible
      );
      if (!wire) return;

      const sessionID = evt.sessionID;
      const kind = evt.kind;
      const isPing = pings.isPing(kind, sessionID);
      const ok = evt.response.ok;
      const parsers = PARSERS_BY_WIRE[wire];
      const observed = observeResponseUsage(evt.response, parsers);
      evt.response = observed.response;

      const learns = wire !== 'anthropic-messages' || !isAnthropicProvider(ref.providerID);
      if (
        learns &&
        wire === 'anthropic-messages' &&
        REJECTED_REQUEST_STATUSES.includes(evt.response.status)
      )
        void profiles.forget(ref).catch(() => {});
      // Learning settles before the engine hears of the response, so a flip to a non-pinging profile cannot leave a ping armed.
      const unmanagedCheck = learns
        ? observed.identity
            .then(async (identity) => {
              await profiles.learnFromResponse(ref, identity);
              const sessionTurn =
                wire === 'anthropic-messages' &&
                !isPing &&
                (kind === 'primary' || kind === 'compaction');
              if (!sessionTurn || !(identity?.model || identity?.provider)) return false;
              return !(await keepsWarm(evt.request, ref, {
                patterns: options.cacheProfiles,
                learned: (r) => profiles.get(r),
              }));
            })
            .catch(() => false)
        : Promise.resolve(false);

      const reported = Promise.all([observed.usage, observed.stopReason, unmanagedCheck])
        .then(([usage, stopReason, unmanaged]) =>
          engine.responseObserved(sessionID, { usage, ok, isPing, kind, stopReason, unmanaged })
        )
        .catch(() => {});
      if (isPing) pings.responded(sessionID, reported);
    } catch {
      // Observation must never fail the host's response; it passes through unchanged.
    }
  };
}
