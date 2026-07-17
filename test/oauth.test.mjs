import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OAUTH,
  OAuthError,
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
} from '../src/oauth.mjs';

test('authorization URL matches the Claude Code 2.1.207 manual PKCE flow', () => {
  const url = new URL(buildAuthorizationUrl({ challenge: 'challenge_123', state: 'state_123' }));
  assert.equal(url.origin + url.pathname, OAUTH.authorizeUrl);
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    code: 'true',
    client_id: OAUTH.clientId,
    response_type: 'code',
    redirect_uri: OAUTH.redirectUrl,
    scope: 'user:inference',
    code_challenge: 'challenge_123',
    code_challenge_method: 'S256',
    state: 'state_123',
  });
  assert.equal(url.searchParams.has('prompt'), false);
  assert.equal(url.searchParams.has('offline_access'), false);
});

test('token exchange sends exact JSON fields and normalizes credentials', async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = { url, options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({
      access_token: 'access-placeholder',
      refresh_token: 'refresh-placeholder',
      expires_in: 3600,
      refresh_token_expires_in: 7200,
      scope: 'user:inference',
      account: { uuid: 'account-id', email_address: 'test@example.com' },
      organization: { uuid: 'organization-id' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const before = Date.now();
  const result = await exchangeAuthorizationCode({
    code: 'authorization-code',
    verifier: 'verifier-value',
    state: 'state-value',
    fetchImpl,
  });

  assert.equal(captured.url, OAUTH.tokenUrl);
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.headers['Content-Type'], 'application/json');
  assert.deepEqual(captured.body, {
    grant_type: 'authorization_code',
    code: 'authorization-code',
    redirect_uri: OAUTH.redirectUrl,
    client_id: OAUTH.clientId,
    code_verifier: 'verifier-value',
    state: 'state-value',
  });
  assert.equal(result.accessToken, 'access-placeholder');
  assert.equal(result.refreshToken, 'refresh-placeholder');
  assert.deepEqual(result.scopes, ['user:inference']);
  assert.ok(result.expiresAt >= before + 3_599_000);
  assert.equal(result.tokenAccount.emailAddress, 'test@example.com');
});

test('token exchange maps rejected codes to a recovery-safe error', async () => {
  const fetchImpl = async () => new Response('{"error":"contains-upstream-detail"}', { status: 401 });
  await assert.rejects(
    exchangeAuthorizationCode({ code: 'bad', verifier: 'v', state: 's', fetchImpl }),
    (error) => error instanceof OAuthError
      && error.code === 'AUTH_CODE_REJECTED'
      && !error.publicMessage.includes('contains-upstream-detail'),
  );
});
