# Supported providers and endpoints

## Endpoints

The plugin handles three wire formats: the Anthropic Messages API (`POST …/messages`), OpenAI Chat Completions (`POST …/chat/completions`) and the OpenAI Responses API (`POST …/responses`, used by OpenCode's native `openai` provider). On the two OpenAI wires it also needs to know which cache profile a model belongs to:

| | Claude (`anthropic`) | GPT-5.6+ (`openai`) | Everything else (`implicit`) |
| --- | --- | --- | --- |
| Cache control it rewrites | `cache_control` breakpoints | `prompt_cache_breakpoint` on text parts | none |
| TTL by mode | 5m / 1h / hybrid | 30m (automatic) / 12h / 12h at the end of the system prompt | none |
| Breakpoint injection when OpenCode sent none | yes (your prompts and compaction, not pings or titles) | only the 12h breakpoint for `1h` / `hybrid` | no |
| One-off calls (titles, summaries) | unchanged | sent with `prompt_cache_options: { mode: "explicit" }` and no breakpoints, so they write nothing to the cache | unchanged |
| `x-cache-ttl` sentinel header stripped | yes | yes | yes |
| Cache usage observed (sidebar `cached` row) | yes | yes | yes |
| Keepalive pings | yes (5m, 1h) | yes (30m, 12h) | never |

Claude models cache only where a request marks a breakpoint. OpenCode's `openrouter` provider marks them for `anthropic/*` models, but its `openai-compatible` provider marks none, so the plugin adds the same three (the last tool, the system prompt, the last message) when the request has no `cache_control` at all. Other models, such as DeepSeek's, cache on the provider's side with no breakpoints to rewrite. The plugin only reads the usage in their responses.

### What the plugin sends to GPT-5.6+

| Mode | Chat Completions | Responses |
| --- | --- | --- |
| `5m` | nothing (automatic 30m cache) | nothing (automatic 30m cache) |
| `1h` | `prompt_cache_breakpoint: { mode: "explicit", ttl: "12h" }` on the last text part of the last user, system or tool message | the same breakpoint on the last `input_text` part of `input` |
| `hybrid` | the 12h breakpoint on the last text part of the leading system messages; the tail keeps the automatic 30m cache | the same breakpoint on the first `input` item |
| title, summary and other one-off calls | `prompt_cache_options: { mode: "explicit" }`, no breakpoints | the same |

The plugin never sends a request-level `prompt_cache_options.ttl`. It is ignored on Chat Completions and OpenRouter rejects it with a 400 on Responses unless `mode` is `"explicit"`, and explicit mode on a normal turn would disable the automatic cache for the message tail. The 12h lifetime is always a `ttl` on the breakpoint itself. Pings are never changed beyond aligning their messages with the session's last request.

OpenAI's usage reports how many tokens were read and written but not the lifetime, so the sidebar shows `ttl 30m (requested)` or `ttl 12h (requested)`.

Models before GPT-5.6 (`gpt-5`, `gpt-4.1`, …) answer 400 to `prompt_cache_options` and `prompt_cache_breakpoint`, so the plugin never sends them. A model counts as GPT-5.6+ only when its name matches (`gpt-5.6` and up, `gpt-6` and up) or when you map it yourself with `"openai"` in `cacheProfiles`.

A model counts as Claude or GPT-5.6+, in this order:

1. Your `cacheProfiles` patterns (see [Settings](../README.md#settings)): `"anthropic"`, `"openai"` or `"implicit"`.
2. Its name: the OpenCode model ID or the `model` in the request body contains `claude`, or has an `anthropic/` prefix (as in `openrouter/anthropic/…`) for Claude; matches the GPT-5.6+ pattern above for OpenAI.
3. What the first response says it ran on: the response's `model` or `provider` field names Anthropic or Claude, or its `model` is a GPT-5.6+ name. This is how an alias such as `auto/opus-5` gets picked up. The result is remembered across restarts, so an alias is unmanaged for its first turn only.

Anything else is treated as implicit. A `-1h` variant on an implicit model has its `x-cache-ttl` header stripped and nothing else changed.

On the OpenAI wires, Claude requests in `1h` and `hybrid` carry the same `anthropic-beta: extended-cache-ttl-2025-04-11` header as on the Anthropic wire. OpenRouter adds it itself, but some proxies need it before they honour the 1h TTL. GPT requests never get that header. The OpenAI usage format doesn't say which TTL the provider granted, so the sidebar shows `ttl 1h (requested)` for Claude there, and `30m` or `12h` for GPT.

### OmniRoute and other proxies

OmniRoute forwards `prompt_cache_options` but currently drops `prompt_cache_breakpoint`. Through it, caching turned off on one-off calls works, while the 12h lifetime (`1h` and `hybrid` modes) does not reach OpenAI yet: the request is billed as the automatic 30m cache. A fix is planned upstream; until then, reach GPT-5.6+ through OpenRouter or OpenAI directly if you want 12h. Keepalive still pings on the 12h schedule, so on OmniRoute those pings arrive after the 30m cache is gone and do not hit. Use `5m` for GPT sessions on such a proxy.

Example provider configs with `-1h` variants:

- [examples/opencode.anthropic.jsonc](examples/opencode.anthropic.jsonc): Claude through an Anthropic Messages endpoint
- [examples/opencode.openrouter.jsonc](examples/opencode.openrouter.jsonc): Claude and a non-Claude model through OpenCode's built-in `openrouter` provider
- [examples/opencode.openai-compatible.jsonc](examples/opencode.openai-compatible.jsonc): a generic OpenAI-compatible proxy
- [examples/opencode.openai.jsonc](examples/opencode.openai.jsonc): GPT-5.6+ through OpenCode's native `openai` provider (Responses)

## How each provider caches

Providers change their caching often. This table reflects their documentation as of October 2026; check the sources below for the current rules.

| Provider | How it caches | Cache lifetime | Cache writes cost | This plugin |
| --- | --- | --- | --- | --- |
| Anthropic (Claude) | Explicit `cache_control` breakpoints (up to 4), or one top-level `cache_control` | 5m or 1h, chosen per breakpoint | 1.25x input (5m), 2x input (1h) | Managed: TTL, breakpoints, keepalive |
| OpenAI, GPT-5.6 and later | Automatic by default. Optional explicit `prompt_cache_breakpoint` on text blocks (with its own `ttl`), and `prompt_cache_options: { mode }` on the request | At least 30m (default) or 12h | 1.25x input (30m), 2.5x input (12h), also when caching is automatic | Managed: 12h breakpoints, caching off for one-off calls, keepalive |
| OpenAI, before GPT-5.6 | Automatic. `prompt_cache_key` helps route related requests to the same cache | `prompt_cache_retention`: `in_memory` (about 5 to 10 minutes idle, up to 1 hour) or `24h` | Free | Observed only |
| Alibaba (Qwen, and some DeepSeek models on OpenRouter) | Explicit `cache_control` breakpoints, same syntax as Anthropic | 5m | 1.25x input | Observed only. Can be opted in with `cacheProfiles` (`"anthropic"`), but the plugin then also applies Claude's TTL handling |
| Google Gemini 2.5 and later | Automatic. On OpenRouter, a `cache_control` breakpoint also works, and only the last one is used | Automatic: 3 to 5 minutes on average. Breakpoint: 5m, not extended by reads | Free (automatic). Input price plus 5 minutes of storage (breakpoint) | Observed only |
| DeepSeek | Automatic, on disk | Cleared when unused, usually within a few hours to a few days | Same as input | Observed only |
| Grok, Moonshot, Groq, Z.AI | Automatic | Not documented | Free | Observed only |

A few details that matter for long agent sessions:

- **OpenAI GPT-5.6 and later bill every cache write**, even with automatic caching. A one-off prompt of 1,024 tokens or more therefore costs more with caching on. Setting `prompt_cache_options.mode` to `"explicit"` with no breakpoints turns caching off for that request. A request-level `prompt_cache_options.ttl` is ignored on Chat Completions and rejected on Responses through OpenRouter (it requires `mode: "explicit"`, which turns off the automatic cache for the tail); the 12h lifetime works through a `ttl` on `prompt_cache_breakpoint`, which is what the plugin sends. Before GPT-5.6 the fields answer 400.
- **OpenRouter keeps a session on the same provider** (sticky routing) while caching pays off, for up to 10 idle minutes. It uses the `session_id` body field or `x-session-id` header as the key when present, which OpenCode sends.

### Sources

- [OpenRouter: Prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching) (all providers above, sticky routing, `session_id`)
- [Anthropic: Prompt caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)
- [OpenAI: Prompt caching](https://platform.openai.com/docs/guides/prompt-caching)
- [DeepSeek: Context caching](https://api-docs.deepseek.com/guides/kv_cache)
- [Google: Gemini context caching](https://ai.google.dev/gemini-api/docs/caching) and [implicit caching announcement](https://developers.googleblog.com/en/gemini-2-5-models-now-support-implicit-caching/)
- [Z.AI: Context caching](https://docs.z.ai/guides/capabilities/cache)
- [Groq: Prompt caching](https://console.groq.com/docs/prompt-caching)
