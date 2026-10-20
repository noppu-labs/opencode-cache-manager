import type { RequestKind } from "../models/keepalive.ts";
import type { KeepaliveEngine } from "../services/keepalive-engine.ts";
import type { PingTracker } from "../services/ping-tracker.ts";
import { isAnthropicMessagesRequest, isAnthropicProvider, observeResponseUsage } from "../services/usage.ts";

/** The fields of OpenCode's `http.response` hook event this plugin reads or writes. */
export interface HttpResponseEvent {
  readonly sessionID: string;
  readonly model: { readonly providerID: string };
  readonly kind: RequestKind;
  readonly request: Request;
  response: Response;
}

export interface ResponseHookDeps {
  engine: KeepaliveEngine;
  pings: PingTracker;
}

/** `http.response`: reads usage and the stop reason in the background and reports them to the engine. */
export function createResponseHook({ engine, pings }: ResponseHookDeps) {
  return async (evt: HttpResponseEvent): Promise<void> => {
    try {
      if (!isAnthropicProvider(evt.model.providerID) && !isAnthropicMessagesRequest(evt.request)) return;

      const sessionID = evt.sessionID;
      const kind = evt.kind;
      const isPing = pings.isPing(kind, sessionID);
      const ok = evt.response.ok;
      const observed = observeResponseUsage(evt.response);
      evt.response = observed.response;

      const reported = Promise.all([observed.usage, observed.stopReason])
        .then(([usage, stopReason]) => engine.responseObserved(sessionID, { usage, ok, isPing, kind, stopReason }))
        .catch(() => {});
      if (isPing) pings.responded(sessionID, reported);
    } catch {
      // Observation must never fail the host's response; it passes through unchanged.
    }
  };
}
