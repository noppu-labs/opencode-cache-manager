# Security assessment

This page lists what could go wrong in opencode-cache-manager, how likely and how costly each problem is, and what the code does about it. It was last reviewed for version 0.8.3. A change to a hook, a parser, the keepalive rules, storage or the release pipeline should update it. [ARCHITECTURE.md](ARCHITECTURE.md) describes the actors and interfaces named here.

To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## What is worth protecting

- The user's API key. Every model request carries it in a header, and the plugin handles the request object before OpenCode sends it.
- The conversation in each request body and the model's reply in each response body.
- The user's money. A keepalive ping is a paid provider request, and a rewrite decides what the provider charges for a cache write.
- The user's turn, because a request the provider rejects fails their prompt.
- The published package, because a tampered release would run inside every user's OpenCode.

## Trust boundaries

- The plugin runs inside the OpenCode process with that process's rights. It trusts the host's hook events, session API and storage API.
- Provider and proxy responses are untrusted input. Proxies in particular answer in shapes the official APIs never produce.
- Plugin storage is shared by every OpenCode process on the machine and can be written by anything running as the user, so stored values are treated as untrusted when read.
- Plugin options, command arguments and RPC inputs come from the user or from another local plugin and are validated before use.
- The models.dev response is untrusted input.

## Risks

### 1. A request is sent somewhere it wasn't addressed, or carries something it shouldn't

Impact: high. Likelihood: low.

The rewrite builds each new request from the original's URL, method and headers; it never changes the destination and adds no header beyond `anthropic-beta`. A keepalive ping reuses the messages of the same session's last request, looked up by session ID and held in memory only, and OpenCode sends it to that session's model. The plugin makes one network request of its own, an opt-in `GET` to models.dev that carries no user data.

### 2. Keepalive spends more than the user expects

Impact: medium (money). Likelihood: medium, because it depends on how the user works.

Pings are bounded by `maxPings` per idle stretch (5 by default, 100 at most; a larger stored or typed value is not accepted). A ping that doesn't read the cache stops keepalive for the session, so a provider that ignores the cache can't become a stream of paid requests. A ping is never sent after the cache would already have expired. Child sessions, small contexts and sessions waiting on a tool are skipped. Each stored schedule has one owning process, so two OpenCode processes don't ping the same session.

What remains: pings for a session the user never returns to are pure cost, and running this plugin together with OpenCode's own `warming` option pays for both. The README states both.

### 3. A rewrite makes the provider reject the user's request

Impact: medium (a failed turn). Likelihood: medium on proxies and router aliases.

`prompt_cache_breakpoint` and `prompt_cache_options` go only to a model the `openai` profile matched by name or by an explicit `cacheProfiles` entry; a profile learned from a response never widens that. On the Messages wire only known Anthropic provider IDs are trusted as Claude and every other provider is classified by model. A Messages request a non-Anthropic provider answers with 400 or 422 drops the learned profile. A rewrite that throws leaves the request as OpenCode built it.

What remains: a router alias that switches models runs one turn behind, so the first request after a switch can carry the previous model's fields.

### 4. A malformed or hostile response breaks the plugin or the host

Impact: medium. Likelihood: medium, since proxies vary.

The response OpenCode receives is a pass-through of the original body; the plugin parses a separate copy in the background. Every step of that parsing is inside a `try`, the promises it returns never reject, and a value that fails a type check is treated as absent. The parsers, the rewrites and the input parsing are covered by fast-check property tests, 1,000 runs per property on each pull request and 10,000 weekly.

What remains: the background copy is read into memory in full, as the host's own copy is.

### 5. Tampered storage changes behaviour

Impact: low to medium. Likelihood: low; it needs code already running as the user.

Stored settings pass the same validation as typed ones. A keepalive record is checked field by field and dropped when malformed or expired, and a resumed schedule is still subject to every keepalive rule. A learned profile must be one of the three known IDs, and a learned `openai` is never enough on its own to send OpenAI-only fields. Ledger totals must be finite, non-negative numbers.

What remains: a writer can change the TTL mode, switch keepalive on or off and set its limits within the allowed ranges; forge a keepalive record so a session's pings resume on a schedule of the writer's choosing; mark a model on a non-Anthropic provider as Claude, so its next request carries Claude's cache fields; and change the savings figures the sidebar shows.

### 6. The debug log exposes something sensitive

Impact: medium. Likelihood: low; the log is off unless the user turns it on.

Request bodies are never written, apart from `role` and `cache_control` values of up to 16 characters in the breakpoint survey. URLs are logged without their query string or user info. Response excerpts and error messages need the separate `bodies` flag and are capped at 600 characters from each end. The file is created with mode `0600`.

What remains: a proxy that puts a key in the URL path will have it in the log, and `bodies` output can contain reply text. [CONTRIBUTING.md](CONTRIBUTING.md#debug-log) warns about both.

### 7. A wrong price from models.dev

Impact: low. Likelihood: low.

A price is used only for the dollar figures in the sidebar and has no effect on any request. A price must be a finite number with a positive input cost, and a model whose listings disagree is not priced.

### 8. The release is tampered with

Impact: high. Likelihood: low.

The package has no runtime dependencies of its own. CI installs from the committed lockfile with lifecycle scripts off, and every GitHub Action is pinned to a commit. A ruleset on `main` requires a pull request, a code-owner review and the CI check, and a ruleset on release tags blocks moving or deleting them. Publishing uses npm trusted publishing from `release.yml`, so no npm token exists to steal. Each release carries npm provenance, a build provenance attestation and checksums, and the smoke test checks that the tarball holds exactly the tested sources. [SECURITY.md](../SECURITY.md#verifying-releases) shows how to verify a release.

What remains: whoever can merge to `main` controls the release, and that is one maintainer today (see [GOVERNANCE.md](GOVERNANCE.md)). As the organization's only admin, the maintainer can bypass both rulesets: their own pull requests merge without a second person's approval, and the tag ruleset does not bind them. The checks, the pull request history and the provenance records still apply to every release.
