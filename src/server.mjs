import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { APP_CONFIG } from './config.mjs';
import { buildUserLine, runClaudePrompt } from './claude.mjs';
import { createGateway } from './gateway.mjs';
import { openKeystore, parseMasterKey } from './keystore.mjs';
import {
  anthropicErrorBody,
  createResultCollector,
  errorTypeForStatus,
  parseMessagesRequest,
  sseChunk,
} from './messages.mjs';
import {
  fromAnthropicMessage,
  createStreamAdapter,
  modelsList,
  openaiErrorBody,
  toAnthropicBody,
} from './openai.mjs';
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

const ADVERTISED_MODELS = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'];

const sessions = new Map();
const allowedHosts = new Set([
  `127.0.0.1:${APP_CONFIG.port}`,
  `localhost:${APP_CONFIG.port}`,
  `[::1]:${APP_CONFIG.port}`,
]);
const allowedOrigins = new Set([...allowedHosts].map((host) => `http://${host}`));

let keystore = null;
let gateway = null;
if (APP_CONFIG.gateway.enabled) {
  keystore = await openKeystore({
    file: APP_CONFIG.keystoreFile,
    masterKey: parseMasterKey(APP_CONFIG.gateway.masterKey),
  });
  gateway = createGateway({ keystore, config: APP_CONFIG });
}

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

function applyCors(req, res) {
  const origin = req.headers.origin;
  const allowed = APP_CONFIG.gateway.corsOrigins;
  if (!allowed.length || typeof origin !== 'string') return;
  if (!allowed.includes(origin) && !allowed.includes('*')) return;
  res.setHeader('Access-Control-Allow-Origin', allowed.includes('*') ? '*' : origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, x-api-key, content-type, anthropic-version, anthropic-beta');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '600');
}

function pruneSessions() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastSeen > APP_CONFIG.sessionTtlMs) {
      sessions.delete(id);
      if (!session.linked) {
        void revokeRefreshToken(session.tokens?.refreshToken, { timeoutMs: APP_CONFIG.revokeTimeoutMs });
      }
    }
  }
  if (sessions.size <= APP_CONFIG.maxSessions) return;
  const oldest = [...sessions.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
  while (sessions.size > APP_CONFIG.maxSessions && oldest.length) {
    const [id, session] = oldest.shift();
    sessions.delete(id);
    if (!session.linked) {
      void revokeRefreshToken(session.tokens?.refreshToken, { timeoutMs: APP_CONFIG.revokeTimeoutMs });
    }
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
    linked: false,
    connectionId: null,
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
      storage: session.linked ? 'encrypted keystore on disk' : 'ephemeral server memory',
    } : null,
    gateway: {
      enabled: APP_CONFIG.gateway.enabled,
      connections: keystore ? keystore.listConnections() : [],
      linked: session.linked,
      limits: {
        rateLimitPerMinute: APP_CONFIG.gateway.rateLimitPerMinute,
        queueLimit: APP_CONFIG.gateway.queueLimit,
        maxImages: APP_CONFIG.gateway.maxImages,
      },
    },
    server: {
      localhostOnly: APP_CONFIG.host === '127.0.0.1',
      bindAddress: APP_CONFIG.host,
      tokenPersistence: APP_CONFIG.gateway.enabled,
    },
  };
}

function assertLocalHost(req) {
  const host = String(req.headers.host ?? '').toLowerCase();
  if (!allowedHosts.has(host)) {
    throw new PublicError(421, 'HOST_NOT_ALLOWED', 'Use the documented localhost SSH tunnel to reach the admin UI.');
  }
}

function assertMutation(req, session) {
  const origin = String(req.headers.origin ?? '').toLowerCase();
  if (!allowedOrigins.has(origin)) {
    throw new PublicError(403, 'ORIGIN_REJECTED', 'This request did not come from the local admin origin.');
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

async function readJson(req, maxBytes = APP_CONFIG.maxJsonBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      req.resume();
      throw new PublicError(413, 'BODY_TOO_LARGE', 'The request is larger than this gateway allows.');
    }
    chunks.push(chunk);
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new PublicError(400, 'JSON_INVALID', 'The request body is not valid JSON.');
  }
  // `null`, `[]` and bare scalars parse fine but every endpoint here reads named fields off
  // an object, so rejecting them once is what keeps callers from crashing on a property read.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PublicError(400, 'JSON_INVALID', 'The request body must be a JSON object.');
  }
  return parsed;
}

