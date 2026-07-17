# Security Policy

## Supported versions

Claude Session Lab is experimental. Security fixes target the latest commit on `main` and the latest tagged release.

| Version | Supported |
|---|---|
| Latest `0.1.x` | Yes |
| Older snapshots | No |

## Reporting a vulnerability

Do **not** open a public issue containing exploit details, authorization codes, tokens, account information, host details, prompt content, or credential files.

Preferred process:

1. Use GitHub's private vulnerability reporting under the repository **Security** tab when available.
2. If private reporting is unavailable, open a minimal issue requesting private maintainer contact. Include no technical exploit details or private data.
3. Provide a concise impact statement, affected commit, reproduction steps using placeholder values, and a proposed mitigation if known.

You should receive an acknowledgement within seven days. This is a volunteer research project, so remediation timelines depend on severity and maintainer availability.

## Scope

High-priority findings include:

- a route or response that exposes access or refresh tokens;
- credential material written outside the request sandbox;
- access to the user's normal Claude Code profile;
- bypasses of loopback, Host, Origin, CSRF, PKCE state, or one-time exchange controls;
- prompt injection that enables tools or arbitrary local command execution;
- incomplete process-group termination or credential cleanup;
- secret material entering logs or Git history.

Private upstream OAuth changes should be reported only when they create a vulnerability in this repository. General service availability or account-support issues are out of scope.

## Safe research rules

- Test only accounts and systems you own or are authorized to assess.
- Use placeholder credentials in reports and tests.
- Do not retain, share, or attempt to use another person's credential.
- Do not perform denial-of-service testing against upstream services.
- Give maintainers a reasonable opportunity to investigate before disclosure.

## Secrets accidentally committed elsewhere

If you copied this project and committed a real secret, remove it from history and revoke it immediately. Deleting the visible file is not enough.
