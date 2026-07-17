import { PublicError } from './security.mjs';

export const OAUTH = Object.freeze({
  authorizeUrl: 'https://claude.com/cai/oauth/authorize',
  tokenUrl: 'https://platform.claude.com/v1/oauth/token',
  redirectUrl: 'https://platform.claude.com/oauth/code/callback',
  profileUrl: 'https://api.anthropic.com/api/oauth/profile',
  clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  scope: 'user:inference',
});

export class OAuthError extends PublicError {
  constructor(status, code, publicMessage, upstreamStatus = null) {
    super(status, code, publicMessage);
    this.name = 'OAuthError';
    this.upstreamStatus = upstreamStatus;
  }
}

export function buildAuthorizationUrl({ challenge, state }) {
  const url = new URL(OAUTH.authorizeUrl);
  url.searchParams.append('code', 'true');
  url.searchParams.append('client_id', OAUTH.clientId);
  url.searchParams.append('response_type', 'code');
  url.searchParams.append('redirect_uri', OAUTH.redirectUrl);
  url.searchParams.append('scope', OAUTH.scope);
  url.searchParams.append('code_challenge', challenge);
  url.searchParams.append('code_challenge_method', 'S256');
  url.searchParams.append('state', state);
  return url.toString();
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (text.length > 1024 * 1024) throw new Error('OAuth response exceeded 1 MiB');
  return text ? JSON.parse(text) : {};
}

function exchangeFailure(status) {
  if (status === 400 || status === 401 || status === 403) {
    return new OAuthError(400, 'AUTH_CODE_REJECTED', 'The authorization code was rejected or expired. Start a new sign-in and try again.', status);
  }
  if (status === 429) {
    return new OAuthError(429, 'AUTH_RATE_LIMITED', 'Claude temporarily rate-limited the sign-in. Wait a moment, then start again.', status);
  }
  return new OAuthError(502, 'AUTH_UPSTREAM_UNAVAILABLE', 'The Claude sign-in service is temporarily unavailable. Try again shortly.', status);
}

export async function exchangeAuthorizationCode({ code, verifier, state, timeoutMs = 30000, fetchImpl = fetch }) {
  let response;
  try {
    response = await fetchImpl(OAUTH.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri: OAUTH.redirectUrl,
        client_id: OAUTH.clientId,
        code_verifier: verifier,
        state,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new OAuthError(504, 'AUTH_TIMEOUT', 'The sign-in exchange timed out. Start a new authorization and retry.');
    }
    throw new OAuthError(502, 'AUTH_NETWORK_ERROR', 'The server could not reach the Claude sign-in service. Try again shortly.');
  }

  if (!response.ok) {
    await response.arrayBuffer().catch(() => {});
    throw exchangeFailure(response.status);
  }

  let data;
  try {
    data = await readJsonResponse(response);
  } catch {
    throw new OAuthError(502, 'AUTH_RESPONSE_INVALID', 'Claude returned an unexpected sign-in response. Start again.');
  }

  const expiresIn = Number(data.expires_in);
  if (typeof data.access_token !== 'string' || !data.access_token || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new OAuthError(502, 'AUTH_RESPONSE_INVALID', 'Claude returned an incomplete sign-in response. Start again.');
  }

  const refreshExpiresIn = Number(data.refresh_token_expires_in);
  const now = Date.now();
  const account = data.account && typeof data.account === 'object' ? data.account : {};
  const organization = data.organization && typeof data.organization === 'object' ? data.organization : {};

  return {
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : null,
    expiresAt: now + expiresIn * 1000,
    refreshTokenExpiresAt: Number.isFinite(refreshExpiresIn) && refreshExpiresIn > 0
      ? now + refreshExpiresIn * 1000
      : now + 365 * 24 * 60 * 60 * 1000,
    scopes: typeof data.scope === 'string' ? data.scope.split(' ').filter(Boolean) : [OAUTH.scope],
    subscriptionType: null,
    rateLimitTier: null,
    tokenAccount: {
      uuid: typeof account.uuid === 'string' ? account.uuid : null,
      emailAddress: typeof account.email_address === 'string' ? account.email_address : null,
      organizationUuid: typeof organization.uuid === 'string' ? organization.uuid : null,
    },
  };
}

function friendlyPlan(value) {
  if (typeof value !== 'string' || !value) return null;
  return value.replace(/^claude[_-]?/i, '').replace(/[_-]+/g, ' ').trim();
}

export async function fetchOAuthProfile(accessToken, { timeoutMs = 10000, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(OAUTH.profileUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Profile request failed with status ${response.status}`);
  const data = await readJsonResponse(response);
  const account = data.account && typeof data.account === 'object' ? data.account : {};
  const organization = data.organization && typeof data.organization === 'object' ? data.organization : {};
  return {
    emailAddress: typeof account.email === 'string' ? account.email : (typeof account.email_address === 'string' ? account.email_address : null),
    displayName: typeof account.display_name === 'string' ? account.display_name : null,
    subscriptionType: friendlyPlan(organization.organization_type ?? organization.subscription_type),
    rateLimitTier: typeof organization.rate_limit_tier === 'string' ? organization.rate_limit_tier : null,
  };
}

export async function revokeRefreshToken(refreshToken, { timeoutMs = 5000, fetchImpl = fetch } = {}) {
  if (!refreshToken) return false;
  try {
    const response = await fetchImpl(`${OAUTH.tokenUrl}/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        token: refreshToken,
        token_type_hint: 'refresh_token',
        client_id: OAUTH.clientId,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.arrayBuffer().catch(() => {});
    return response.ok;
  } catch {
    return false;
  }
}