function requireGateway() {
  if (!gateway || !keystore) {
    throw new PublicError(503, 'GATEWAY_DISABLED', 'Gateway mode is off. Start the server with SESSION_LAB_GATEWAY=1 and a master key.');
  }
}

function gatewayLimits() {
  return {
    maxPromptChars: APP_CONFIG.gateway.maxPromptChars,
    maxImages: APP_CONFIG.gateway.maxImages,
    maxImageBytes: APP_CONFIG.gateway.maxImageBytes,
    maxMessages: APP_CONFIG.gateway.maxMessages,
    defaultMaxTokens: APP_CONFIG.gateway.defaultMaxTokens,
  };
}

function rateLimitHeaders(res, rateLimit) {
  if (!rateLimit || typeof rateLimit !== 'object') return;
  if (typeof rateLimit.status === 'string') res.setHeader('X-Claude-Ratelimit-Status', rateLimit.status);
  if (Number.isFinite(rateLimit.resetsAt)) res.setHeader('X-Claude-Ratelimit-Resets-At', String(rateLimit.resetsAt));
  if (typeof rateLimit.rateLimitType === 'string') res.setHeader('X-Claude-Ratelimit-Window', rateLimit.rateLimitType);
}

function startSse(res) {
  securityHeaders(res);
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
}

// A caller that hangs up should stop burning subscription quota and release the per-account
// lock instead of running a full turn nobody will read.
function abortOnDisconnect(req, res) {
  const controller = new AbortController();
  const onAborted = () => controller.abort();
  req.once('aborted', onAborted);
  res.once('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  return controller;
}

// Streaming responses commit their 200 only once the first event exists, so an
// authentication or upstream failure can still be reported as a real HTTP status.
async function runStreaming(req, res, { record, parsed, requestId, wire }) {
  const controller = abortOnDisconnect(req, res);
  let started = false;
  const emit = (event, data) => {
    if (!started) {
      startSse(res);
      started = true;
    }
    if (!res.writableEnded) res.write(wire.chunk(event, data));
  };

  try {
    const outcome = await gateway.run({ record, parsed, requestId, signal: controller.signal, emit: wire.passthrough ? emit : null });
    if (outcome.aborted) {
      if (!res.writableEnded) res.end();
      return;
    }
    if (!wire.passthrough) {
      for (const { event, data } of wire.synthesize(outcome.message)) emit(event, data);
    } else if (!started) {
      for (const { event, data } of wire.fallback(outcome.message)) emit(event, data);
    }
    if (wire.terminator) res.write(wire.terminator);
    res.end();
  } catch (error) {
    if (!started) throw error;
    const status = Number.isInteger(error?.status) ? error.status : 500;
    const message = error instanceof PublicError ? error.publicMessage : 'The gateway encountered an unexpected error.';
    if (!res.writableEnded) {
      res.write(wire.errorChunk(status, message));
      res.end();
    }
  }
}

const ANTHROPIC_WIRE = {
  passthrough: true,
  chunk: (event, data) => sseChunk(event, data),
  errorChunk: (status, message) => sseChunk('error', anthropicErrorBody(errorTypeForStatus(status), message)),
  terminator: null,
  fallback: (message) => {
    if (!message) return [];
    const text = (message.content ?? [])
      .filter((block) => block?.type === 'text')
      .map((block) => block.text)
      .join('');
    return [
      { event: 'message_start', data: { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { ...message.usage, output_tokens: 0 } } } },
      { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: message.usage?.output_tokens ?? 0 } } },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ];
  },
};

function openaiWire({ requestedModel, id, created }) {
  return {
    passthrough: false,
    chunk: (_event, data) => `data: ${JSON.stringify(data)}\n\n`,
    errorChunk: (status, message) => `data: ${JSON.stringify(openaiErrorBody(status, message, 'gateway_error'))}\n\n`,
    terminator: 'data: [DONE]\n\n',
    // The adapter is built here, not up front, so the chunks can report the model the
    // sandbox actually served rather than the alias the caller sent.
    synthesize: (message) => {
      const adapter = createStreamAdapter({ id, model: message?.model || requestedModel, created });
      const text = (message?.content ?? [])
        .filter((block) => block?.type === 'text')
        .map((block) => block.text)
        .join('');
      return [
        { event: 'chunk', data: adapter.first() },
        { event: 'chunk', data: adapter.delta(text) },
        { event: 'chunk', data: adapter.last(message?.stop_reason ?? 'end_turn') },
      ];
    },
    fallback: () => [],
  };
}

