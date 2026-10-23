# Upgrading

## From 0.3.x

Nothing to migrate. Update the version range in your `plugins` entry to `^0.4.0`: on 0.x, `^0.3.0` does not pick up 0.4.

Support for OpenAI-compatible endpoints (OpenRouter, proxies) is on by default. Claude models on `…/chat/completions` now get the TTL rewrite, cache breakpoints and keepalive pings; other models there are only observed. To turn it off, set the `openaiCompatible` plugin option to `false`. See [SUPPORTED_PROVIDERS.md](SUPPORTED_PROVIDERS.md).

## From 0.1.x

Two changes break existing habits:

1. **`/cache-ttl` is now `/cache-manager`.** The palette entry is "Cache Manager" and the old command name is gone, with no alias.
2. **Typed commands change only the current session.** `/cache-ttl 1h` used to set the global mode; `/cache-manager 1h` sets the mode for the session you are in. To change the global default, use the picker's Global section.

A global mode stored by 0.1.x is kept and takes precedence over `defaultMode`, so editing `defaultMode` alone will not change it; set it from the picker's Global section instead. There is nothing else to migrate.
