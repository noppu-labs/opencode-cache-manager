# opencode-cache-manager

OpenCode V2 plugin that manages the Anthropic prompt cache: it rewrites outgoing requests to control the TTL (`5m` default, `1h`, or `hybrid` with 1h on tools + system and 5m on messages), per session, and keeps idle sessions' caches warm with hidden keepalive pings. It works on the Anthropic Messages wire and on OpenAI-compatible endpoints (`POST …/chat/completions`: OpenRouter, proxies such as OmniRoute): Claude models there get the same management, and every other model is only observed (sidebar `cached` row, never pinged). Published to npm as both `@noppu-labs/opencode-cache-manager` and `opencode-cache-manager`.

## Commands

```sh
bun install
bun test             # all tests in tests/
bun run typecheck    # tsc -p . (noEmit, strict), covers src/, tests/ and scripts/ with Bun types
bun run build        # compiles src/ui/sidebar.tsx to src/ui/sidebar.compiled.js (also runs on prepack)
```

Runtime is Bun (>= 1.3). The `.ts` sources ship as-is and OpenCode loads them directly, with one exception: OpenCode only runs the Solid JSX transform on files outside `node_modules`, so `bun run build` compiles `src/ui/sidebar.tsx` into `src/ui/sidebar.compiled.js` (gitignored, shipped in the tarball), and `tui.ts` loads that copy when installed from npm.

Run the tests on Bun 1.4.2 or newer; CI pins 1.4.2, the version OpenCode v2 embeds. On Bun 1.3.x, advancing fake timers further than the machine's uptime freezes the event loop, and the keepalive tests advance 50 minutes, so they hang on freshly booted CI runners while passing on a long-running laptop.

## Code intelligence indexes

GitNexus and CodeGraph indexes live in `.gitnexus/` and `.codegraph/` (both gitignored). To refresh them:

```sh
codegraph sync
gitnexus analyze --no-stats --skip-skills
```

Always pass `--skip-skills` to `gitnexus analyze`. Without it, GitNexus writes skill files to `.claude/skills/gitnexus/` and adds a table pointing at them to this file and `AGENTS.md`. The same skills are already installed at user level and the MCP server is available, so these copies aren't wanted here.

## Layout

The code follows a standard modular TypeScript layout under `src/`, mapped onto what a plugin does. Follow it for all new code.

```
src/
├── server.ts                  # server entry: builds the parts and registers them with OpenCode
├── tui.ts                     # TUI entry: palette, slash command, registers the sidebar
├── rpc.ts                     # RPC contract and client type (public export, so it stays a top-level entry)
├── config/
│   └── settings.ts            # Settings type, defaults, option parsing, layer merging
├── constants/
│   ├── anthropic.ts           # beta header value, x-cache-ttl header name, Anthropic provider IDs
│   ├── keepalive.ts           # TTL_MS, PING_OFFSET_MS, HIT_RATIO, PING_PROMPT, ...
│   └── openai.ts              # /chat/completions suffix, Claude-model regexes, finish-reason map
├── models/
│   ├── cache.ts               # CacheTtlMode, Ttl, CacheUsage
│   └── keepalive.ts           # KeepaliveSnapshot, SkipReason, RequestKind
├── controllers/
│   ├── command.ts             # server /cache-manager handler
│   ├── command-args.ts        # /cache-manager argument parsing (shared with the TUI)
│   └── rpc-handlers.ts        # getSettings / setGlobal / setSession / resetSession / getKeepalive
├── middleware/
│   ├── request.ts             # http.request hook: ping alignment, TTL rewrite, request bookkeeping
│   └── response.ts            # http.response hook: usage observation
├── services/
│   ├── keepalive-engine.ts    # scheduling engine
│   ├── ping-tracker.ts        # which generate calls are pings, and their response promises
│   ├── settings-store.ts      # storage-backed SettingsStore and the deleted-session sweep
│   ├── cache-ttl.ts           # TTL rewrite of the request body and beta header merge (both wires)
│   ├── cache-control.ts       # cache_control block helpers shared by both wires
│   ├── openai-cache-ttl.ts    # openai-chat TTL rewrite and breakpoint injection
│   ├── classify.ts            # wire + strategy (explicit/implicit) of a request
│   ├── model-patterns.ts      # explicitCacheModels patterns: substring, /regex/flags, leading !
│   ├── strategy-store.ts      # strategies learned from responses, kept in memory and plugin storage
│   ├── ping-alignment.ts      # aligning a ping's messages with the last primary request
│   ├── usage.ts               # Anthropic usage/SSE parsing, granted-TTL detection
│   └── usage-openai.ts        # openai-chat usage, finish reason and model identity parsing
├── ui/
│   ├── command.ts             # TUI /cache-manager runner (typed arguments, toasts)
│   ├── picker.ts              # Session/Global picker
│   ├── snapshot-feed.ts       # keepalive snapshots for the sidebar, fed by RPC events
│   ├── sidebar.tsx            # Solid sidebar component; the only JSX file
│   ├── sidebar.compiled.js    # build output of sidebar.tsx (gitignored, shipped)
│   ├── sidebar.compiled.d.ts  # types for the compiled output
│   └── sidebar-lines.ts       # pure sidebar line formatting
└── utils/
    ├── format.ts              # formatRemaining, formatTokens, errorMessage
    ├── is-record.ts
    ├── num.ts                 # finite-number coercion for usage fields
    └── request-path.ts        # POST-to-path-suffix check used by the classifier
scripts/
├── build-sidebar.ts           # compiles src/ui/sidebar.tsx to src/ui/sidebar.compiled.js
├── capture-sidebar.ts         # renders the sidebar for docs/images/*.svg (ANSI out, or --all through freeze)
└── capture/
    ├── ansi.ts                # CapturedFrame -> truecolor ANSI rows
    └── screens.tsx            # sample snapshots and the screen list
docs/examples/                 # sample opencode.jsonc provider configs: anthropic, openrouter, openai-compatible
tests/                         # mirrors src/ (tests/services/usage.test.ts tests src/services/usage.ts)
```

