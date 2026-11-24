# Architecture

opencode-cache-manager is an OpenCode V2 plugin. It has no process of its own and opens no listening socket: OpenCode loads its two entry points, calls its hooks, and sends every model request itself. This page describes who takes part (the actors), what each part does (the actions), and every interface the released package exposes. [SECURITY_ASSESSMENT.md](SECURITY_ASSESSMENT.md) covers what can go wrong.

The file-by-file layout is in [CONTRIBUTING.md](CONTRIBUTING.md#layout).

## Actors

| Actor                   | What it is                                                                                                                                        | What it can do to the others                                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User                    | The person running OpenCode                                                                                                                       | Sets plugin options in `opencode.jsonc`, runs `/cache-manager`, uses the picker, puts the `x-cache-ttl` header on a model variant                                      |
| OpenCode host           | The OpenCode process                                                                                                                              | Loads the plugin, calls its hooks for each model request and response, sends the requests, provides sessions, storage, the model catalog, commands and the RPC channel |
| Server part             | `src/server.ts` and what it wires: the two HTTP hooks, the keepalive engine, the stores, the savings ledger, the server command, the RPC handlers | Rewrites outgoing model requests, reads their responses, asks the host to send keepalive pings, reads and writes plugin storage                                        |
| TUI part                | `src/tui.ts` and `src/ui/`: the slash command, the picker, the sidebar                                                                            | Calls the server part over RPC; reads the host's session data for the sidebar                                                                                          |
| Model provider or proxy | Anthropic, OpenAI, OpenRouter, or a proxy such as OmniRoute                                                                                       | Receives the requests the host sends; its responses are input to the plugin's parsers                                                                                  |
| Plugin storage          | The key-value store OpenCode gives the plugin, shared by every OpenCode process on the machine                                                    | Holds settings, learned model profiles, keepalive records, ledger totals and the cached price list                                                                     |
| models.dev              | A public price list, used only when `modelsDevPrices` is on                                                                                       | Supplies model prices for the sidebar's dollar figures                                                                                                                 |
| Other plugins           | Anything else hooked into the same requests                                                                                                       | Can rewrite the same request before or after this plugin does                                                                                                          |
| Debug log file          | A local JSONL file, written only when `debug` is on                                                                                               | Receives a trace of what the plugin did                                                                                                                                |

## Actions

### Rewriting a request

OpenCode calls the `http.request` hook (`src/middleware/request.ts`) before it sends a model request. The hook:

1. Classifies the request. The wire comes from the URL path (`/messages`, `/chat/completions`, `/responses`). The cache profile (`anthropic`, `openai` or `implicit`) comes from the provider ID, the model name, the `cacheProfiles` option, or what an earlier response reported (`src/services/classify.ts`). A request no profile applies to is left untouched.
2. Resolves the TTL mode: the session's setting, then the stored global one, then the plugin option, then the default. An `x-cache-ttl` header on the request wins over all of them.
3. For a keepalive ping, replaces the ping's messages with those of the session's last real request, so the ping reads the same cached prefix (`src/services/ping-alignment.ts`). Those messages are held in memory only.
4. Lets the profile rewrite the JSON body for the mode: TTLs on `cache_control` blocks, breakpoints where the profile adds them, and the `anthropic-beta` header for 1h (`src/services/cache-ttl.ts`, `src/services/profiles/`). The `x-cache-ttl` header is removed.
5. Tells the keepalive engine a request went out.

The request keeps its URL and method. The only header changes are the merged `anthropic-beta` value, the removed `x-cache-ttl`, and `content-length`, which is dropped when a ping's body is replaced so that it is recomputed. If the rewrite throws, the request goes out as OpenCode built it and a warning is written to the console.

### Reading a response

OpenCode calls the `http.response` hook (`src/middleware/response.ts`) with the response. The hook tees the body (`src/services/response-observer.ts`): OpenCode receives the response unchanged, and the plugin reads its own copy in the background. From that copy it parses token usage, the stop reason and the model the response names, with one parser set per wire (`src/services/usage*.ts`). It then:

- records which profile the named model belongs to, so the next request to that model is classified by it (`src/services/profile-store.ts`);
- drops a learned profile when a non-Anthropic provider answers a Messages request with 400 or 422;
- reports the usage to the keepalive engine.

A failure anywhere in this path is swallowed. The response OpenCode sees is never altered.

### Keeping a cache warm

The keepalive engine (`src/services/keepalive-engine.ts`) keeps one schedule per session. After a request whose response showed cache activity, it sets a timer for shortly before the cache expires. When the timer fires, it asks the host for a transient generation on that session with a fixed prompt (`ctx.session.generate`); the host builds and sends that request, so it passes through both hooks like any other. A ping that reads at least 90% of the context from cache is a hit and the next ping is scheduled; anything less stops keepalive for the session until its next real request.

The engine never pings a child session, a session below `minContextTokens`, a session waiting on a tool call, or a session that has used `maxPings` pings since its last real request. [The README](../README.md#keepalive) has the full rules.

Each armed session has a record in plugin storage, so a schedule survives a plugin reload or a restart (`src/services/keepalive-store.ts`). A record names the process and directory that wrote it, and only that owner, or its directory's next process once the owner has exited, resumes it. Two OpenCode processes therefore never ping the same session.

### Changing settings

Settings are layered: built-in defaults, plugin options, a stored global value, a stored per-session value (`src/services/settings-store.ts`). They change in two ways:

- `/cache-manager` with a typed argument. The TUI registers the slash command and sends the change over RPC. The server part registers the same command, so typed arguments also work headless (`src/controllers/command.ts`).
- The picker, which `/cache-manager` opens when it has no argument. It calls `setSession`, `setGlobal` or `resetSession` over RPC.

Every change is validated, stored, applied to the keepalive schedule and announced with a `settings.updated` event.

### Showing the sidebar

The TUI subscribes to `keepalive.updated` events and also fetches snapshots with `getKeepalive` (`src/ui/snapshot-feed.ts`), then formats them (`src/ui/sidebar-lines.ts`). A Claude Agent session never reaches the HTTP hooks, so for those the sidebar reads token counts from the host's own session data (`src/ui/claude-agent.ts`).

### Counting savings

The engine tells the savings ledger about each ping and each idle stretch a ping rescued (`src/services/savings-ledger.ts`). The ledger prices them from OpenCode's model catalog (`src/services/model-prices.ts`) and stores totals per session. With `modelsDevPrices` on, a model the catalog has no price for is looked up in a copy of the models.dev list, fetched at most once a day (`src/services/models-dev.ts`). This is the only network request the plugin makes itself.

### Starting and stopping

At setup the server part loads settings and learned profiles, registers the RPC handlers, the command and the two hooks, removes stored entries of sessions that were deleted while it was not running, and resumes the keepalive records it owns. On disposal it cancels every timer and drops the in-memory messages.

## External interfaces

These are all the ways anything outside the plugin interacts with the released package.

### Package entry points

| Export             | Resolves to     | What it is                                                                                                                       |
| ------------------ | --------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `.` and `./server` | `src/server.ts` | The server plugin, a `Plugin.define` default export OpenCode loads                                                               |
| `./tui`            | `src/tui.ts`    | The TUI plugin, a `Plugin.define` default export OpenCode loads                                                                  |
| `./rpc`            | `src/rpc.ts`    | The RPC contract `CacheTtlRpc` and the client types `CacheTtlRpcClient`, `RawCacheTtlRpcClient`, `RpcCallOptions`, `RpcLocation` |
| `./package.json`   | `package.json`  | The manifest                                                                                                                     |

### Plugin options

Read once at startup from the plugin's entry in `opencode.jsonc`: `defaultMode`, `keepalive.enabled`, `keepalive.maxPings`, `keepalive.minContextTokens`, `savings`, `modelsDevPrices`, `openaiCompatible`, `cacheProfiles`, `debug`. [The README](../README.md#settings) documents each one. An invalid value is ignored and the default applies.

### The `/cache-manager` command

Input is the argument text: nothing, `5m`, `1h`, `hybrid`, `keepalive on|off`, `pings <0-100>`, `min <tokens>` (`50000` or `50k`), `savings on|off`, `status`, `reset`. With no argument the TUI opens the picker; the server-side command, which is the one that runs headless, toggles the session between `5m` and `1h`. Output is a toast in the TUI and a synthetic message in the session when headless. An argument that doesn't parse changes nothing and prints the list of valid ones. See [Usage](../README.md#usage).

### The `x-cache-ttl` request header

A model variant can carry `x-cache-ttl` with a TTL mode. The plugin reads it, applies that mode to the request it is on, and removes it before the request leaves. See [Per-model override](../README.md#per-model-override).

### RPC

The contract ID is `opencode-cache-manager`. Inputs and outputs are validated by OpenCode against the JSON schemas in `src/rpc.ts`.

| Method         | Input                  | Output                                                                             |
| -------------- | ---------------------- | ---------------------------------------------------------------------------------- |
| `getSettings`  | `{ sessionID? }`       | `{ global, session }`: the effective global settings and the session's overrides   |
| `setGlobal`    | `{ patch }`            | `{}`                                                                               |
| `setSession`   | `{ sessionID, patch }` | `{}`                                                                               |
| `resetSession` | `{ sessionID }`        | `{}`                                                                               |
| `getKeepalive` | `{ sessionID }`        | A keepalive snapshot: TTL, expiry, next ping, pings used, last cache read, savings |

A `patch` may hold `mode` (`5m`, `1h`, `hybrid`), `keepalive`, `maxPings` (0 to 100), `minContextTokens` and `savings`. A patch with any other field is rejected.

| Event               | Payload                                                     |
| ------------------- | ----------------------------------------------------------- |
| `settings.updated`  | `{ sessionID }`, `null` for a global change                 |
| `keepalive.updated` | A keepalive snapshot, the same shape `getKeepalive` returns |

### Requests to model providers

The plugin sends nothing to a provider itself. It changes requests OpenCode is about to send, and only for a model a profile manages: `cache_control` TTLs and breakpoints and the `anthropic-beta` header for Claude, `prompt_cache_breakpoint` and `prompt_cache_options` for GPT-5.6+. [SUPPORTED_PROVIDERS.md](SUPPORTED_PROVIDERS.md) lists what is sent on each endpoint. A keepalive ping is a request OpenCode builds from the session's context and the prompt `Do not perform any work and do not use tools. Reply with exactly: OK`.

From a response it reads the usage block, the stop or finish reason, and the model and provider names. It writes nothing back into the response.

### Plugin storage

| Key                     | Value                                                                  |
| ----------------------- | ---------------------------------------------------------------------- |
| `global`                | The stored global settings                                             |
| `session/<sessionID>`   | A session's setting overrides                                          |
| `learned-models`        | A map from `<providerID>/<modelID>` to the profile a response revealed |
| `keepalive/<sessionID>` | An armed session's schedule: TTL, last request time, pings used, owner |
| `ledger/<sessionID>`    | A session's savings totals                                             |
| `models-dev`            | The cached price list, when `modelsDevPrices` is on                    |

`mode` is a legacy key that is still read. Every value is validated when it is read, and a malformed one is ignored or removed. No prompt or response content is stored.

### models.dev

With `modelsDevPrices` on, one `GET https://models.dev/api.json` at most once a day, with a 10 second timeout. The request carries no data about the user. Only prices are kept from the response.

### The debug log

With `debug` on, the plugin appends one JSON object per line to a local file created with mode `0600`. [CONTRIBUTING.md](CONTRIBUTING.md#debug-log) says what it holds.

### Console

One warning line, `[opencode-cache-manager] cache rewrite failed, request sent unchanged:`, when a rewrite throws.
