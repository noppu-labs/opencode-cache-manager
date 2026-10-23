# Upgrading

## From 0.4.x

Update the version range in your `plugins` entry to `^0.5.0`: on 0.x, `^0.4.0` does not pick up 0.5.

0.5.0 adds OpenAI GPT-5.6 and later as a managed provider, on Chat Completions and on the Responses API (OpenCode's native `openai` provider). The session's TTL mode now applies to them: `5m` leaves OpenAI's automatic 30-minute cache alone, `1h` and `hybrid` add a 12-hour breakpoint, one-off calls (titles and other one-off generate calls) stop writing to the cache, and keepalive pings on the 25-minute or 10-hour schedule. See [SUPPORTED_PROVIDERS.md](SUPPORTED_PROVIDERS.md).

**`explicitCacheModels` is replaced by `cacheProfiles`.** The old option is ignored. It was a list of patterns where a leading `!` meant "never manage"; the new one maps each pattern to a profile (`"anthropic"`, `"openai"` or `"implicit"`):

```jsonc
// 0.4.x
"explicitCacheModels": ["opus", "!gpt"]

// 0.5.x
"cacheProfiles": { "opus": "anthropic", "gpt": "implicit" }
```

`"!pattern"` becomes `"pattern": "implicit"`, and a plain pattern becomes `"pattern": "anthropic"`. Use `"openai"` to manage a model as GPT-5.6+ when its ID doesn't show the version. Learned classifications saved by 0.4 (stored as `explicit`) are read as `anthropic`.

Behaviour you may notice:

- **Sidebar.** OpenAI sessions show `ttl 30m (requested)` or `ttl 12h (requested)`: OpenAI's usage doesn't report the lifetime it granted.
- **A `-1h` variant on an `implicit` model** (for example a `"gpt": "implicit"` mapping, or a model the plugin doesn't manage) has its `x-cache-ttl` header stripped and nothing else changed.
- **Claude through a `…/responses` endpoint** now gets ping alignment like on the other wires. With the `openaiCompatible` option off, a `…/responses` request only has the `x-cache-ttl` header stripped; before, it went through the Anthropic rewrite.
- **A non-Claude model behind an Anthropic-ID provider** on an OpenAI wire now follows its own profile instead of being rewritten as Claude.
- **OmniRoute** drops `prompt_cache_breakpoint`, so GPT's 12-hour cache is not expected to reach OpenAI through it yet (not yet reported upstream; expected, not measured). Caching turned off for one-off calls does work. Pings on the 12-hour schedule are then expected to miss, so use `5m` for GPT sessions there.
- **Older GPT models** (before 5.6) are never sent the new fields, since they answer 400.

## From 0.3.x

Nothing to migrate. Update the version range in your `plugins` entry to `^0.5.0`: on 0.x, `^0.3.0` does not pick up 0.4 or 0.5.

Support for OpenAI-compatible endpoints (OpenRouter, proxies) is on by default. Claude models on `…/chat/completions` now get the TTL rewrite, cache breakpoints and keepalive pings; other models there are only observed. To turn it off, set the `openaiCompatible` plugin option to `false`. See [SUPPORTED_PROVIDERS.md](SUPPORTED_PROVIDERS.md).

## From 0.1.x

Two changes break existing habits:

1. **`/cache-ttl` is now `/cache-manager`.** The palette entry is "Cache Manager" and the old command name is gone, with no alias.
2. **Typed commands change only the current session.** `/cache-ttl 1h` used to set the global mode; `/cache-manager 1h` sets the mode for the session you are in. To change the global default, use the picker's Global section.

A global mode stored by 0.1.x is kept and takes precedence over `defaultMode`, so editing `defaultMode` alone will not change it; set it from the picker's Global section instead. There is nothing else to migrate.
