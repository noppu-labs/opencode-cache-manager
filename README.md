# opencode-cache-manager

An [OpenCode](https://opencode.ai) plugin that controls the Anthropic prompt-cache TTL from inside the TUI: pick between the standard 5-minute cache, the 1-hour extended cache, or a hybrid of the two.

OpenCode marks cache breakpoints automatically (tools, system prompt, the last message) but always sends the default `ttl: "5m"`. There is no config knob for it. This plugin rewrites the outgoing request after OpenCode's own cache policy runs, so the TTL can be changed per session without forking the provider package.

## The three modes

| Mode | Tools + system | Messages | Write cost |
| --- | --- | --- | --- |
| `5m` (default) | 5m ephemeral | 5m ephemeral | 1.25x base input |
| `1h` | 1h ephemeral | 1h ephemeral | 2x base input |
| `hybrid` | 1h ephemeral | 5m ephemeral | mixed |

Reads cost about 0.1x base input in every mode. `hybrid` exists because Anthropic requires 1-hour breakpoints to come before any 5-minute ones in the request: putting the long TTL on the stable prefix (tools + system) and keeping the rolling message tail on 5m keeps the cheap write cost for the part of the context that changes every turn.

Requests in `1h` or `hybrid` mode also get the `anthropic-beta: extended-cache-ttl-2025-04-11` header merged in.

## Install

Copy (or symlink) the plugin directory into your OpenCode plugins folder:

```sh
git clone https://github.com/noppu-labs/opencode-cache-manager.git
ln -s "$(pwd)/opencode-cache-manager/plugins/anthropic-cache-ttl" \
  ~/.config/opencode/plugins/anthropic-cache-ttl
```

OpenCode discovers the plugin from `~/.config/opencode/plugins/`. It needs `@opencode/plugin` installed there (`bun add @opencode/plugin` in `~/.config/opencode/`).

The plugin rewrites requests for any Anthropic-compatible provider. `opencode.jsonc` at this repo's root is a sample with an `omniroute-anthropic` provider pointing at an Anthropic-compatible gateway.

## Usage

Run `/cache-ttl` in the TUI with no argument and a picker opens with the current mode highlighted:

```
/cache-ttl          -> picker modal (5m / 1h / hybrid)
/cache-ttl 1h       -> set 1h directly
/cache-ttl hybrid   -> set hybrid directly
/cache-ttl 5m       -> back to default
/cache-ttl status    -> toast with the current mode
```

The command also appears in the palette as "Anthropic Cache TTL". The chosen mode persists in plugin storage across restarts, and a second TUI instance sees the change through the `mode.updated` RPC event.

Explicit arguments work headless too (the server side registers the same command), with the reply posted as a synthetic message instead of a toast.

### Per-model override

Model variants can force a TTL regardless of the stored mode, via the `x-cache-ttl` sentinel header:

```jsonc
"variants": [
  { "id": "high",   "settings": { "reasoningEffort": "high" } },
  { "id": "high-1h", "settings": { "reasoningEffort": "high" }, "headers": { "x-cache-ttl": "1h" } }
]
```

The plugin reads the header before the request goes out, applies that TTL, and strips the header. The sample `opencode.jsonc` ships a full set of `-1h` variants for four Claude models.

## Development

```sh
bun install
bun test        # 67 tests
```

`tests/anthropic-cache-ttl.test.ts` covers the pure rewrite logic, the RPC handlers, the TUI command paths, and the sample config's `-1h` variants.

Layout:

```
plugins/anthropic-cache-ttl/
  index.ts    # server: command, http.request hook, RPC handlers, storage
  tui.ts      # TUI: palette + slash command, picker modal, toasts
  shared.ts    # pure logic, imported by both sides
  rpc.ts      # the RPC contract (getMode / setMode / mode.updated)
tests/
docs/         # the design notes from the original build
```

## License

None yet.