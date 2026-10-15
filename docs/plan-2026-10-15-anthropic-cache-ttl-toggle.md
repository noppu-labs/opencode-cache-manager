# Anthropic Prompt-Cache TTL Toggle (5m / 1h / Hybrid) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable toggling between 5-minute (`5m`), 1-hour (`1h`), and `hybrid` (1h on tools+system, 5m on messages) Anthropic prompt-cache TTL in OpenCode V2 via both a `/cache-ttl` slash command and model variants in `~/.config/opencode/opencode.jsonc`.

**Architecture:**
OpenCode V2 automatically places up to 4 `"cache_control": { "type": "ephemeral" }` breakpoints on Anthropic-compatible requests (`tools`, `system`, and `messages` tail), defaulting to 5m TTL because `LLMRequest.cache` is not exposed in `opencode.jsonc`. However, OpenCode V2's plugin runtime (`@opencode/plugin`) exposes:
1. `ctx.session.hook("http.request", ...)` — intercepts the compiled Web `Request` after `applyCachePolicy` and protocol lowering have placed the `cache_control` markers, allowing deterministic JSON rewriting of `cache_control.ttl` (`"1h"` vs omitted for `5m`), stripping any internal sentinel header (`x-cache-ttl`), and appending `extended-cache-ttl-2025-04-11` to `anthropic-beta` when 1h breakpoints are emitted.
2. `ctx.command.transform(...)` — registers a `/cache-ttl` slash command (`5m`, `1h`, `hybrid`, `status`, or no-arg toggle) persisted across restarts in `ctx.storage` and confirmed in the session via `ctx.session.synthetic({ sessionID, text, resume: false })`.
3. Variant header overrides in `~/.config/opencode/opencode.jsonc` — adding `-1h` variants with `"headers": { "x-cache-ttl": "1h" }` on the 4 Claude models under `omniroute-anthropic` so the user can also pick 1h TTL directly from the TUI variant selector.

**Tech Stack:** TypeScript, `@opencode/plugin` (v2.0.22 in `~/.config/opencode`), Bun test (`bun test`).

---

## File Structure

- **Create:** `/Users/chernandez/.config/opencode/plugins/anthropic-cache-ttl.ts`
  - Pure helper exports (`parseModeArg`, `rewriteAnthropicCacheTtl`, `mergeBetaHeader`, `transformHttpRequest`) plus the default `Plugin.define({ id: "anthropic-cache-ttl", setup(ctx) { ... } })` entry point.
- **Create:** `/Users/chernandez/.config/opencode/plugins/anthropic-cache-ttl.test.ts`
  - Comprehensive Bun test suite covering pure payload transformation, Anthropic TTL ordering rules (`1h` before `5m` in `hybrid` mode), `anthropic-beta` header merging, `x-cache-ttl` header override & stripping, and full `Plugin.setup(ctx)` integration (slash command execution, storage persistence, synthetic session notices, and `http.request` hook behavior).
- **Modify:** `/Users/chernandez/.config/opencode/opencode.jsonc`
  - Add `-1h` variants (`none-1h`, `low-1h`, `medium-1h`, `high-1h`, `xhigh-1h`, `max-1h`) with `"headers": { "x-cache-ttl": "1h" }` to `auto/claude-haiku-5-5`, `auto/claude-sonnet-5-5`, `auto/claude-opus-5-5`, and `auto/claude-fable-5-1` under `providers["omniroute-anthropic"].models`.

---

### Task 1: Build and Test the Anthropic Cache TTL Plugin (`anthropic-cache-ttl.ts`)

**Files:**
- Create: `/Users/chernandez/.config/opencode/plugins/anthropic-cache-ttl.ts`
- Create: `/Users/chernandez/.config/opencode/plugins/anthropic-cache-ttl.test.ts`

- [ ] **Step 1: Write the failing test suite in `/Users/chernandez/.config/opencode/plugins/anthropic-cache-ttl.test.ts`**

