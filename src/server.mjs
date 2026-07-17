import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { APP_CONFIG } from './config.mjs';
import { runClaudePrompt } from './claude.mjs';
import {
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  fetchOAuthProfile,
  revokeRefreshToken,
} from './oauth.mjs';
import {
  PublicError,
  constantTimeEqual,
  createPkce,
  maskEmail,
  parseCookies,
  parseManualAuthorization,
  randomToken,
  redactSecrets,
  sessionCookie,
} from './security.mjs';

process.umask(0o077);

const STATIC_FILES = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/styles.css', { file: 'styles.css', type: 'text/css; charset=utf-8' }],
  ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
]);
const staticCache = new Map();
for (const [route, asset] of STATIC_FILES) {
  staticCache.set(route, { ...asset, body: await readFile(join(APP_CONFIG.publicDir, asset.file)) });
}

const sessions = new Map();
const allowedHosts = new Set([
  `127.0.0.1:${APP_CONFIG.port}`,
  `localhost:${APP_CONFIG.port}`,
  `[::1]:${APP_CONFIG.port}`,
]);
const allowedOrigins = new Set([...allowedHosts].map((host) => `http://${host}`));

function securityHeaders(res) {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
}

function sendJson(res, status, payload) {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`);
  securityHeaders(res);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', body.length);
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

function sendStatic(res, asset) {
  securityHeaders(res);
  res.statusCode = 200;
  res.setHeader('Content-Type', asset.type);
  res.setHeader('Content-Length', asset.body.length);
  res.setHeader('Cache-Control', 'no-store');
  res.end(asset.body);
}

function pruneSessions() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastSeen > APP_CONFIG.sessionTtlMs) {
      sessions.delete(id);
      void revokeRefreshToken(session.tokens?.refreshToken, { timeoutMs: APP_CONFIG.revokeTimeoutMs });
    }
  }
  if (sessions.size <= APP_CONFIG.maxSessions) return;
  const oldest = [...sessions.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
  while (sessions.size > APP_CONFIG.maxSessions && oldest.length) {
    const [id, session] = oldest.shift();
    sessions.delete(id);
    void revokeRefreshToken(session.tokens?.refreshToken, { timeoutMs: APP_CONFIG.revokeTimeoutMs });
  }
}

function createSession(res) {
  pruneSessions();
  const id = randomToken(32);
  const session = {
    id,
    csrf: randomToken(32),
    createdAt: Date.now(),
    lastSeen: Date.now(),
    oauth: null,
    tokens: null,
    profile: null,
    chatActive: false,
  };
  sessions.set(id, session);
  res.setHeader('Set-Cookie', sessionCookie(
    APP_CONFIG.sessionCookie,
    id,
    Math.floor(APP_CONFIG.sessionTtlMs / 1000),
  ));
  return session;
}

function getSession(req, res) {
  const id = parseCookies(req.headers.cookie)[APP_CONFIG.sessionCookie];
  const existing = typeof id === 'string' && /^[A-Za-z0-9_-]{40,64}$/.test(id)
    ? sessions.get(id)
    : null;
  if (!existing || Date.now() - existing.lastSeen > APP_CONFIG.sessionTtlMs) {
    if (existing) sessions.delete(existing.id);
    return createSession(res);
  }
  existing.lastSeen = Date.now();
  return existing;
}

function publicStatus(session) {
  const connected = Boolean(session.tokens?.accessToken);
  const pending = Boolean(session.oauth && session.oauth.expiresAt > Date.now());
  const email = session.profile?.emailAddress ?? session.tokens?.tokenAccount?.emailAddress ?? null;
  return {
    connected,
    phase: connected ? 'connected' : (pending ? 'authorize' : 'prepare'),
    csrfToken: session.csrf,
    authorizationPending: pending,
    authorizationExpiresAt: pending ? session.oauth.expiresAt : null,
    account: connected ? {
      emailMasked: maskEmail(email),
      plan: session.profile?.subscriptionType ?? session.tokens.subscriptionType ?? null,
      rateLimitTier: session.profile?.rateLimitTier ?? session.tokens.rateLimitTier ?? null,
    } : null,
    credentials: connected ? {
      accessExpiresAt: session.tokens.expiresAt,
      refreshExpiresAt: session.tokens.refreshTokenExpiresAt,
      scopes: session.tokens.scopes,
      storage: 'ephemeral server memory',
    } : null,
    server: {
      localhostOnly: true,
      bindAddress: APP_CONFIG.host,
      tokenPersistence: false,
    },
  };
}

function assertLocalHost(req) {
  const host = String(req.headers.host ?? '').toLowerCase();
  if (!allowedHosts.has(host)) {
    throw new PublicError(421, 'HOST_NOT_ALLOWED', 'Use the documented localhost SSH tunnel to access this demo.');
  }
}

function assertMutation(req, session) {
  const origin = String(req.headers.origin ?? '').toLowerCase();
  if (!allowedOrigins.has(origin)) {
    throw new PublicError(403, 'ORIGIN_REJECTED', 'This request did not come from the local demo origin.');
  }
  const csrf = req.headers['x-csrf-token'];
  if (typeof csrf !== 'string' || !constantTimeEqual(csrf, session.csrf)) {
    throw new PublicError(403, 'CSRF_REJECTED', 'The browser session changed. Refresh the page and retry.');
  }
  const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    throw new PublicError(415, 'JSON_REQUIRED', 'This endpoint accepts JSON only.');
  }
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > APP_CONFIG.maxJsonBytes) {
      req.resume();
      throw new PublicError(413, 'BODY_TOO_LARGE', 'The request is larger than this demo allows.');
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new PublicError(400, 'JSON_INVALID', 'The request body is not valid JSON.');
  }
}

async function handleApi(req, res, pathname) {
  if (pathname === '/api/health' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, localhostOnly: true });
    return;
  }

  const session = getSession(req, res);
  if (pathname === '/api/auth/status' && req.method === 'GET') {
    sendJson(res, 200, publicStatus(session));
    return;
  }

  if (req.method !== 'POST') {
    throw new PublicError(405, 'METHOD_NOT_ALLOWED', 'That method is not available.');
  }
  assertMutation(req, session);

  if (pathname === '/api/auth/start') {
    if (session.tokens) {
      throw new PublicError(409, 'ALREADY_CONNECTED', 'Disconnect the current test session before starting another.');
    }
    const { verifier, challenge } = createPkce();
    const state = randomToken(32);
    session.oauth = {
      verifier,
      challenge,
      state,
      createdAt: Date.now(),
      expiresAt: Date.now() + APP_CONFIG.oauthTtlMs,
    };
    sendJson(res, 200, {
      authorizationUrl: buildAuthorizationUrl({ challenge, state }),
      expiresAt: session.oauth.expiresAt,
      status: publicStatus(session),
    });
    return;
  }

  if (pathname === '/api/auth/complete') {
    const body = await readJson(req);
    const transaction = session.oauth;
    session.oauth = null;
    if (!transaction || transaction.expiresAt <= Date.now()) {
      throw new PublicError(409, 'AUTH_ATTEMPT_EXPIRED', 'This sign-in attempt expired. Prepare a new authorization.');
    }
    const code = parseManualAuthorization(
      body.authorizationCode,
      transaction.state,
      APP_CONFIG.maxAuthorizationCodeChars,
    );
    const tokens = await exchangeAuthorizationCode({
      code,
      verifier: transaction.verifier,
      state: transaction.state,
      timeoutMs: APP_CONFIG.oauthTimeoutMs,
    });
    let profile = null;
    try {
      profile = await fetchOAuthProfile(tokens.accessToken, { timeoutMs: APP_CONFIG.profileTimeoutMs });
    } catch {}
    if (profile?.subscriptionType) tokens.subscriptionType = profile.subscriptionType;
    if (profile?.rateLimitTier) tokens.rateLimitTier = profile.rateLimitTier;
    session.tokens = tokens;
    session.profile = profile;
    sendJson(res, 200, { status: publicStatus(session) });
    return;
  }

  if (pathname === '/api/chat') {
    const body = await readJson(req);
    if (!session.tokens?.accessToken) {
      throw new PublicError(401, 'NOT_CONNECTED', 'Connect the separate test Claude account before sending a prompt.');
    }
    if (session.chatActive) {
      throw new PublicError(409, 'CHAT_BUSY', 'A prompt is already running for this browser session.');
    }
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt || prompt.length > APP_CONFIG.maxPromptChars) {
      throw new PublicError(400, 'PROMPT_INVALID', `Enter a prompt from 1 to ${APP_CONFIG.maxPromptChars} characters.`);
    }

    session.chatActive = true;
    try {
      const { response, updatedTokens } = await runClaudePrompt({
        tokens: session.tokens,
        prompt,
        binary: APP_CONFIG.claudeBinary,
        timeoutMs: APP_CONFIG.claudeTimeoutMs,
        maxOutputBytes: APP_CONFIG.maxClaudeOutputBytes,
      });
      session.tokens = updatedTokens;
      session.lastSeen = Date.now();
      sendJson(res, 200, { response, status: publicStatus(session) });
    } finally {
      session.chatActive = false;
    }
    return;
  }

  if (pathname === '/api/auth/disconnect') {
    await readJson(req);
    if (session.chatActive) {
      throw new PublicError(409, 'CHAT_BUSY', 'Wait for the active prompt to finish before disconnecting.');
    }
    const refreshToken = session.tokens?.refreshToken ?? null;
    session.oauth = null;
    session.tokens = null;
    session.profile = null;
    await revokeRefreshToken(refreshToken, { timeoutMs: APP_CONFIG.revokeTimeoutMs });
    sendJson(res, 200, { status: publicStatus(session) });
    return;
  }

  throw new PublicError(404, 'NOT_FOUND', 'That endpoint does not exist.');
}

const server = http.createServer(async (req, res) => {
  const startedAt = performance.now();
  const requestId = randomToken(9);
  let pathname = '/';
  res.setHeader('X-Request-ID', requestId);
  res.on('finish', () => {
    console.log(JSON.stringify({
      time: new Date().toISOString(),
      requestId,
      method: req.method,
      path: pathname,
      status: res.statusCode,
      durationMs: Math.round(performance.now() - startedAt),
    }));
  });

  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    pathname = url.pathname;
    assertLocalHost(req);

    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname);
      return;
    }
    if (pathname === '/favicon.ico') {
      securityHeaders(res);
      res.statusCode = 204;
      res.end();
      return;
    }
    const asset = staticCache.get(pathname);
    if (req.method === 'GET' && asset) {
      if (pathname === '/') getSession(req, res);
      sendStatic(res, asset);
      return;
    }
    throw new PublicError(404, 'NOT_FOUND', 'That page does not exist.');
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : 500;
    const code = typeof error?.code === 'string' ? error.code : 'INTERNAL_ERROR';
    const message = error instanceof PublicError
      ? error.publicMessage
      : 'The demo encountered an unexpected server error.';
    if (status >= 500) {
      console.error(JSON.stringify({
        time: new Date().toISOString(),
        level: 'error',
        requestId,
        code,
        message: redactSecrets(error?.message),
      }));
    }
    if (!res.headersSent) sendJson(res, status, { error: { code, message, requestId } });
    else res.destroy();
  }
});

server.headersTimeout = 10000;
server.requestTimeout = APP_CONFIG.claudeTimeoutMs + 15000;
server.keepAliveTimeout = 5000;
server.maxRequestsPerSocket = 100;
server.on('clientError', (_error, socket) => {
  socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
});

const cleanupTimer = setInterval(pruneSessions, 5 * 60 * 1000);
cleanupTimer.unref();

server.listen(APP_CONFIG.port, APP_CONFIG.host, () => {
  console.log(`Claude Session Lab listening on http://${APP_CONFIG.host}:${APP_CONFIG.port}`);
  console.log('Localhost-only mode; use an SSH tunnel. Tokens are not persisted.');
});

function shutdown(signal) {
  console.log(`Received ${signal}; closing localhost server.`);
  clearInterval(cleanupTimer);
  sessions.clear();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
