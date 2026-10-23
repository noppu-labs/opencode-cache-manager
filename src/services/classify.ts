import { ANTHROPIC_PROVIDER_IDS, MESSAGES_SUFFIX } from "../constants/anthropic.ts";
import {
  CHAT_COMPLETIONS_SUFFIX,
  CLAUDE_MODEL,
  OPENAI_CACHE_MODEL,
  RESPONSES_SUFFIX,
} from "../constants/openai.ts";
import type { CacheProfileId, ModelRef, ProfilePattern, Wire } from "../models/cache.ts";
import type { RequestKind } from "../models/keepalive.ts";
import { matchProfilePatterns } from "./model-patterns.ts";
import { isRecord } from "../utils/is-record.ts";
import { isPostToPathSuffix } from "../utils/request-path.ts";

/** True for the provider IDs whose requests are always rewritten and observed. */
export function isAnthropicProvider(providerID: string): boolean {
  return ANTHROPIC_PROVIDER_IDS.includes(providerID);
}

/** True for a POST whose path ends in `/messages`, on any host (direct or proxied). */
export function isAnthropicMessagesRequest(request: Request): boolean {
  return isPostToPathSuffix(request, MESSAGES_SUFFIX);
}

export interface ClassifyDeps {
  patterns: readonly ProfilePattern[];
  learned?: (ref: ModelRef) => CacheProfileId | undefined;
}

/** The wire of an outgoing request, or `undefined` when it is not an Anthropic Messages, chat completions or Responses call. */
export function requestWire(request: Request): Wire | undefined {
  if (isAnthropicMessagesRequest(request)) return "anthropic-messages";
  if (isPostToPathSuffix(request, CHAT_COMPLETIONS_SUFFIX)) return "openai-chat";
  return isPostToPathSuffix(request, RESPONSES_SUFFIX) ? "openai-responses" : undefined;
}

/** True for the two OpenAI-format wires, which share one profile resolution. */
function isOpenAiWire(wire: Wire | undefined): wire is "openai-chat" | "openai-responses" {
  return wire === "openai-chat" || wire === "openai-responses";
}

export interface Classification {
  wire: Wire;
  profile: CacheProfileId;
}

/**
 * Decides the wire and cache profile of an outgoing request, or `undefined` when it is not a known wire.
 * Precedence on the OpenAI wires: user patterns, built-in Claude regex, built-in OpenAI regex, learned, implicit.
 */
export function classifyRequest(
  request: Request,
  ref: ModelRef,
  deps: ClassifyDeps,
  bodyModel?: string,
): Classification | undefined {
  const wire = requestWire(request);
  if (wire === undefined) return undefined;
  if (wire === "anthropic-messages") return { wire, profile: "anthropic" };

  const matches = (regex: RegExp) => regex.test(ref.id) || (bodyModel !== undefined && regex.test(bodyModel));
  const profile =
    matchProfilePatterns(deps.patterns, ref) ??
    (matches(CLAUDE_MODEL) ? "anthropic" : undefined) ??
    (matches(OPENAI_CACHE_MODEL) ? "openai" : undefined) ??
    deps.learned?.(ref) ??
    "implicit";
  return { wire, profile };
}

/**
 * `classifyRequest` plus `body.model` as a second look: OpenCode's model ID is its own key, while the
 * body carries the upstream ID. The body is read from a clone, and only when the first pass is
 * `implicit` on an OpenAI wire and no user pattern matched, so a pattern, a Claude or GPT ID or a
 * learned profile never costs a parse.
 */
export async function classifyRequestWithBody(
  request: Request,
  ref: ModelRef,
  deps: ClassifyDeps,
): Promise<Classification | undefined> {
  const first = classifyRequest(request, ref, deps);
  if (!isOpenAiWire(first?.wire) || first?.profile !== "implicit") return first;
  if (matchProfilePatterns(deps.patterns, ref) !== undefined) return first;
  try {
    const body: unknown = await request.clone().json();
    const model = isRecord(body) && typeof body.model === "string" ? body.model : undefined;
    return model === undefined ? first : classifyRequest(request, ref, deps, model);
  } catch {
    return first;
  }
}

export interface RouteInput {
  cls: Classification | undefined;
  anthropicProvider: boolean;
  hasSentinel: boolean;
  openaiCompatible: boolean;
}

export interface Route {
  /** The request body or headers are rewritten. */
  rewrites: boolean;
  /** The wire whose response and usage are observed; `undefined` leaves the request and response alone. */
  observedWire: Wire | undefined;
  /** The profile the request classified to, or `undefined` when it is not a known wire. */
  profile: CacheProfileId | undefined;
  /** An OpenAI-wire request whose profile is managed (only with the option on): not `implicit`. */
  managed: boolean;
  /** The wire to hand `transformHttpRequest`, or `undefined` to rewrite as an Anthropic body. */
  transformWire: Wire | undefined;
}

/** The wire whose response is observed, or `undefined` to leave it alone. With the option off, the OpenAI wires behave as before the option existed. */
export function observedWireFor(
  wire: Wire | undefined,
  anthropicProvider: boolean,
  openaiCompatible: boolean,
): Wire | undefined {
  if (isOpenAiWire(wire) && openaiCompatible) return wire;
  return anthropicProvider || wire === "anthropic-messages" ? "anthropic-messages" : undefined;
}

/** Decides, from one classification, what both HTTP hooks do with a request: rewrite it, observe it, and on which wire. */
export function routeRequest({ cls, anthropicProvider, hasSentinel, openaiCompatible }: RouteInput): Route {
  const openaiWire = isOpenAiWire(cls?.wire) ? cls.wire : undefined;
  const managed = openaiWire !== undefined && openaiCompatible && cls?.profile !== "implicit";
  return {
    rewrites: anthropicProvider || hasSentinel || managed,
    observedWire: observedWireFor(cls?.wire, anthropicProvider, openaiCompatible),
    profile: cls?.profile,
    managed,
    transformWire: openaiCompatible || hasSentinel ? openaiWire : undefined,
  };
}

/**
 * The profile a routed request is rewritten and kept warm through, or `undefined` to leave it alone.
 * An Anthropic-wire request, or one rewritten as an Anthropic body, uses `anthropic`. With the option
 * off an OpenAI-wire request is only reached through the sentinel, and keeps the Claude rewrite it had
 * before profiles existed, so an `openai` model never gets fields it was not opted into.
 */
export function profileForRoute(route: Route, openaiCompatible: boolean): CacheProfileId | undefined {
  if (!route.rewrites && route.observedWire === undefined) return undefined;
  if (route.transformWire === undefined || !openaiCompatible) return "anthropic";
  return route.profile ?? "anthropic";
}

/** True when breakpoints are injected into the request: a managed Claude-profile `openai-chat` primary or compaction request that is not a ping. */
export function shouldInject(route: Route, kind: RequestKind, isPing: boolean): boolean {
  return (
    route.managed &&
    route.profile === "anthropic" &&
    route.transformWire === "openai-chat" &&
    !isPing &&
    (kind === "primary" || kind === "compaction")
  );
}