async function handleGatewayApi(req, res, pathname, requestId) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') {
    securityHeaders(res);
    res.statusCode = 204;
    res.end();
    return;
  }

  requireGateway();

  if (pathname === '/v1/models' && req.method === 'GET') {
    gateway.authenticate(req);
    sendJson(res, 200, modelsList(ADVERTISED_MODELS, {}));
    return;
  }

  if (req.method !== 'POST') {
    throw new PublicError(405, 'METHOD_NOT_ALLOWED', 'That method is not available on this endpoint.');
  }

  const record = gateway.authenticate(req);
  const raw = await readJson(req, APP_CONFIG.gateway.maxBodyBytes);

  if (pathname === '/v1/messages') {
    const parsed = parseMessagesRequest(raw, gatewayLimits());
    if (parsed.stream) {
      await runStreaming(req, res, { record, parsed, requestId, wire: ANTHROPIC_WIRE });
      return;
    }
    const outcome = await gateway.run({
      record,
      parsed,
      requestId,
      signal: abortOnDisconnect(req, res).signal,
    });
    if (outcome.aborted) return;
    rateLimitHeaders(res, outcome.rateLimit);
    sendJson(res, 200, outcome.message);
    return;
  }

  if (pathname === '/v1/chat/completions') {
    const parsed = parseMessagesRequest(toAnthropicBody(raw), gatewayLimits());
    const created = Math.floor(Date.now() / 1000);
    const id = randomToken(12);
    if (parsed.stream) {
      await runStreaming(req, res, {
        record,
        parsed,
        requestId,
        wire: openaiWire({ requestedModel: parsed.model, id, created }),
      });
      return;
    }
    const outcome = await gateway.run({
      record,
      parsed,
      requestId,
      signal: abortOnDisconnect(req, res).signal,
    });
    if (outcome.aborted) return;
    rateLimitHeaders(res, outcome.rateLimit);
    sendJson(res, 200, fromAnthropicMessage(outcome.message, {
      model: outcome.message?.model || parsed.model,
      id,
      created,
    }));
    return;
  }

  throw new PublicError(404, 'NOT_FOUND', 'That endpoint does not exist.');
}

async function handleKeysApi(req, res, pathname, session) {
  requireGateway();
  assertMutation(req, session);
  const body = await readJson(req);

  if (pathname === '/api/keys/create') {
    if (!session.tokens?.accessToken) {
      throw new PublicError(401, 'NOT_CONNECTED', 'Connect a Claude account before issuing a gateway key.');
    }
    if (session.linked) {
      throw new PublicError(409, 'ALREADY_LINKED', 'This browser session already issued a key. Disconnect first to link another account.');
    }
    if (keystore.size >= APP_CONFIG.gateway.maxConnections) {
      throw new PublicError(409, 'CONNECTION_LIMIT', 'The keystore is full. Revoke an unused key first.');
    }
    const { connection, apiKey } = await keystore.createConnection({
      label: typeof body.label === 'string' ? body.label : 'default',
      tokens: session.tokens,
      profile: session.profile,
    });
    session.connectionId = connection.id;
    // Ownership of the refresh token moves to the keystore; the browser session must not
    // revoke it on disconnect any more.
    session.linked = true;
    sendJson(res, 201, { apiKey, connection, status: publicStatus(session) });
    return;
  }

  if (pathname === '/api/keys/revoke') {
    const id = typeof body.id === 'string' ? body.id : '';
    if (!id) throw new PublicError(400, 'ID_REQUIRED', 'Provide the connection id to revoke.');
    const refreshToken = await keystore.revoke(id);
    await revokeRefreshToken(refreshToken, { timeoutMs: APP_CONFIG.revokeTimeoutMs });
    sendJson(res, 200, { status: publicStatus(session) });
    return;
  }

  throw new PublicError(404, 'NOT_FOUND', 'That endpoint does not exist.');
}

