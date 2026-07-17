# Protocol Notes: Claude Code 2.1.207

> These notes describe private implementation details observed in the locally installed Claude Code 2.1.207 binary. They are not an official or stable API contract.

## Public client metadata

```text
Authorize: https://claude.com/cai/oauth/authorize
Token:     https://platform.claude.com/v1/oauth/token
Redirect:  https://platform.claude.com/oauth/code/callback
Profile:   https://api.anthropic.com/api/oauth/profile
Client ID: 9d1c250a-e61b-44d9-88ed-5944d1962f5e
Scope:     user:inference
```

The client ID identifies a public OAuth client and is not a client secret.

## Authorization URL

The manual, inference-only path uses these parameters:

| Parameter | Value |
|---|---|
| `code` | `true` |
| `client_id` | Public client ID above |
| `response_type` | `code` |
| `redirect_uri` | Manual redirect above |
| `scope` | `user:inference` |
| `code_challenge` | base64url SHA-256 of verifier |
| `code_challenge_method` | `S256` |
| `state` | 32 random bytes, base64url encoded |

No `prompt=consent` or `offline_access` parameter was present in the observed inference-only builder.

## Code exchange

The token request is a JSON POST with a 30-second client timeout:

```json
{
  "grant_type": "authorization_code",
  "code": "<one-time-code>",
  "redirect_uri": "https://platform.claude.com/oauth/code/callback",
  "client_id": "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  "code_verifier": "<pkce-verifier>",
  "state": "<stored-state>"
}
```

The application validates the response shape, calculates absolute expiration timestamps, and retains only the fields needed by the isolated Claude Code runner.

## Refresh behavior

Claude Code refreshes using a JSON POST containing:

```json
{
  "grant_type": "refresh_token",
  "refresh_token": "<refresh-token>",
  "client_id": "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  "scope": "user:inference"
}
```

A rotated refresh token replaces the prior value. Claude Session Lab serializes inference per browser session so two processes cannot race the same rotation.

## Revocation

Disconnect sends a best-effort JSON POST to:

```text
https://platform.claude.com/v1/oauth/token/revoke
```

with `token`, `token_type_hint=refresh_token`, and the public client ID. Local memory is cleared before the upstream request so local logout does not depend on network success.

## Compatibility policy

The implementation is pinned by tests to the field names above. Before claiming support for another Claude Code version:

1. inspect the new authorization builder and exchange function;
2. compare endpoints, client ID, scope, and request body;
3. run the complete automated test suite;
4. validate with a disposable test account;
5. update this document and the compatibility statement in README.
