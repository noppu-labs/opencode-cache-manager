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
import { profileFor } from "./profiles/index.ts";
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
 * Precedence on the Messages wire: an Anthropic provider ID, user patterns, built-in Claude regex, learned, implicit.
 * Precedence on the OpenAI wires: user patterns, built-in Claude regex, built-in OpenAI regex, learned, implicit.
 * A learned `openai` only counts when the request's own model matches the OpenAI regex: a router alias can
 * send its next turn to a model that answers `prompt_cache_*` with a 400.
 */
export function classifyRequest(
  request: Request,
  ref: ModelRef,
  deps: ClassifyDeps,
  bodyModel?: string,
): Classification | undefined {
  const wire = requestWire(request);
  if (wire === undefined) return undefined;
  if (wire === "anthropic-messages" && isAnthropicProvider(ref.providerID)) return { wire, profile: "anthropic" };

  const matches = (regex: RegExp) => regex.test(ref.id) || (bodyModel !== undefined && regex.test(bodyModel));
  const profile =
    matchProfilePatterns(deps.patterns, ref) ??
    (matches(CLAUDE_MODEL) ? "anthropic" : undefined) ??
    (wire !== "anthropic-messages" && matches(OPENAI_CACHE_MODEL) ? "openai" : undefined) ??
    learnedProfile(deps, ref, matches) ??
    "implicit";
  return { wire, profile };
}

function learnedProfile(
  deps: ClassifyDeps,
  ref: ModelRef,
  matches: (regex: RegExp) => boolean,
): CacheProfileId | undefined {
  const learned = deps.learned?.(ref);
  return learned === "openai" && !matches(OPENAI_CACHE_MODEL) ? undefined : learned;
}

/**
 * `classifyRequest` plus `body.model` as a second look: OpenCode's model ID is its own key, while the
 * body carries the upstream ID. The body is read from a clone, and only when the first pass is
 * `implicit` on the Messages wire, or on an OpenAI wire with `openaiWires`, and no user pattern
 * matched, so a pattern, an Anthropic provider ID, a Claude or GPT ID or a learned `anthropic` never
 * costs a parse.
 */
export async function classifyRequestWithBody(
  request: Request,
  ref: ModelRef,
  deps: ClassifyDeps,
  opts: { openaiWires: boolean },
): Promise<Classification | undefined> {
  const first = classifyRequest(request, ref, deps);
  if (first?.profile !== "implicit") return first;
  if (first.wire !== "anthropic-messages" && !(opts.openaiWires && isOpenAiWire(first.wire))) return first;
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
  /** The wire the request classified to, or `undefined` when it is not a known wire. */
  wire: Wire | undefined;
  /** The wire whose response and usage are observed; `undefined` leaves the request and response alone. */
  observedWire: Wire | undefined;
  /** The profile the request classified to, or `undefined` when it is not a known wire. */
  profile: CacheProfileId | undefined;
  /** A Claude Messages-wire request, or an OpenAI-wire one whose profile is not `implicit` (only with the option on). */
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
  const managed =
    (openaiWire !== undefined && openaiCompatible && cls?.profile !== "implicit") ||
    (cls?.wire === "anthropic-messages" && cls.profile === "anthropic");
  return {
    rewrites: anthropicProvider || hasSentinel || managed,
    wire: cls?.wire,
    observedWire: observedWireFor(cls?.wire, anthropicProvider, openaiCompatible),
    profile: cls?.profile,
    managed,
    transformWire: openaiCompatible || hasSentinel ? openaiWire : undefined,
  };
}

/**
 * The profile a routed request is rewritten and kept warm through, or `undefined` to leave it alone.
 * A Messages-wire request uses its classified profile when that profile lists the wire, else `implicit`.
 * Any other request rewritten as an Anthropic body uses `anthropic`. With the option
 * off an OpenAI-wire request is only reached through the sentinel, and keeps the Claude rewrite it had
 * before profiles existed, so an `openai` model never gets fields it was not opted into. A profile that
 * cannot handle the request's wire (Claude on `/responses`) falls back to `implicit`: observed only.
 */
export function profileForRoute(route: Route, openaiCompatible: boolean): CacheProfileId | undefined {
  if (!route.rewrites && route.observedWire === undefined) return undefined;
  if (route.wire === "anthropic-messages") {
    const id = route.profile ?? "implicit";
    return profileFor(id).wires.includes(route.wire) ? id : "implicit";
  }
  const wire = route.transformWire;
  if (wire === undefined) return "anthropic";
  const id = openaiCompatible ? (route.profile ?? "anthropic") : "anthropic";
  return profileFor(id).wires.includes(wire) ? id : "implicit";
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
