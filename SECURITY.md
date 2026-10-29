# Security Policy

## Reporting a vulnerability

Report suspected vulnerabilities privately via
[GitHub private vulnerability reporting](https://github.com/noppu-labs/opencode-cache-manager/security/advisories/new);
please don't open a public issue. Include enough detail to reproduce: the plugin version, the
provider and endpoint involved, and the impact. You can expect an initial response within a week.

## Scope

This repository ships an OpenCode plugin that rewrites outgoing model requests and sends hidden
keepalive pings, plus the CI that releases it to npm. In scope:

- Request and response handling in the HTTP hooks: leaking API keys, headers or prompt content
  to a destination other than the one the request was addressed to, or rewriting requests in a
  way that sends user data somewhere it wasn't headed.
- Keepalive pings: pings sent for a session, model or provider other than the one being kept
  warm, or carrying content that wasn't already in that session's request.
- Settings and state kept in plugin storage, and the `/cache-manager` command and RPC handlers.
- The release pipeline: tag verification, tarball builds, checksums and npm provenance.

Issues in OpenCode itself or in a model provider's API are worth reporting upstream as well.

## Verifying releases

Both npm packages (`@noppu-labs/opencode-cache-manager` and `opencode-cache-manager`) are
published from GitHub Actions with npm provenance. After installing, check them with:

```sh
npm audit signatures
```

Each [GitHub release](https://github.com/noppu-labs/opencode-cache-manager/releases) also ships
the published tarball with a GitHub
[build provenance attestation](https://github.com/noppu-labs/opencode-cache-manager/attestations)
that proves CI built it from the tagged commit:

```sh
gh attestation verify noppu-labs-opencode-cache-manager-<version>.tgz --repo noppu-labs/opencode-cache-manager
```

The Sigstore bundle (`<tarball>.intoto.jsonl`) and `checksums-sha256.txt` are attached next to
it.
