# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases follow semantic versioning where practical for this experimental project.

## [Unreleased]

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
