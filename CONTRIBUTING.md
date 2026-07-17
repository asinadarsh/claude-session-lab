# Contributing

Thanks for helping improve Claude Session Lab. Small, auditable changes are preferred over broad rewrites.

## Before opening an issue

- Search existing issues and protocol notes.
- Confirm the behavior on the current `main` branch.
- Remove authorization codes, tokens, account identifiers, hostnames, IP addresses, and prompt content from screenshots or logs.
- Use the security process in [SECURITY.md](SECURITY.md) for vulnerabilities.

## Development setup

```bash
git clone https://github.com/asinadarsh/claude-session-lab.git
cd claude-session-lab
node --version   # 24 or newer
npm test
npm run check
```

Automated tests do not contact Anthropic and use placeholder credentials only.

## Pull requests

1. Create a focused branch.
2. Keep runtime dependencies at zero unless there is a strong security justification.
3. Add or update tests for behavior changes.
4. Run `npm test` and `npm run check`.
5. Update protocol or security documentation when a boundary changes.
6. Complete every applicable item in the pull-request template.

## Security invariants

A contribution must not:

- make the bind address configurable or public;
- return OAuth credentials to the browser;
- persist real credentials in the repository or application directory;
- read or write the user's normal Claude Code profile;
- log request bodies, authorization codes, tokens, or raw OAuth responses;
- run Claude Code with tools enabled or session persistence;
- weaken Host, Origin, CSRF, state, timeout, file-mode, or output-size checks;
- introduce shell interpolation for prompts or credentials;
- allow concurrent inference within one browser session.

If a change intentionally revises an invariant, first open a design issue that includes a new threat model.

## Style

- Use Node.js built-ins and ECMAScript modules.
- Prefer explicit limits and public-safe error messages.
- Keep sensitive values in the narrowest possible scope.
- Use semantic HTML, visible focus, reduced-motion support, and no external frontend assets.
- Avoid unrelated formatting churn.

## Protocol changes

Private OAuth behavior can change. Claims for a new Claude Code version should include:

- the tested version;
- recovered endpoint and payload differences;
- unit-test updates;
- a disposable-account validation report with all private values removed.

## License

By submitting a contribution, you agree that it may be distributed under the project's MIT License.
