import type { CacheTtlMode, Ttl } from '../models/cache.ts';

/** Path suffix of an OpenAI Chat Completions request. */
const CHAT_COMPLETIONS_SUFFIX = '/chat/completions';

/** Path suffix of an OpenAI Responses request. */
const RESPONSES_SUFFIX = '/responses';

/** Model IDs that accept `prompt_cache_breakpoint`: GPT-5.6 and later (never the `gpt-35` Azure name). Older `gpt-*` models answer 400. */
const OPENAI_CACHE_MODEL = /(^|\/)gpt-(5\.(?:[6-9]|\d{2,})|[6-9]|[1-9]\d(?<!35))(?!\d)/iu;

/** The TTL keepalive tracks per setting: 12h for `1h`; `hybrid` follows its automatic 30m tail, like Claude follows its 5m tail. */
const OPENAI_TTL_FOR_MODE: Record<CacheTtlMode, Ttl> = {
  '1h': '12h',
  '5m': '30m',
  'hybrid': '30m',
};

/** Model IDs treated as Claude-family: `anthropic/…`, `~anthropic/…` or any `claude` name. */
const CLAUDE_MODEL = /(^|\/)~?anthropic\/|claude/iu;

/** Resolved upstream `provider` values that identify Anthropic. */
const ANTHROPIC_UPSTREAM = /anthropic|claude/iu;

/** Chat Completions `finish_reason` values renamed to their Messages `stop_reason` equivalent. */
const FINISH_REASON_MAP: Readonly<Record<string, string>> = { tool_calls: 'tool_use' };

export {
  CHAT_COMPLETIONS_SUFFIX,
  RESPONSES_SUFFIX,
  OPENAI_CACHE_MODEL,
  OPENAI_TTL_FOR_MODE,
  CLAUDE_MODEL,
  ANTHROPIC_UPSTREAM,
  FINISH_REASON_MAP,
};
