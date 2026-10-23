import { OPENAI_TTL_FOR_MODE } from "../../constants/openai.ts";
import type { CacheProfile, RewriteContext } from "../../models/profile.ts";
import { isRecord } from "../../utils/is-record.ts";
import { lastTextPart, leadingPrefixEnd } from "../openai-cache-ttl.ts";
import { firstInputItem, lastInputText, lastInputTextPart, stripBreakpoints } from "../openai-responses-cache.ts";

type Rec = Record<string, unknown>;

const LONG_BREAKPOINT = { mode: "explicit", ttl: "12h" } as const;

/** The last text part of the last chat message that has one. */
function lastChatText(body: Rec): Rec | undefined {
  if (!Array.isArray(body.messages)) return undefined;
  for (let index = body.messages.length - 1; index >= 0; index--) {
    const message: unknown = body.messages[index];
    const part = isRecord(message) ? lastTextPart(message) : undefined;
    if (part) return part;
  }
  return undefined;
}

/** The last text part of the leading `system`/`developer` messages. */
function lastChatPrefixText(body: Rec): Rec | undefined {
  if (!Array.isArray(body.messages)) return undefined;
  for (let index = leadingPrefixEnd(body.messages) - 1; index >= 0; index--) {
    const message: unknown = body.messages[index];
    const part = isRecord(message) ? lastTextPart(message) : undefined;
    if (part) return part;
  }
  return undefined;
}

/** Where the 12h breakpoint goes for this mode and wire; `undefined` for the automatic 30m. */
function breakpointTarget(body: Rec, { wire, mode }: RewriteContext): Rec | undefined {
  if (mode === "5m") return undefined;
  if (wire === "openai-chat") return mode === "1h" ? lastChatText(body) : lastChatPrefixText(body);
  if (wire !== "openai-responses") return undefined;
  if (mode === "1h") return lastInputText(body);
  const first = firstInputItem(body);
  return first ? lastInputTextPart(first) : undefined;
}

const hasLongBreakpoint = (part: Rec): boolean => {
  const current = part.prompt_cache_breakpoint;
  return isRecord(current) && current.mode === LONG_BREAKPOINT.mode && current.ttl === LONG_BREAKPOINT.ttl;
};

/** One-off calls (title, generate) cache nothing: explicit mode with no breakpoint. */
function disableCaching(body: Rec): boolean {
  const stripped = stripBreakpoints(body);
  const options = body.prompt_cache_options;
  const set = !(isRecord(options) && options.mode === "explicit" && Object.keys(options).length === 1);
  if (set) body.prompt_cache_options = { mode: "explicit" };
  return stripped || set;
}

/** OpenAI GPT-5.6+ caching: automatic 30m, or a per-breakpoint 12h `prompt_cache_breakpoint`. */
export const openaiProfile: CacheProfile = {
  id: "openai",
  wires: ["openai-chat", "openai-responses"],
  ttlForMode: (mode) => OPENAI_TTL_FOR_MODE[mode],
  rewrite(body, ctx) {
    if (ctx.isPing || (ctx.wire !== "openai-chat" && ctx.wire !== "openai-responses")) return false;
    if (ctx.kind === "title" || ctx.kind === "generate") return disableCaching(body);

    const target = breakpointTarget(body, ctx);
    const stripped = stripBreakpoints(body, target);
    if (!target || hasLongBreakpoint(target)) return stripped;
    target.prompt_cache_breakpoint = { ...LONG_BREAKPOINT };
    return true;
  },
  pings: true,
};