Create `/Users/chernandez/.config/opencode/plugins/anthropic-cache-ttl.test.ts` testing:
1. `parseModeArg`: parses `"1h"`, `"5m"`, `"hybrid"`, `"status"`, case-insensitively, and returns `"toggle"` on empty input or `"invalid"` on unknown args.
2. `rewriteAnthropicCacheTtl`:
   - In `"1h"` mode, sets `ttl: "1h"` on all `cache_control: { type: "ephemeral" }` blocks across `tools`, `system`, and `messages[].content`.
   - In `"5m"` mode, removes `ttl` from all `cache_control: { type: "ephemeral" }` blocks across `tools`, `system`, and `messages[].content`.
   - In `"hybrid"` mode, sets `ttl: "1h"` on `tools` and `system` blocks and removes `ttl` (leaving 5m default) on `messages[].content` blocks (respecting Anthropic's prefix ordering rule: longer TTL must precede shorter TTL).
   - Leaves blocks without `cache_control` untouched.
3. `transformHttpRequest`:
   - Uses `x-cache-ttl` request header when present to override the stored mode, and always strips `x-cache-ttl` from the outbound request headers.
   - Adds `extended-cache-ttl-2025-04-11` to `anthropic-beta` (preserving existing comma-separated betas like `interleaved-thinking-2025-05-14` without duplicates) when `"1h"` or `"hybrid"` mode is active.
   - Leaves non-JSON or bodyless requests safe without throwing.
4. `plugin.setup(ctx)`:
   - Reads initial mode from `ctx.storage.get("mode")` (defaults to `"5m"`).
   - Registers `/cache-ttl` command via `ctx.command.transform`:
     - `/cache-ttl` toggles `5m` -> `1h` -> `5m`, persists via `ctx.storage.set("mode", ...)`, and sends `ctx.session.synthetic({ sessionID, text, resume: false })`.
     - `/cache-ttl hybrid` sets mode to `"hybrid"`, persists, and notifies.
     - `/cache-ttl status` reports the current mode without mutating it.
   - Registers `http.request` hook scoped to `omniroute-anthropic` (and `anthropic`) or checks providerID/route so requests to Claude models have their `cache_control` blocks rewritten according to the active mode.

- [ ] **Step 2: Run the test suite to verify it fails**

Run: `bun test /Users/chernandez/.config/opencode/plugins/anthropic-cache-ttl.test.ts`
Expected: FAIL (module `./anthropic-cache-ttl.ts` not found).

- [ ] **Step 3: Implement `/Users/chernandez/.config/opencode/plugins/anthropic-cache-ttl.ts`**

Implement the module using `@opencode/plugin` (`import { Plugin } from "@opencode/plugin"`):
- Export `type CacheTtlMode = "5m" | "1h" | "hybrid"`
- Export `EXTENDED_CACHE_BETA = "extended-cache-ttl-2025-04-11"`
- Export `SENTINEL_HEADER = "x-cache-ttl"`
- Export `parseModeArg(raw: string): CacheTtlMode | "toggle" | "status" | "invalid"`
- Export `mergeBetaHeader(existing: string | null, addBeta: boolean): string | null`
- Export `rewriteAnthropicCacheTtl(body: Record<string, unknown>, mode: CacheTtlMode): boolean`
- Export `transformHttpRequest(request: Request, fallbackMode: CacheTtlMode): Promise<Request>`
- Export default `Plugin.define({ id: "anthropic-cache-ttl", async setup(ctx) { ... } })`:
  - Load initial `mode` from `await ctx.storage.get("mode")` (validate if `"5m" | "1h" | "hybrid"`, else `"5m"`), with fallback to `ctx.options?.defaultMode` if provided.
  - Register `/cache-ttl` command via `await ctx.command.transform(...)`. Note: `input.prompt.text` is a `string` in OpenCode V2 `CommandInvocation` (`PromptInput.Prompt = { text: string, files?: ... }`), handle both `typeof input.prompt.text === "string"` and array fallback gracefully. Call `await ctx.session.synthetic({ sessionID: input.sessionID, text: ..., resume: false })`.
  - Register `await ctx.session.hook("http.request", async (evt) => { ... })`:
    - Apply when `evt.model.providerID === "omniroute-anthropic" || evt.model.providerID === "anthropic" || evt.request.headers.has("x-cache-ttl")`.
    - Replace `evt.request = await transformHttpRequest(evt.request, mode)`.

- [ ] **Step 4: Run the test suite to verify all tests pass**

Run: `bun test /Users/chernandez/.config/opencode/plugins/anthropic-cache-ttl.test.ts`
Expected: PASS (all unit and integration tests green).

---

### Task 2: (executed 2026-10-15 — see Task 3 note)

### Task 2B (SUPERSEDED, do not execute): Configure `-1h` Model Variants in `/Users/chernandez/.config/opencode/opencode.jsonc`

**Files:**
- Modify: `/Users/chernandez/.config/opencode/opencode.jsonc`
- Modify: `/Users/chernandez/.config/opencode/plugins/anthropic-cache-ttl.test.ts` (add config validation test)

- [ ] **Step 1: Write a config validation test in `anthropic-cache-ttl.test.ts`**

Add a test that reads `/Users/chernandez/.config/opencode/opencode.jsonc`, strips JSONC comments, parses JSON, and verifies:
1. All 4 models in `providers["omniroute-anthropic"].models` (`auto/claude-haiku-5-5`, `auto/claude-sonnet-5-5`, `auto/claude-opus-5-5`, `auto/claude-fable-5-1`) retain their existing `5m` variants AND have matching `-1h` variants (`high-1h`, `max-1h`, etc.) with `"headers": { "x-cache-ttl": "1h" }`.
2. Feeding a simulated request with a variant's `headers` into `transformHttpRequest` produces `"ttl": "1h"` on all `cache_control` blocks and strips `x-cache-ttl`.

- [ ] **Step 2: Run the test to verify it fails before editing `opencode.jsonc`**

Run: `bun test /Users/chernandez/.config/opencode/plugins/anthropic-cache-ttl.test.ts`
Expected: FAIL on the new config variant assertion.

- [ ] **Step 3: Update `/Users/chernandez/.config/opencode/opencode.jsonc`**

Add the `-1h` variants with `"headers": { "x-cache-ttl": "1h" }` to each of the 4 Claude models under `omniroute-anthropic`:
- `auto/claude-haiku-5-5`: `none-1h`, `low-1h`, `medium-1h`, `high-1h`, `xhigh-1h`, `max-1h`
- `auto/claude-sonnet-5-5`: `none-1h`, `low-1h`, `medium-1h`, `high-1h`, `xhigh-1h`, `max-1h`
- `auto/claude-opus-5-5`: `none-1h`, `low-1h`, `medium-1h`, `high-1h`, `xhigh-1h`, `max-1h`
- `auto/claude-fable-5-1`: `low-1h`, `medium-1h`, `high-1h`, `xhigh-1h`, `max-1h`

- [ ] **Step 4: Run the test suite and JSONC validator**

Run: `bun test /Users/chernandez/.config/opencode/plugins/anthropic-cache-ttl.test.ts`
Expected: PASS (all tests pass, `opencode.jsonc` parses cleanly).

---

## Task 3: Upgrade to Server + TUI Directory Plugin with Interactive Modal (`/cache-ttl` no-arg → `ctx.ui.dialog.select`)

> **Status: supersedes Task 2B for interactive UI.** The `-1h` variants are already shipped in `opencode.jsonc` (Task 2, executed 2026-10-15); keep them — they still work via the `x-cache-ttl` sentinel header. This task adds the modal without removing existing behavior.

**Goal:** Upgrade the single-file server plugin to a **directory plugin** `~/.config/opencode/plugins/anthropic-cache-ttl/` with:
- `index.ts` — server entrypoint: all existing logic (`/cache-ttl` command, `http.request` hook, `ctx.storage` persistence) + new RPC handlers (`getMode`, `setMode`) + `mode.updated` RPC event
- `tui.ts` — TUI entrypoint: registers a palette+slash command that opens a native modal (`ctx.ui.dialog.select`) showing current mode + 3 options; posts selection to server via RPC; shows a toast (no synthetic session message for modal-driven changes)
- `rpc.ts` — shared RPC contract (imported by both entrypoints)
- `shared.ts` — pure logic moved from the old single file (importable by both sides)

### Files
- Create: `/Users/chernandez/.config/opencode/plugins/anthropic-cache-ttl/index.ts`
- Create: `/Users/chernandez/.config/opencode/plugins/anthropic-cache-ttl/tui.ts`
- Create: `/Users/chernandez/.config/opencode/plugins/anthropic-cache-ttl/shared.ts`
- Create: `/Users/chernandez/.config/opencode/plugins/anthropic-cache-ttl/rpc.ts`
- Delete: `/Users/chernandez/.config/opencode/plugins/anthropic-cache-ttl.ts` (old single file)
- Update: `/Users/chernandez/.config/opencode/tests/anthropic-cache-ttl.test.ts` — imports to `../plugins/anthropic-cache-ttl/shared.ts`; add TUI + RPC tests

### Steps (TDD)

- [ ] **Step 3.1: Write failing tests** — update test imports to `../plugins/anthropic-cache-ttl/shared.ts`; add `describe("cache-ttl RPC")` (mock `ctx.rpc.register`; getMode returns persisted mode; setMode persists + emits `mode.updated`; setMode rejects invalid) and `describe("cache-ttl TUI plugin")` (mock `ui.dialog.select`/`ui.toast.show`/`keymap.layer`/`client.rpc`; no-arg run opens dialog with `current` + 3 options; dialog resolve → setMode + toast; dialog dismissed → nothing; explicit arg bypasses dialog).
- [ ] **Step 3.2: Verify red** — new describes FAIL (module not found), old tests pass against `shared.ts` path.
- [ ] **Step 3.3: Create `shared.ts`** — move ALL pure logic from the old single file verbatim (types, constants, `isCacheTtlMode`, `parseModeArg`, `mergeBetaHeader`, `applyTtlToBlock`, `applyTtlToTool`, `hasOneHourCacheControl`, `rewriteAnthropicCacheTtl`, `transformHttpRequest`). No `Plugin.define` — pure functions only.
- [ ] **Step 3.4: Create `rpc.ts`** — `CacheTtlRpc` const: `id: "anthropic-cache-ttl"`, methods `getMode` (in: `{}`, out: string) + `setMode` (in: `{ mode: "5m"|"1h"|"hybrid" }`, out: `{}`), event `mode.updated` (schema `{ mode: string }`).
- [ ] **Step 3.5: Create `index.ts` (server)** — `Plugin.define({ id: "anthropic-cache-ttl", setup(ctx) })`: same `/cache-ttl` command + `http.request` hook as before (importing from `./shared.ts`), PLUS `ctx.rpc.register(CacheTtlRpc, { getMode: async () => mode, setMode: async ({ mode: next }) => { validate; mode = next; await ctx.storage.set("mode", mode); await registration.events.emit("mode.updated", { mode }); } })`.
- [ ] **Step 3.6: Create `tui.ts`** — `Plugin.define` from `@opencode/plugin/tui`; `ctx.keymap.layer` with command `{ id: "anthropic-cache-ttl.open", title: "Anthropic Cache TTL", group: "Provider", palette: true, slash: { name: "cache-ttl", arguments: true }, run }`; `run(input?)`: parse arg; explicit valid mode → `rpc.setMode` + toast; no arg → `const current = await rpc.getMode({})`; `const selected = await ctx.ui.dialog.select({ title: "Anthropic Prompt Cache TTL", placeholder: "Select a TTL mode", current, options: [5m/1h/hybrid with pricing descriptions] })`; if selected && selected !== current → `setMode` + success toast; subscribe to `mode.updated` → info toast on remote changes.
- [ ] **Step 3.7: Delete old single-file plugin** (only after tests pass).
- [ ] **Step 3.8: Verify green** — `bun test /Users/chernandez/.config/opencode/tests/anthropic-cache-ttl.test.ts` ALL PASS.
- [ ] **Step 3.9: Manual smoke test** — restart TUI; `/cache-ttl` no-arg → modal; select 1h → toast; `/cache-ttl status` → synthetic "1h".

### Notes for the implementer
- **Duplicate `/cache-ttl` risk:** server `ctx.command.transform` AND TUI `keymap slash` may both register `/cache-ttl`. If duplicates appear in slash completion, remove the server-side command registration and keep only the TUI keymap `slash` + palette registration + RPC (headless users can still use `x-cache-ttl` variant headers or RPC). Prefer: TUI owns `/cache-ttl` interactive; server keeps the command for headless-but-arg'd use — verify empirically and eliminate duplicates.
- **Discovery:** directory must have `index.ts` (server, via `Host.resolve(["server", ""])` → `index`) and `tui.ts` (via `["tui"]` subpath).
- **Toast not synthetic:** modal-driven changes use TUI `ctx.ui.toast.show` — keeps chat transcript clean.
- **Storage:** server persists mode in `ctx.storage`; TUI reads via `getMode` RPC when the dialog opens (no stale cache).