Other top-level files:

- `tests/server.test.ts`, `tests/tui.test.ts` - integration suites that run each entry's `setup` against a mock host.
- `tests/helpers/` - shared test fixtures (sample Anthropic bodies, request builders, in-memory storage).
- `tests/opencode-config.test.ts` - checks that every `docs/examples/*.jsonc` parses and that each of its `-1h` variants rewrites to 1h.
- `tests/package-smoke.test.ts` - runs `npm pack` and resolves `<name>/server|tui|rpc` against the tarball the way OpenCode does.
- `docs/examples/` - sample provider configs with `-1h` model variants and commented plugin options, one per endpoint kind: `opencode.anthropic.jsonc`, `opencode.openrouter.jsonc`, `opencode.openai-compatible.jsonc` (not shipped). Add new examples there; the config test picks up every `.jsonc` file.
- `docs/` - `CONTRIBUTING.md`, `UPGRADE.md`, README images in `images/` (the sidebar SVGs are generated by `bun scripts/capture-sidebar.ts --all`, which needs Charm's `freeze`; `picker.png` is a screenshot), and design notes under `superpowers/`.

Where new code goes:

- Entry files (`src/server.ts`, `src/tui.ts`) only wire parts together. Logic belongs in `services/`, `controllers/` or `middleware/`.
- `controllers/` handle user-facing input (commands, RPC calls) and delegate to services. `middleware/` holds the HTTP hooks. `services/` holds the core logic and should stay testable without a host.
- Types used by more than one module go in `models/`; a type used by one module stays next to it. Fixed values go in `constants/`, not inline.
- Configuration (settings shape, defaults, option parsing) goes in `config/`.
- `utils/` is for small pure helpers with no domain knowledge. Don't duplicate a helper; move it here.
- Anything rendered in the TUI goes in `ui/`. Keep formatting pure (`sidebar-lines.ts`) and separate from Solid components.
- Each source file with logic gets a unit test file at the matching path under `tests/`; files that only declare types, constants or schemas (`models/keepalive.ts`, `constants/`, `rpc.ts`) need none, and `ui/sidebar.tsx` can only run inside the TUI host, so its logic lives in `sidebar-lines.ts`. Split test files by area rather than growing one large file.
- Test behaviour in the unit test of the module that owns it. `tests/server.test.ts` and `tests/tui.test.ts` only check what needs the plugin host: registration, setup-time option and storage reads, events emitted, keepalive round trips through both hooks and the engine, and cleanup.
- A local checkout is loaded by symlinking `src/` (not the repo root) into `~/.config/opencode/plugins/`: OpenCode resolves a plugin directory by file path, not through `package.json` `exports`.
- No `dist/` and no `@types/`. The only build output is `src/ui/sidebar.compiled.js`; keep any further compile step out unless it solves the same problem (code the host will not transform under `node_modules`).

## Rules

- Anthropic requires 1h breakpoints to come before 5m ones in a request. Any change to TTL assignment must preserve that ordering.
- `1h` / `hybrid` requests must carry `anthropic-beta: extended-cache-ttl-2025-04-11`, merged with any existing beta values. This applies on both wires; some OpenAI-compatible proxies (OmniRoute) need it for 1h to take effect.
- The `x-cache-ttl` header is a per-model override sentinel: read it, apply it, strip it before the request leaves. On the OpenAI wire this holds for implicit-cache models too (strip it, rewrite nothing else).
- `files` ships `src/` and `tsconfig.json` includes `src/`, so new files under `src/` need no packaging changes. A new public entry point needs an `exports` entry pointing into `src/`; the smoke test checks the tarball resolves it.
- Releases are tag-driven (`v*`) through `.github/workflows/release.yml` with npm OIDC trusted publishing. Do not publish by hand.
- The release workflow and the package smoke test pack with `--ignore-scripts`, so they run `bun run build` explicitly. Keep that if the pack command changes.
- Run `bun test` and `bun run typecheck` before calling work done.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **opencode-cache-manager**. Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: `detect_changes({scope: "compare", base_ref: "main"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit changes without running `detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/opencode-cache-manager/context` | Codebase overview, check index freshness |
| `gitnexus://repo/opencode-cache-manager/clusters` | All functional areas |
| `gitnexus://repo/opencode-cache-manager/processes` | All execution flows |
| `gitnexus://repo/opencode-cache-manager/process/{name}` | Step-by-step execution trace |

<!-- gitnexus:end -->
