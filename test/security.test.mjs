import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  base64Url,
  constantTimeEqual,
  createPkce,
  maskEmail,
  parseCookies,
  parseManualAuthorization,
  redactSecrets,
  sessionCookie,
} from '../src/security.mjs';

test('createPkce returns a valid S256 verifier/challenge pair', () => {
  const pair = createPkce();
  assert.match(pair.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.match(pair.challenge, /^[A-Za-z0-9_-]{43}$/);
  const expected = base64Url(createHash('sha256').update(pair.verifier, 'ascii').digest());
  assert.equal(pair.challenge, expected);
});

test('constantTimeEqual handles equal and unequal values', () => {
  assert.equal(constantTimeEqual('same-value', 'same-value'), true);
  assert.equal(constantTimeEqual('same-value', 'other-value'), false);
  assert.equal(constantTimeEqual('short', 'much-longer'), false);
});

test('manual authorization accepts raw code and validates optional state', () => {
  const state = 'state_value_abcdefghijklmnopqrstuvwxyz123456';
  assert.equal(parseManualAuthorization('raw-code_123', state), 'raw-code_123');
  assert.equal(parseManualAuthorization(`raw-code_123#${state}`, state), 'raw-code_123');
  assert.equal(
    parseManualAuthorization(`https://example.test/callback?code=url-code&state=${state}`, state),
    'url-code',
  );
  assert.throws(
    () => parseManualAuthorization('raw-code_123#another_state_abcdefghijklmnopqrstuvwxyz12', state),
    (error) => error.code === 'AUTH_STATE_MISMATCH',
  );
});

test('manual authorization rejects whitespace and controls', () => {
  assert.throws(() => parseManualAuthorization('bad code', 'state'), /invalid format/i);
  assert.throws(() => parseManualAuthorization('', 'state'), /missing or too long/i);
});

test('cookie helpers encode values and parse them back', () => {
  const header = sessionCookie('session', 'abc_123', 60);
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Strict/);
  assert.deepEqual(parseCookies('other=x; session=abc_123'), { other: 'x', session: 'abc_123' });
});

test('email masking keeps confirmation useful without returning full local part', () => {
  assert.equal(maskEmail('testaccount@example.com'), 'te********@example.com');
  assert.equal(maskEmail('x@example.com'), 'x***@example.com');
  assert.equal(maskEmail('invalid'), null);
});

test('redaction removes bearer and token-shaped fields', () => {
  const source = 'Bearer abc.def.ghi {"access_token":"secret-access","refreshToken":"secret-refresh","authorizationCode":"secret-code"}';
  const redacted = redactSecrets(source);
  assert.doesNotMatch(redacted, /abc\.def\.ghi|secret-access|secret-refresh|secret-code/);
  assert.match(redacted, /REDACTED/);
});
