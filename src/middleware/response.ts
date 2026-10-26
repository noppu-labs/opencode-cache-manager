import type { PluginOptions } from "../config/settings.ts";
import type { ModelRef, ResponseParsers, Wire } from "../models/cache.ts";
import type { RequestKind } from "../models/keepalive.ts";
import type { KeepaliveEngine } from "../services/keepalive-engine.ts";
import { isAnthropicProvider, observedWireFor, requestWire } from "../services/classify.ts";
import type { PingTracker } from "../services/ping-tracker.ts";
import type { ProfileStore } from "../services/profile-store.ts";
import { observeResponseUsage } from "../services/response-observer.ts";
import { ANTHROPIC_PARSERS } from "../services/usage.ts";
import { OPENAI_PARSERS } from "../services/usage-openai.ts";
import { RESPONSES_PARSERS } from "../services/usage-responses.ts";

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
  profiles: Pick<ProfileStore, "learnFromResponse">;
}

const PARSERS_BY_WIRE: Record<Wire, ResponseParsers> = {
  "anthropic-messages": ANTHROPIC_PARSERS,
  "openai-chat": OPENAI_PARSERS,
  "openai-responses": RESPONSES_PARSERS,
};

/** `http.response`: reads usage and the stop reason in the background, reports them to the engine and learns the profile from the model a response reports. */
export function createResponseHook({ engine, pings, options, profiles }: ResponseHookDeps) {
  return async (evt: HttpResponseEvent): Promise<void> => {
    try {
      const ref: ModelRef = { providerID: evt.model.providerID, id: evt.model.id };
      const wire = observedWireFor(requestWire(evt.request), isAnthropicProvider(ref.providerID), options.openaiCompatible);
      if (!wire) return;

      const sessionID = evt.sessionID;
      const kind = evt.kind;
      const isPing = pings.isPing(kind, sessionID);
      const ok = evt.response.ok;
      const parsers = PARSERS_BY_WIRE[wire];
      const observed = observeResponseUsage(evt.response, parsers);
      evt.response = observed.response;

      const reported = Promise.all([observed.usage, observed.stopReason])
        .then(([usage, stopReason]) => engine.responseObserved(sessionID, { usage, ok, isPing, kind, stopReason }))
        .catch(() => {});
      if (isPing) pings.responded(sessionID, reported);
      if (wire !== "anthropic-messages" || !isAnthropicProvider(ref.providerID)) {
        void observed.identity.then((identity) => profiles.learnFromResponse(ref, identity)).catch(() => {});
      }
    } catch {
      // Observation must never fail the host's response; it passes through unchanged.
    }
  };
}