async function handleApi(req, res, pathname) {
  if (pathname === '/api/health' && req.method === 'GET') {
    sendJson(res, 200, {
      ok: true,
      gateway: APP_CONFIG.gateway.enabled,
      connections: keystore ? keystore.size : 0,
    });
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

  if (pathname.startsWith('/api/keys/')) {
    await handleKeysApi(req, res, pathname, session);
    return;
  }

  assertMutation(req, session);

  if (pathname === '/api/auth/start') {
    if (session.tokens) {
      throw new PublicError(409, 'ALREADY_CONNECTED', 'Disconnect the current account before starting another.');
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
    session.linked = false;
    session.connectionId = null;
    sendJson(res, 200, { status: publicStatus(session) });
    return;
  }

  if (pathname === '/api/chat') {
    const body = await readJson(req);
    if (!session.tokens?.accessToken) {
      throw new PublicError(401, 'NOT_CONNECTED', 'Connect a Claude account before sending a prompt.');
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
      // Once the account is linked, the keystore owns its tokens. Running this prompt from the
      // session's own copy would race a concurrent /v1 request: both would refresh, and the
      // second rotation would invalidate the first. So a linked session shares the same lock.
      if (session.connectionId && gateway) {
        const outcome = await gateway.run({
          record: { id: session.connectionId },
          parsed: {
            cliInputLine: buildUserLine(prompt),
            model: 'sonnet',
            systemPrompt: null,
            maxTokens: APP_CONFIG.gateway.defaultMaxTokens,
            includeThinking: false,
          },
          requestId: 'admin-chat',
        });
        const message = outcome.message;
        const text = (message?.content ?? [])
          .filter((block) => block?.type === 'text')
          .map((block) => block.text)
          .join('');
        session.lastSeen = Date.now();
        sendJson(res, 200, {
          response: {
            text,
            model: message?.model ?? null,
            durationMs: null,
            inputTokens: outcome.usage?.inputTokens ?? null,
            outputTokens: outcome.usage?.outputTokens ?? null,
          },
          status: publicStatus(session),
        });
        return;
      }

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
    // A linked account keeps serving API traffic from the keystore, so its refresh token
    // must survive the browser session ending.
    const refreshToken = session.linked ? null : (session.tokens?.refreshToken ?? null);
    session.oauth = null;
    session.tokens = null;
    session.profile = null;
    session.linked = false;
    session.connectionId = null;
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
  let isGatewayRoute = false;
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
    isGatewayRoute = pathname === '/v1' || pathname.startsWith('/v1/');

    if (isGatewayRoute) {
      await handleGatewayApi(req, res, pathname, requestId);
      return;
    }

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
      : 'The server encountered an unexpected error.';
    if (status >= 500) {
      console.error(JSON.stringify({
        time: new Date().toISOString(),
        level: 'error',
        requestId,
        code,
        message: redactSecrets(error?.message),
      }));
    }
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (Number.isInteger(error?.retryAfter)) res.setHeader('Retry-After', String(error.retryAfter));
    if (isGatewayRoute) {
      const body = pathname === '/v1/chat/completions'
        ? openaiErrorBody(status, message, code)
        : anthropicErrorBody(errorTypeForStatus(status), message);
      sendJson(res, status, body);
      return;
    }
    sendJson(res, status, { error: { code, message, requestId } });
  }
});

server.headersTimeout = 10000;
server.requestTimeout = APP_CONFIG.gateway.requestTimeoutMs + 15000;
server.keepAliveTimeout = 5000;
server.maxRequestsPerSocket = 0;
server.on('clientError', (_error, socket) => {
  socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
});

const cleanupTimer = setInterval(pruneSessions, 5 * 60 * 1000);
cleanupTimer.unref();

server.listen(APP_CONFIG.port, APP_CONFIG.host, () => {
  console.log(`Claude Session Lab listening on http://${APP_CONFIG.host}:${APP_CONFIG.port}`);
  if (APP_CONFIG.gateway.enabled) {
    console.log(`Gateway mode on: ${keystore.size} linked account(s); admin UI stays localhost-only.`);
  } else {
    console.log('Lab mode: localhost only, tokens are not persisted, /v1 is disabled.');
  }
});

function shutdown(signal) {
  console.log(`Received ${signal}; closing server.`);
  clearInterval(cleanupTimer);
  sessions.clear();
  const done = keystore ? keystore.close().catch(() => {}) : Promise.resolve();
  void done.then(() => server.close(() => process.exit(0)));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

export { server };
