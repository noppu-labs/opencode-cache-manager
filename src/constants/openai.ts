/** Path suffix of an OpenAI Chat Completions request. */
export const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";

/** Model IDs treated as Claude-family (explicit cache control): `anthropic/…`, `~anthropic/…` or any `claude` name. */
export const EXPLICIT_CACHE_MODEL = /(^|\/)~?anthropic\/|claude/i;

/** Resolved upstream `provider` values that identify Anthropic. */
export const ANTHROPIC_UPSTREAM = /anthropic|claude/i;
