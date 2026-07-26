# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases follow semantic versioning where practical for this experimental project.

## [Unreleased]

### Added

- **Gateway mode** (`SESSION_LAB_GATEWAY=1`): serves a linked Claude account to the owner's own apps over `POST /v1/messages` (Anthropic Messages subset, buffered and SSE streaming), `POST /v1/chat/completions` (OpenAI-compatible subset), and `GET /v1/models`.
- Encrypted keystore: AES-256-GCM at rest under `SESSION_LAB_MASTER_KEY`, GCM AAD bound to the record id, atomic writes with `fsync` before rename, and an exclusive process-lifetime lock.
- Issued API keys (`csl_sk_...`) shown once and stored only as a SHA-256 hash, with per-key rate limiting, queue caps, usage counters, and revocation.
- Base64 image (vision) support, multi-turn history flattened to a single billed model turn, and `--system-prompt` replacing the Claude Code preamble.
- `scripts/link-local.mjs` (`npm run link-local`) to link the account this machine already uses, plus a gateway key panel in the admin UI.
- `examples/` with curl, Anthropic SDK, OpenAI SDK, and multi-turn chat-loop scripts, all verified against a live gateway.
- `docs/API.md` and `docs/DEPLOY.md`; README rewritten around setup and use.
- Test suite grown to 83, including a full HTTP-surface integration test that boots the real server.

### Changed

- One streaming sandbox runner (`stream-json` in and out) now backs both the gateway and the browser playground; the sandbox additionally passes `--setting-sources ''` and `--strict-mcp-config` so host hooks and MCP servers cannot leak into a request.
- Inference is serialized per linked Claude account — across every key and the admin UI — because two concurrent runs would each rotate the OAuth refresh token and invalidate the other.
- Unsupported request fields are rejected rather than silently ignored: `tools`/`tool_choice`, `stop_sequences` (and OpenAI `stop`), and image URL sources.

### Fixed

- A rotated OAuth token is persisted even when the run fails, instead of being dropped after the upstream had already applied the rotation.
- Revoking one key no longer surrenders a refresh token shared with a live sibling key, which would have signed out every key for that account.
- Client disconnects cancel the CLI on buffered requests, not only streaming ones.
- Sandboxes are removed on forced exit and on failed setup, so a plaintext credential is never left on tmpfs.
- A request body that parses to `null` or an array returns `400` instead of `500`.

## [0.1.0] - 2026-07-18

### Added

- Manual PKCE authorization flow compatible with the observed Claude Code 2.1.207 inference-only path.
- Localhost-only Node.js server with Host, Origin, CSRF, session, size, and timeout controls.
- In-memory OAuth credential custody and best-effort refresh-token revocation.
- Request-scoped Claude Code sandbox with isolated home/config/cache/temp/work directories.
- Tool-disabled, nonpersistent JSON inference over stdin.
- Dark technical dashboard with four-stage connection timeline and masked account metadata.
- Thirteen tests covering PKCE, state, OAuth payloads, redaction, credential refresh handoff, and hung-process termination.
- Security model, protocol notes, CI workflow, and community documentation.
- MIT License.

[Unreleased]: https://github.com/asinadarsh/claude-session-lab/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/asinadarsh/claude-session-lab/releases/tag/v0.1.0
