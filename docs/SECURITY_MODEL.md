# Security Model

Claude Session Lab is designed as a single-user, localhost-only research demo. This document separates properties enforced by the code from assumptions the operator must preserve.

## Assets

The sensitive assets are:

1. the OAuth authorization code during a single exchange;
2. the access token held in server memory;
3. the refresh token held in server memory;
4. the temporary Claude Code credential file during inference;
5. prompt and response content;
6. the operator's existing Claude Code profile, which must remain outside the app boundary.

## Trust boundaries

```text
Workstation browser
    |  trusted localhost or SSH tunnel
    v
Node server on 127.0.0.1
    |  TLS
    +--> Claude authorization/token/profile endpoints
    |
    +--> Ephemeral Claude Code subprocess
             |
             +--> request-scoped tmpfs credential
```

The host administrator and the user controlling the browser session are trusted. Other local host users, public network clients, browser extensions, and upstream services are outside the app's trust boundary.

## Enforced properties

### Loopback-only network boundary

`src/config.mjs` fixes the bind host to `127.0.0.1`. It is not configurable. The HTTP layer also rejects unexpected Host and Origin values. Remote use is expected to happen through an SSH tunnel that terminates on localhost.

### Browser isolation

The browser receives only:

- a random HttpOnly, SameSite=Strict session cookie;
- a separate CSRF token;
- the authorization URL;
- masked account and expiry metadata;
- model response text and safe usage metadata.

Access tokens, refresh tokens, verifier values, raw OAuth responses, and Claude credential files are never API response fields.

### OAuth transaction lifecycle

Each start request replaces any previous pending attempt with:

- 32 random bytes for the PKCE verifier;
- SHA-256 and base64url encoding for the challenge;
- 32 random bytes for state;
- a 10-minute deadline.

The pending transaction is removed before exchange. Invalid, expired, replayed, or cross-session attempts require starting over. If a pasted value supplies state explicitly, comparison is constant-time. The stored state is always sent to the token endpoint as required by the observed Claude Code flow.

### Ephemeral subprocess credentials

For each inference request the server creates a new directory under `/dev/shm/claude-session-lab` when writable, otherwise under the operating-system temporary directory. The runner creates separate HOME, config, cache, temp, and working directories. Directory mode is 700 and credential mode is 600.

Claude Code receives the prompt over stdin and runs with:

- JSON output;
- no session persistence;
- an empty tool list;
- telemetry disabled;
- a two-minute deadline;
- bounded stdout and stderr capture;
- process-group termination on timeout or overflow.

If Claude Code rotates a refresh token, the updated credential is validated and copied back to in-memory session state. The request directory is recursively removed in `finally`.

### Logging and errors

HTTP logs contain timestamp, request ID, method, route, status, and duration. Request bodies are not logged. Upstream bodies are not returned on authentication failure. A final redaction layer removes bearer credentials and common token/code fields from unexpected server errors.

## Residual risks

- A privileged host administrator can inspect process memory.
- Malicious browser extensions can read prompt and response content visible in the page.
- The private OAuth contract can change without notice.
- A hard power loss can prevent normal cleanup, although tmpfs content disappears on reboot.
- The fallback OS temporary directory may be disk-backed; operators requiring memory-only materialization should ensure `/dev/shm` is available and writable.
- Stopping the process without using Disconnect loses the local refresh token before revocation can be attempted.
- The app has not been designed for untrusted multi-user tenancy.

## Non-goals

This project does not provide public hosting, shared accounts, durable sessions, organization-wide identity, credential export, delegated administration, audit retention, billing controls, or a stable SDK.

## Operator checklist

- Use a dedicated test account.
- Keep the listener on loopback.
- Use an SSH tunnel for remote access.
- Do not add reverse-proxy exposure without a new threat model.
- Keep host access restricted and patched.
- Use Disconnect before shutdown when revocation matters.
- Re-run tests after every Claude Code upgrade.
- Never attach logs, authorization codes, or credential files to issues.
