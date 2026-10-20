# opencode-cache-manager

OpenCode V2 plugin that manages the Anthropic prompt cache: it rewrites outgoing requests to control the TTL (`5m` default, `1h`, or `hybrid` with 1h on tools + system and 5m on messages), per session, and keeps idle sessions' caches warm with hidden keepalive pings. Published to npm as both `@noppu-labs/opencode-cache-manager` and `opencode-cache-manager`.

## Commands

```sh
bun install
bun test             # all tests in tests/
bun run typecheck    # tsc -p . (noEmit, strict)
```

Runtime is Bun (>= 1.3). There is no build step: the `.ts` sources ship as-is and OpenCode loads them directly.

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
│   └── keepalive.ts           # TTL_MS, PING_OFFSET_MS, HIT_RATIO, PING_PROMPT, ...
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
│   ├── cache-ttl.ts           # TTL rewrite of the request body and beta header merge
│   ├── ping-alignment.ts      # aligning a ping's messages with the last primary request
│   └── usage.ts               # usage/SSE parsing, granted-TTL detection
├── ui/
│   ├── command.ts             # TUI /cache-manager runner (typed arguments, toasts)
│   ├── picker.ts              # Session/Global picker
│   ├── snapshot-feed.ts       # keepalive snapshots for the sidebar, fed by RPC events
│   ├── sidebar.tsx            # Solid sidebar component; the only JSX file
│   └── sidebar-lines.ts       # pure sidebar line formatting
└── utils/
    ├── format.ts              # formatRemaining, formatTokens, errorMessage
    └── is-record.ts
tests/                         # mirrors src/ (tests/services/usage.test.ts tests src/services/usage.ts)
```

Other top-level files:

- `tests/server.test.ts`, `tests/tui.test.ts` - integration suites that run each entry's `setup` against a mock host; they cover the wiring in controllers, middleware and `ui/`.
- `tests/helpers/` - shared test fixtures (sample Anthropic bodies, request builders).
- `tests/opencode-config.test.ts` - checks the `-1h` variants in `opencode.jsonc`.
- `tests/package-smoke.test.ts` - runs `npm pack` and resolves `<name>/server|tui|rpc` against the tarball the way OpenCode does.
- `opencode.jsonc` - sample provider config with `-1h` model variants and a commented keepalive options example (not shipped).
- `docs/` - design notes from the original build.

Where new code goes:

- Entry files (`src/server.ts`, `src/tui.ts`) only wire parts together. Logic belongs in `services/`, `controllers/` or `middleware/`.
- `controllers/` handle user-facing input (commands, RPC calls) and delegate to services. `middleware/` holds the HTTP hooks. `services/` holds the core logic and should stay testable without a host.
- Types used by more than one module go in `models/`; a type used by one module stays next to it. Fixed values go in `constants/`, not inline.
- Configuration (settings shape, defaults, option parsing) goes in `config/`.
- `utils/` is for small pure helpers with no domain knowledge. Don't duplicate a helper; move it here.
- Anything rendered in the TUI goes in `ui/`. Keep formatting pure (`sidebar-lines.ts`) and separate from Solid components.
- Each source file gets a test file at the matching path under `tests/`. Split test files by area rather than growing one large file.
- A local checkout is loaded by symlinking `src/` (not the repo root) into `~/.config/opencode/plugins/`: OpenCode resolves a plugin directory by file path, not through `package.json` `exports`.
- No `dist/` and no `@types/`: there is no build step and nothing needs global declarations. Adding a compile step changes how releases work, so it is a separate decision.

## Rules

- Anthropic requires 1h breakpoints to come before 5m ones in a request. Any change to TTL assignment must preserve that ordering.
- `1h` / `hybrid` requests must carry `anthropic-beta: extended-cache-ttl-2025-04-11`, merged with any existing beta values.
- The `x-cache-ttl` header is a per-model override sentinel: read it, apply it, strip it before the request leaves.
- `files` ships `src/` and `tsconfig.json` includes `src/`, so new files under `src/` need no packaging changes. A new public entry point needs an `exports` entry pointing into `src/`; the smoke test checks the tarball resolves it.
- Releases are tag-driven (`v*`) through `.github/workflows/release.yml` with npm OIDC trusted publishing. Do not publish by hand.
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
