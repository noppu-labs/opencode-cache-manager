import type { CacheTtlMode, Ttl } from "../models/cache.ts";

/** Path suffix of an OpenAI Chat Completions request. */
export const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";

/** Path suffix of an OpenAI Responses request. */
export const RESPONSES_SUFFIX = "/responses";

/** Model IDs that accept `prompt_cache_breakpoint`: GPT-5.6 and later. Older `gpt-*` models answer 400. */
export const OPENAI_CACHE_MODEL = /(^|\/)gpt-(5\.([6-9]|\d{2,})|[6-9]|\d{2,})/i;

/** The OpenAI cache TTL each setting asks for: the automatic 30m by default, 12h for `1h` / `hybrid`. */
export const OPENAI_TTL_FOR_MODE: Record<CacheTtlMode, Ttl> = { "5m": "30m", "1h": "12h", hybrid: "12h" };

/** Model IDs treated as Claude-family (explicit cache control): `anthropic/…`, `~anthropic/…` or any `claude` name. */
export const EXPLICIT_CACHE_MODEL = /(^|\/)~?anthropic\/|claude/i;

/** Resolved upstream `provider` values that identify Anthropic. */
export const ANTHROPIC_UPSTREAM = /anthropic|claude/i;

/** Chat Completions `finish_reason` values renamed to their Messages `stop_reason` equivalent. */
export const FINISH_REASON_MAP: Readonly<Record<string, string>> = { tool_calls: "tool_use" };
