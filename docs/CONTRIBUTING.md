# Contributing

opencode-cache-manager is an OpenCode V2 plugin. The product is the code under `src/`; `tests/` mirrors it and `scripts/` holds the one build step.

## Prerequisites

- [Bun](https://bun.sh) 1.4.2 or newer. CI pins 1.4.2, the version OpenCode V2 embeds. On Bun 1.3.x the keepalive tests, which advance fake timers by 50 minutes, can freeze the event loop on a freshly booted machine.
- An OpenCode V2 install (>= 2.0.22) if you want to try changes in the TUI.

```sh
bun install
```

## Running it from a checkout

Symlink the repo's `src/` directory (not the repo root) into OpenCode's plugins directory. OpenCode resolves `server.ts` / `tui.ts` / `rpc.ts` from the directory itself:

```sh
ln -s "$(pwd)/src" ~/.config/opencode/plugins/opencode-cache-manager
```

A checkout loads `src/ui/sidebar.tsx` directly, so no build is needed. Don't keep the npm package in `plugins` at the same time, or the plugin loads twice.

## Before opening a pull request

Run the same checks CI runs (`.github/workflows/ci.yml`):

```sh
bun run fmt:check   # oxfmt --check (bun run fmt rewrites in place)
bun run lint        # oxlint, type-aware, all five rule categories (bun run lint:fix applies fixes)
bun run typecheck   # tsc -p . (strict, noEmit) over src/, tests/ and scripts/
bun test            # all suites in tests/
```

`bun test` includes a package smoke test: it runs `npm pack`, replays the entrypoint resolution OpenCode performs for an npm plugin (`Bun.resolveSync("<name>/server" | "<name>/tui" | "<name>/rpc")` against the extracted tarball) and checks the shipped files are byte-identical to the tested sources, including the compiled sidebar matching a fresh build.

## Layout

```
src/
├── server.ts      # server entry: wires the command, HTTP hooks and RPC handlers
├── tui.ts         # TUI entry: palette + slash command, sidebar
├── rpc.ts         # the RPC contract (settings, keepalive snapshot, events)
├── config/        # settings shape, defaults, option parsing, layer merging
├── constants/     # Anthropic and OpenAI wire values, keepalive timings
├── models/        # shared types (TTL modes, usage, keepalive snapshot)
├── controllers/   # /cache-manager command and RPC handlers
├── middleware/    # http.request / http.response hooks
├── services/      # TTL rewrite, request classification, keepalive engine, ping alignment, usage parsing, settings store
├── ui/            # picker, typed command, sidebar
└── utils/         # small shared helpers
tests/             # mirrors src/
scripts/           # build-sidebar.ts, capture-sidebar.ts and its capture/ modules
docs/              # this file, UPGRADE.md, examples/ (sample provider configs), design notes
```

Where things go:

- Entry files (`src/server.ts`, `src/tui.ts`) only wire parts together. Logic belongs in `services/`, `controllers/` or `middleware/`.
- `services/` holds the core logic and should stay testable without a host. `controllers/` handle user input (commands, RPC) and delegate to services. `middleware/` holds the HTTP hooks.
- Types shared by more than one module go in `models/`; fixed values go in `constants/`.
- Anything rendered in the TUI goes in `ui/`. Keep formatting pure (`sidebar-lines.ts`) and separate from the Solid component.
- Each source file with logic gets a test file at the matching path under `tests/`. `tests/server.test.ts` and `tests/tui.test.ts` only cover what needs the plugin host.

## The sidebar build

`src/ui/sidebar.tsx` is the only JSX file. OpenCode runs the Solid JSX transform only on files outside `node_modules`, so for the npm package `bun run build` compiles it to `src/ui/sidebar.compiled.js` (gitignored, shipped in the tarball) and `tui.ts` loads that copy when installed from npm. The build also runs on `prepack`. There is no other build output and no `dist/`.

## Sidebar images

`docs/images/sidebar.svg` and `docs/images/sidebar-states.svg` in the README are rendered from `src/ui/sidebar.tsx`, not drawn by hand. `scripts/capture-sidebar.ts <screen>` renders one screen with OpenTUI's test renderer from sample snapshots (`scripts/capture/screens.tsx`) and OpenCode's default dark theme, and prints it as truecolor ANSI. Charm's [freeze](https://github.com/charmbracelet/freeze) turns that into an SVG. freeze is a contributor tool, not a package dependency, and CI does not run it:

```sh
brew install charmbracelet/tap/freeze   # other package managers: see the freeze README
```

After changing the sidebar component or a screen's samples, regenerate both images and commit them:

```sh
bun scripts/capture-sidebar.ts --all
```

`tests/scripts/capture-sidebar.test.ts` checks the rows each screen renders, so a change in the sidebar that affects the images fails the suite until the samples are updated. The picker image (`docs/images/picker.png`) is a screenshot: the picker is OpenCode's own dialog, so it can't be rendered from this repo.

## Rules worth knowing

- Anthropic requires 1h breakpoints to come before 5m ones in a request. Any change to TTL assignment must preserve that ordering.
- `1h` and `hybrid` requests must carry `anthropic-beta: extended-cache-ttl-2025-04-11`, merged with any existing beta values.
- The `x-cache-ttl` header is a per-model override sentinel: read it, apply it, strip it before the request leaves.
- A new public entry point needs an `exports` entry in `package.json` pointing into `src/`; the smoke test checks the tarball resolves it.

## Releases

Releases are cut by pushing a `v*` tag. `.github/workflows/release.yml` tests, packs, publishes both npm names (`@noppu-labs/opencode-cache-manager` and `opencode-cache-manager`) through npm OIDC trusted publishing, and opens a GitHub Release with the tarball, its build provenance attestation and checksums. No npm token is stored anywhere, and nothing is published by hand.
