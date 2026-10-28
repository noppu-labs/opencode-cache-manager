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
import { isNonEmptyString } from '../utils/is-non-empty-string.ts';

/** The fields of OpenCode's `http.response` hook event this plugin reads or writes. */
interface HttpResponseEvent {
  readonly sessionID: string;
  readonly model: ModelRef;
  readonly kind: RequestKind;
  readonly request: Request;
  response: Response;
}

interface ResponseHookDeps {
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
function createResponseHook({ engine, pings, options, profiles }: ResponseHookDeps) {
  return (evt: HttpResponseEvent): Promise<void> => {
    try {
      const ref: ModelRef = { id: evt.model.id, providerID: evt.model.providerID };
      const wire = observedWireFor(
        requestWire(evt.request),
        isAnthropicProvider(ref.providerID),
        options.openaiCompatible
      );
      if (!wire) return Promise.resolve();

      const { kind, sessionID } = evt;
      const isPing = pings.isPing(kind, sessionID);
      const { ok } = evt.response;
      const parsers = PARSERS_BY_WIRE[wire];
      const observed = observeResponseUsage(evt.response, parsers);
      evt.response = observed.response;

      const learns = wire !== 'anthropic-messages' || !isAnthropicProvider(ref.providerID);
      if (
        learns &&
        wire === 'anthropic-messages' &&
        REJECTED_REQUEST_STATUSES.includes(evt.response.status)
      ) {
        void profiles.forget(ref).catch(() => {});
      }
      // Learning settles before the engine hears of the response, so a flip to a non-pinging profile cannot leave a ping armed.
      const unmanagedCheck = learns
        ? observed.identity
            .then(async (identity) => {
              await profiles.learnFromResponse(ref, identity);
              const sessionTurn =
                wire === 'anthropic-messages' &&
                !isPing &&
                (kind === 'primary' || kind === 'compaction');
              if (
                !sessionTurn ||
                !(isNonEmptyString(identity?.model) || isNonEmptyString(identity?.provider))
              ) {
                return false;
              }
              return !(await keepsWarm(evt.request, ref, {
                learned: (model) => profiles.get(model),
                patterns: options.cacheProfiles,
              }));
            })
            .catch(() => false)
        : Promise.resolve(false);

      const reported = Promise.all([observed.usage, observed.stopReason, unmanagedCheck])
        .then(([usage, stopReason, unmanaged]) =>
          engine.responseObserved(sessionID, { isPing, kind, ok, stopReason, unmanaged, usage })
        )
        .catch(() => {});
      if (isPing) pings.responded(sessionID, reported);
    } catch {
      // Observation must never fail the host's response; it passes through unchanged.
    }
    return Promise.resolve();
  };
}

export type { HttpResponseEvent, ResponseHookDeps };
export { createResponseHook };
