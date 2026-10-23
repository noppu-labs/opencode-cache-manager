import type { PluginOptions } from "../config/settings.ts";
import type { ModelRef, Wire } from "../models/cache.ts";
import type { RequestKind } from "../models/keepalive.ts";
import type { KeepaliveEngine } from "../services/keepalive-engine.ts";
import { isAnthropicProvider, requestWire } from "../services/classify.ts";
import type { PingTracker } from "../services/ping-tracker.ts";
import type { StrategyStore } from "../services/strategy-store.ts";
import { observeResponseUsage } from "../services/usage.ts";

/** The fields of OpenCode's `http.response` hook event this plugin reads or writes. */
export interface HttpResponseEvent {
  readonly sessionID: string;
  readonly model: ModelRef & { readonly variant?: string };
  readonly kind: RequestKind;
  readonly request: Request;
  response: Response;
}

export interface ResponseHookDeps {
  engine: KeepaliveEngine;
  pings: PingTracker;
  options: PluginOptions;
  strategies: Pick<StrategyStore, "learnFromResponse">;
}

/** The wire to observe, or `undefined` to leave the response alone. With the option off, `openai-chat` behaves as before the option existed. */
function observedWire(wire: Wire | undefined, anthropicProvider: boolean, openaiCompatible: boolean): Wire | undefined {
  if (wire === "openai-chat" && openaiCompatible) return "openai-chat";
  return anthropicProvider || wire === "anthropic-messages" ? "anthropic-messages" : undefined;
}

/** `http.response`: reads usage and the stop reason in the background, reports them to the engine and learns the strategy from `openai-chat` responses. */
export function createResponseHook({ engine, pings, options, strategies }: ResponseHookDeps) {
  return async (evt: HttpResponseEvent): Promise<void> => {
    try {
      const ref: ModelRef = { providerID: evt.model.providerID, id: evt.model.id };
      const wire = observedWire(requestWire(evt.request), isAnthropicProvider(ref.providerID), options.openaiCompatible);
      if (!wire) return;

      const sessionID = evt.sessionID;
      const kind = evt.kind;
      const isPing = pings.isPing(kind, sessionID);
      const ok = evt.response.ok;
      const observed = observeResponseUsage(evt.response, wire);
      evt.response = observed.response;

      const reported = Promise.all([observed.usage, observed.stopReason])
        .then(([usage, stopReason]) => engine.responseObserved(sessionID, { usage, ok, isPing, kind, stopReason }))
        .catch(() => {});
      if (isPing) pings.responded(sessionID, reported);
      if (wire === "openai-chat") {
        void observed.identity.then((identity) => strategies.learnFromResponse(ref, identity)).catch(() => {});
      }
    } catch {
      // Observation must never fail the host's response; it passes through unchanged.
    }
  };
}
