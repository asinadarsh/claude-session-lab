## Summary

<!-- Explain the problem and the smallest change that solves it. -->

## Validation

- [ ] `npm test`
- [ ] `npm run check`
- [ ] I used placeholder credentials only.
- [ ] I reviewed the diff for tokens, codes, cookies, host details, account data, and local paths.

## Security boundaries

- [ ] The listener remains hard-bound to loopback.
- [ ] No credential is returned to or stored by browser JavaScript.
- [ ] Existing Claude Code profiles remain outside the application boundary.
- [ ] Request bodies and raw OAuth responses are not logged.
- [ ] Claude Code remains tool-disabled, nonpersistent, bounded, and request-scoped.
- [ ] I updated `docs/SECURITY_MODEL.md` if a trust boundary changed.
- [ ] I updated `docs/PROTOCOL_NOTES.md` if OAuth behavior changed.

## UI changes

- [ ] Not applicable, or keyboard/focus/reduced-motion/mobile behavior was checked.

## Related issue

Closes #
