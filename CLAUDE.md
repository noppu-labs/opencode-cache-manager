# opencode-cache-manager

OpenCode V2 plugin that rewrites outgoing Anthropic requests to control the prompt-cache TTL: `5m` (default), `1h`, or `hybrid` (1h on tools + system, 5m on messages). Published to npm as both `@noppu-labs/opencode-cache-manager` and `opencode-cache-manager`.

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

- `server.ts` - server entry: `/cache-ttl` command, `http.request` hook that rewrites `cache_control` TTLs, RPC handlers, persisted mode in plugin storage.
- `tui.ts` - TUI entry: palette entry, slash command, picker modal, toasts.
- `shared.ts` - pure logic shared by both sides. Put testable logic here.
- `rpc.ts` - RPC contract (`getMode` / `setMode` / `mode.updated` event).
- `tests/anthropic-cache-ttl.test.ts` - logic, RPC, and TUI command paths.
- `tests/package-smoke.test.ts` - runs `npm pack` and resolves `<name>/server|tui|rpc` against the tarball the way OpenCode does.
- `opencode.jsonc` - sample provider config with `-1h` model variants (not shipped).
- `docs/` - design notes from the original build.

## Rules

- Anthropic requires 1h breakpoints to come before 5m ones in a request. Any change to TTL assignment must preserve that ordering.
- `1h` / `hybrid` requests must carry `anthropic-beta: extended-cache-ttl-2025-04-11`, merged with any existing beta values.
- The `x-cache-ttl` header is a per-model override sentinel: read it, apply it, strip it before the request leaves.
- Adding a source file that must ship means updating `files`, `exports`, and `tsconfig.json` `include` in step; the smoke test checks the tarball matches.
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
