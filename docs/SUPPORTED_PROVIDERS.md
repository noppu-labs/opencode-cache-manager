# Supported providers and endpoints

## Endpoints

The plugin handles two wire formats: the Anthropic Messages API (`POST …/messages`) and OpenAI Chat Completions (`POST …/chat/completions`). On Chat Completions it also needs to know whether a model's cache is something it can manage:

| | Claude (explicit cache) | Everything else (implicit cache) |
| --- | --- | --- |
| TTL rewrite of existing `cache_control` | yes | no |
| Breakpoint injection when OpenCode sent none | yes (your prompts and compaction, not pings or titles) | no |
| `x-cache-ttl` sentinel header stripped | yes | yes |
| Cache usage observed (sidebar `cached` row) | yes | yes |
| Keepalive pings | yes | never |

Claude models cache only where a request marks a breakpoint. OpenCode's `openrouter` provider marks them for `anthropic/*` models, but its `openai-compatible` provider marks none, so the plugin adds the same three (the last tool, the system prompt, the last message) when the request has no `cache_control` at all. Other models, such as OpenAI's or DeepSeek's, cache on the provider's side with no breakpoints to rewrite. The plugin only reads the usage in their responses.

A model counts as Claude, in this order:

1. Your `explicitCacheModels` patterns (see [Settings](../README.md#settings)).
2. Its name: the OpenCode model ID or the `model` in the request body contains `claude`, or has an `anthropic/` prefix (as in `openrouter/anthropic/…`).
3. What the first response says it ran on: the response's `model` or `provider` field names Anthropic or Claude. This is how an alias such as `auto/opus-5` gets picked up. The result is remembered across restarts, so an alias is unmanaged for its first turn only.

Anything else is treated as implicit.

On the OpenAI wire, 1h and `hybrid` requests carry the same `anthropic-beta: extended-cache-ttl-2025-04-11` header as on the Anthropic wire. OpenRouter adds it itself, but some proxies need it before they honour the 1h TTL. The OpenAI usage format doesn't say which TTL the provider granted, so the sidebar shows `ttl 1h (requested)` there.

Example provider configs with `-1h` variants:

- [examples/opencode.anthropic.jsonc](examples/opencode.anthropic.jsonc): Claude through an Anthropic Messages endpoint
- [examples/opencode.openrouter.jsonc](examples/opencode.openrouter.jsonc): Claude and a non-Claude model through OpenCode's built-in `openrouter` provider
- [examples/opencode.openai-compatible.jsonc](examples/opencode.openai-compatible.jsonc): a generic OpenAI-compatible proxy

## How each provider caches

Providers change their caching often. This table reflects their documentation as of October 2026; check the sources below for the current rules.

| Provider | How it caches | Cache lifetime | Cache writes cost | This plugin |
| --- | --- | --- | --- | --- |
| Anthropic (Claude) | Explicit `cache_control` breakpoints (up to 4), or one top-level `cache_control` | 5m or 1h, chosen per breakpoint | 1.25x input (5m), 2x input (1h) | Managed: TTL, breakpoints, keepalive |
| OpenAI, GPT-5.6 and later | Automatic by default. Optional explicit `prompt_cache_breakpoint` on text blocks, and `prompt_cache_options: { mode, ttl }` on the request | At least 30m (default) or 12h | 1.25x input (30m), 2.5x input (12h), also when caching is automatic | Observed only |
| OpenAI, before GPT-5.6 | Automatic. `prompt_cache_key` helps route related requests to the same cache | `prompt_cache_retention`: `in_memory` (about 5 to 10 minutes idle, up to 1 hour) or `24h` | Free | Observed only |
| Alibaba (Qwen, and some DeepSeek models on OpenRouter) | Explicit `cache_control` breakpoints, same syntax as Anthropic | 5m | 1.25x input | Observed only. Can be opted in with `explicitCacheModels`, but the plugin then also applies Claude's TTL handling |
| Google Gemini 2.5 and later | Automatic. On OpenRouter, a `cache_control` breakpoint also works, and only the last one is used | Automatic: 3 to 5 minutes on average. Breakpoint: 5m, not extended by reads | Free (automatic). Input price plus 5 minutes of storage (breakpoint) | Observed only |
| DeepSeek | Automatic, on disk | Cleared when unused, usually within a few hours to a few days | Same as input | Observed only |
| Grok, Moonshot, Groq, Z.AI | Automatic | Not documented | Free | Observed only |

A few details that matter for long agent sessions:

- **OpenAI GPT-5.6 and later bill every cache write**, even with automatic caching. A one-off prompt of 1,024 tokens or more therefore costs more with caching on. Setting `prompt_cache_options.mode` to `"explicit"` with no breakpoints turns caching off for that request. OpenAI documents `prompt_cache_options.ttl` for its Responses API; OpenRouter documents it for Chat Completions too.
- **OpenRouter keeps a session on the same provider** (sticky routing) while caching pays off, for up to 10 idle minutes. It uses the `session_id` body field or `x-session-id` header as the key when present, which OpenCode sends.

### Sources

- [OpenRouter: Prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching) (all providers above, sticky routing, `session_id`)
- [Anthropic: Prompt caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)
- [OpenAI: Prompt caching](https://platform.openai.com/docs/guides/prompt-caching)
- [DeepSeek: Context caching](https://api-docs.deepseek.com/guides/kv_cache)
- [Google: Gemini context caching](https://ai.google.dev/gemini-api/docs/caching) and [implicit caching announcement](https://developers.googleblog.com/en/gemini-2-5-models-now-support-implicit-caching/)
- [Z.AI: Context caching](https://docs.z.ai/guides/capabilities/cache)
- [Groq: Prompt caching](https://console.groq.com/docs/prompt-caching)
